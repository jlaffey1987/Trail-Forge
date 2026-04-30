import { describe, it, beforeEach, afterEach, vi, expect } from "vitest";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import React from "react";
import type { Trail } from "@/lib/supabase";
import type { TrailCluster } from "@/lib/trailLayer";

// ---------------------------------------------------------------------------
// Module mocks. We keep `clusterTrails` real (so the actual grid-bucket logic
// runs) but spy on the *call sites* in PlannerMap, and stub `renderTrailLayer`
// / `renderTrailClusters` so they don't try to drive the real Leaflet API.
// `vi.importActual` keeps `CLUSTER_ZOOM_THRESHOLD`, `getTrailBbox`, etc. from
// the real module — that way the test exercises the same threshold value the
// production code uses, and a future change to it would surface here.
// ---------------------------------------------------------------------------

const layerSpies = vi.hoisted(() => ({
  clusterTrails: vi.fn(),
  renderTrailClusters: vi.fn(),
  renderTrailLayer: vi.fn(),
}));

vi.mock("@/lib/trailLayer", async () => {
  const actual = await vi.importActual<typeof import("@/lib/trailLayer")>(
    "@/lib/trailLayer",
  );
  return {
    ...actual,
    clusterTrails: (...args: Parameters<typeof actual.clusterTrails>) => {
      layerSpies.clusterTrails(...args);
      return actual.clusterTrails(...args);
    },
    renderTrailClusters: (
      ...args: Parameters<typeof actual.renderTrailClusters>
    ) => {
      layerSpies.renderTrailClusters(...args);
      return { layers: [], clear: () => {} };
    },
    renderTrailLayer: (
      ...args: Parameters<typeof actual.renderTrailLayer>
    ) => {
      layerSpies.renderTrailLayer(...args);
      return { layers: [], bounds: [], clear: () => {} };
    },
  };
});

// POI search lib pulls Overpass over the network. Stub it out — these tests
// never toggle the POI buttons but the toggle handler is created on mount.
vi.mock("@/lib/poi", () => ({
  searchPoisInBbox: vi.fn().mockResolvedValue({ status: "ok", pois: [] }),
  searchPoisAlongRoute: vi.fn().mockResolvedValue({ status: "ok", pois: [] }),
}));

// ---------------------------------------------------------------------------
// Minimal `window.L` stub. Just enough surface for PlannerMap's init,
// markers and trail-render effects to run without throwing. The map's
// `getZoom` is fixed at construction so we can drive the cluster vs polyline
// branch deterministically.
// ---------------------------------------------------------------------------

interface LeafletStub {
  L: typeof window.L;
  map: ReturnType<typeof window.L.map>;
  fitBoundsCalls: unknown[][];
  setViewCalls: unknown[][];
}

function makeLeafletStub(initialZoom: number): LeafletStub {
  const fitBoundsCalls: unknown[][] = [];
  const setViewCalls: unknown[][] = [];
  const zoomendListeners = new Set<() => void>();
  let currentZoom = initialZoom;

  const map = {
    on: (evt: string, cb: () => void) => {
      if (evt === "zoomend") zoomendListeners.add(cb);
      return map;
    },
    off: (evt: string, cb: () => void) => {
      if (evt === "zoomend") zoomendListeners.delete(cb);
    },
    remove: () => {},
    invalidateSize: () => {},
    getZoom: () => currentZoom,
    getBounds: () => ({
      getSouth: () => 0,
      getNorth: () => 1,
      getWest: () => 0,
      getEast: () => 1,
    }),
    fitBounds: (...args: unknown[]) => {
      fitBoundsCalls.push(args);
    },
    setView: (...args: unknown[]) => {
      setViewCalls.push(args);
    },
    // Test-only — lets a future test simulate a zoom change.
    __setZoom: (z: number) => {
      currentZoom = z;
      zoomendListeners.forEach((cb) => cb());
    },
  };

  const tileLayer = () => ({ addTo: () => ({}) });
  const marker = () => {
    const m: Record<string, unknown> = {};
    m.addTo = () => m;
    m.bindPopup = () => m;
    m.on = () => m;
    m.remove = () => {};
    m.options = {};
    return m as unknown as ReturnType<typeof window.L.marker>;
  };
  const polyline = () => {
    const p: Record<string, unknown> = {};
    p.addTo = () => p;
    p.remove = () => {};
    p.on = () => p;
    p.setStyle = () => {};
    return p as unknown as ReturnType<typeof window.L.polyline>;
  };
  const divIcon = (opts: unknown) => opts;
  const latLngBounds = (a: [number, number], b: [number, number]) => ({
    __bounds: [a, b],
  });

  const L = {
    map: () => map,
    tileLayer,
    marker,
    polyline,
    divIcon,
    latLngBounds,
  } as unknown as typeof window.L;

  return {
    L,
    map: map as unknown as ReturnType<typeof window.L.map>,
    fitBoundsCalls,
    setViewCalls,
  };
}

function makeTrail(
  id: string,
  centerLat: number,
  centerLng: number,
  difficulty: number | null = 4,
): Trail {
  return {
    id,
    user_id: null,
    name: `Trail ${id}`,
    type: null,
    difficulty,
    distance_km: 5,
    terrain: null,
    legal_status: null,
    is_public: true,
    created_at: "2026-01-01T00:00:00Z",
    verification_status: "verified",
    // PlannerMap → trailLayer → getTrailLatLngs prefers `path_geojson` over
    // parsing `gpx_data`, so this is enough to give every trail a usable
    // bbox without shipping XML through the test.
    path_geojson: {
      type: "LineString",
      coordinates: [
        [centerLng - 0.005, centerLat - 0.005],
        [centerLng + 0.005, centerLat + 0.005],
      ],
    },
    shared_groups: [],
  } as unknown as Trail;
}

// Two trails far enough apart to land in distinct cluster cells at zoom 6
// (cell size 2°). One "selected" trail far north so it sits in a third cell.
const TRAIL_A = makeTrail("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", 53.5, -2.5);
const TRAIL_B = makeTrail("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", 60.0, 5.0);
const TRAIL_SELECTED = makeTrail(
  "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  45.0,
  10.0,
);

let leaflet: LeafletStub;

beforeEach(() => {
  layerSpies.clusterTrails.mockClear();
  layerSpies.renderTrailClusters.mockClear();
  layerSpies.renderTrailLayer.mockClear();
  leaflet = makeLeafletStub(6);
  (window as unknown as { L: unknown }).L = leaflet.L;
});

afterEach(() => {
  cleanup();
  delete (window as unknown as { L?: unknown }).L;
});

describe("PlannerMap — cluster vs polyline rendering", () => {
  it(
    "below the cluster zoom threshold, only unselected trails are clustered and selected trails render as polylines on top",
    async () => {
      const { default: PlannerMap } = await import("@/components/PlannerMap");

      render(
        <PlannerMap
          start={null}
          end={null}
          trails={[TRAIL_A, TRAIL_B, TRAIL_SELECTED]}
          selectedIds={new Set([TRAIL_SELECTED.id])}
          onToggle={() => {}}
        />,
      );

      await waitFor(() =>
        expect(layerSpies.clusterTrails).toHaveBeenCalled(),
      );

      // clusterTrails must be called with ONLY the unselected trails. If a
      // future refactor flips the filter direction we'd start seeing the
      // selected trail in the clustered set, which would silently break the
      // "in-progress route is always visible" UX.
      const lastClusterCall =
        layerSpies.clusterTrails.mock.calls[
          layerSpies.clusterTrails.mock.calls.length - 1
        ];
      const clusteredTrails = lastClusterCall[0] as Trail[];
      const clusteredIds = clusteredTrails.map((t) => t.id).sort();
      expect(clusteredIds).toEqual([TRAIL_A.id, TRAIL_B.id].sort());
      expect(clusteredIds).not.toContain(TRAIL_SELECTED.id);

      // The zoom passed through must be the current map zoom — same value the
      // cell-size lookup uses. Catches regressions where currentZoom is read
      // from a stale source.
      expect(lastClusterCall[1]).toBe(6);

      // Selected trails must still be drawn — this is what keeps the rider's
      // route visible at low zoom while every other trail is collapsed into a
      // cluster marker.
      expect(layerSpies.renderTrailLayer).toHaveBeenCalledTimes(1);
      const polyArgs = layerSpies.renderTrailLayer.mock.calls[0];
      const polylineTrails = polyArgs[1] as Trail[];
      expect(polylineTrails.map((t) => t.id)).toEqual([TRAIL_SELECTED.id]);

      // And the cluster layer must have actually been built.
      expect(layerSpies.renderTrailClusters).toHaveBeenCalledTimes(1);
    },
  );

  it("at or above the cluster zoom threshold, every trail (including selected) renders as a polyline and clustering is skipped", async () => {
    // Re-stub with an initial zoom past the threshold so the trail-render
    // effect takes the polyline branch instead of the cluster branch.
    leaflet = makeLeafletStub(12);
    (window as unknown as { L: unknown }).L = leaflet.L;

    const { default: PlannerMap } = await import("@/components/PlannerMap");

    render(
      <PlannerMap
        start={null}
        end={null}
        trails={[TRAIL_A, TRAIL_B, TRAIL_SELECTED]}
        selectedIds={new Set([TRAIL_SELECTED.id])}
        onToggle={() => {}}
      />,
    );

    await waitFor(() =>
      expect(layerSpies.renderTrailLayer).toHaveBeenCalled(),
    );

    expect(layerSpies.clusterTrails).not.toHaveBeenCalled();
    expect(layerSpies.renderTrailClusters).not.toHaveBeenCalled();

    // Single renderTrailLayer call covering all three trails.
    expect(layerSpies.renderTrailLayer).toHaveBeenCalledTimes(1);
    const polyArgs = layerSpies.renderTrailLayer.mock.calls[0];
    const renderedTrails = polyArgs[1] as Trail[];
    expect(renderedTrails.map((t) => t.id).sort()).toEqual(
      [TRAIL_A.id, TRAIL_B.id, TRAIL_SELECTED.id].sort(),
    );
  });

  it("at exactly CLUSTER_ZOOM_THRESHOLD the polyline branch is taken (boundary is `< threshold`, not `<= threshold`)", async () => {
    // Pin the boundary explicitly: a future change from `<` to `<=` would
    // suddenly cluster at the threshold zoom, which would surprise the rider
    // (the legend hint disappears at the same zoom). Keeping a dedicated
    // assertion here makes that swap impossible to land silently.
    const { CLUSTER_ZOOM_THRESHOLD } = await import("@/lib/trailLayer");
    leaflet = makeLeafletStub(CLUSTER_ZOOM_THRESHOLD);
    (window as unknown as { L: unknown }).L = leaflet.L;

    const { default: PlannerMap } = await import("@/components/PlannerMap");

    render(
      <PlannerMap
        start={null}
        end={null}
        trails={[TRAIL_A, TRAIL_B]}
        selectedIds={new Set()}
        onToggle={() => {}}
      />,
    );

    await waitFor(() =>
      expect(layerSpies.renderTrailLayer).toHaveBeenCalled(),
    );

    expect(layerSpies.clusterTrails).not.toHaveBeenCalled();
    expect(layerSpies.renderTrailClusters).not.toHaveBeenCalled();
  });

  it(
    "tapping a single-trail cluster fits the map to the cluster's bbox, not to the full trail set",
    async () => {
      const { default: PlannerMap } = await import("@/components/PlannerMap");

      render(
        <PlannerMap
          start={null}
          end={null}
          trails={[TRAIL_A, TRAIL_B]}
          selectedIds={new Set()}
          onToggle={() => {}}
        />,
      );

      await waitFor(() =>
        expect(layerSpies.renderTrailClusters).toHaveBeenCalled(),
      );

      const renderArgs = layerSpies.renderTrailClusters.mock.calls[0];
      const passedClusters = renderArgs[1] as TrailCluster[];
      const opts = renderArgs[2] as {
        onClusterClick?: (c: TrailCluster) => void;
      };

      // Two trails, far apart, become two single-trail clusters at zoom 6.
      // Take the first single-trail cluster — the click handler should drill
      // into THAT cluster's bbox alone, not the union of every trail in the
      // result set.
      const single = passedClusters.find((c) => c.count === 1);
      expect(single).toBeDefined();
      expect(typeof opts.onClusterClick).toBe("function");

      // Initial render fires a fitBounds for the full trail set (the
      // start/end markers effect). Clear that history before exercising the
      // cluster click so the assertions below only see the click's effect.
      leaflet.fitBoundsCalls.length = 0;

      act(() => {
        opts.onClusterClick!(single!);
      });

      // Exactly one fitBounds call, against this cluster's bbox corners —
      // not against any larger region. The maxZoom: 14 cap is the planner's
      // contract: drilling never overshoots the level where individual
      // polylines re-appear.
      expect(leaflet.fitBoundsCalls).toHaveLength(1);
      const [boundsArg, fitOpts] = leaflet.fitBoundsCalls[0] as [
        { __bounds: [[number, number], [number, number]] },
        { padding: [number, number]; maxZoom: number },
      ];
      expect(boundsArg.__bounds).toEqual([
        [single!.bbox.minLat, single!.bbox.minLng],
        [single!.bbox.maxLat, single!.bbox.maxLng],
      ]);
      expect(fitOpts.maxZoom).toBe(14);

      // No setView fallback — the bounds path is the only one we want.
      expect(leaflet.setViewCalls).toHaveLength(0);
    },
  );
});
