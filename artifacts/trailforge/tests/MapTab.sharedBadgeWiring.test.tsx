import { describe, it, beforeEach, afterEach, vi, expect } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import React from "react";
import type { Trail } from "@/lib/supabase";
import type { RenderTrailLayerOptions } from "@/lib/trailLayer";

const VIEWER_ID = "user_map_badge_viewer";
const TRAIL_ID = "maptab-1111-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const GROUP_ALPHA = { id: "group-alpha-id", name: "Alpha Riders" };

const renderTrailLayerSpy = vi.hoisted(() => vi.fn());

vi.mock("@/lib/trailLayer", async () => {
  const actual = await vi.importActual<typeof import("@/lib/trailLayer")>(
    "@/lib/trailLayer",
  );
  return {
    ...actual,
    renderTrailLayer: (
      ...args: Parameters<typeof actual.renderTrailLayer>
    ) => {
      renderTrailLayerSpy(...args);
      return { layers: [], bounds: [], clear: () => {} };
    },
    renderTrailClusters: () => ({ layers: [], clear: () => {} }),
  };
});

vi.mock("@clerk/react", () => ({
  useUser: () => ({
    isLoaded: true,
    isSignedIn: true,
    user: {
      id: VIEWER_ID,
      primaryEmailAddress: { emailAddress: "v@e.com" },
      emailAddresses: [{ emailAddress: "v@e.com" }],
      firstName: "V",
      lastName: "E",
      fullName: "V E",
      username: "viewer",
      imageUrl: null,
    },
  }),
}));

vi.mock("wouter", () => ({
  useLocation: () => ["/map", vi.fn()],
  useSearch: () => "",
}));

const sharedTrail: Trail = {
  id: TRAIL_ID,
  user_id: null,
  name: "Group Trail on Map",
  type: "singletrack",
  difficulty: 5,
  distance_km: 10,
  terrain: "dirt",
  legal_status: "BOAT",
  is_public: true,
  created_at: "2026-01-15T12:00:00Z",
  source: "user",
  verification_status: "verified",
  path_geojson: {
    type: "LineString",
    coordinates: [
      [-2.0, 53.0],
      [-1.9, 53.1],
      [-1.8, 53.2],
    ],
  },
  shared_groups: [GROUP_ALPHA],
} as unknown as Trail;

vi.mock("@/lib/supabase", () => ({
  supabase: {},
  addTrail: vi.fn(),
  fetchTrailsInBbox: vi.fn().mockResolvedValue({
    trails: [],
    usedBbox: true,
  }),
  isSyntheticPlaceholderTrail: () => false,
}));

vi.mock("@/lib/groups", () => ({
  GROUPS_MEMBERSHIP_CHANGED_EVENT: "trailforge:groups-membership-changed",
  fetchGroupTrails: vi.fn().mockResolvedValue([sharedTrail]),
}));

vi.mock("@/lib/useLeaflet", () => ({
  useLeaflet: () => true,
}));

vi.mock("@/lib/mapBboxStore", () => ({
  mapBboxStore: { get: () => null, set: () => {} },
}));

vi.mock("@/lib/plannerRouteStore", () => ({
  useRouteTrails: () => [[], vi.fn()],
  useRouteEntries: () => [],
  removeRouteTrail: vi.fn(),
  removeRouteWaypoint: vi.fn(),
  setRouteEntries: vi.fn(),
}));

vi.mock("@/lib/routing", () => ({
  HYBRID_LABEL_TILE_URL: "https://example.com/{z}/{x}/{y}.png",
  HYBRID_LABEL_TILE_ATTRIBUTION: "test",
}));

vi.mock("@/lib/users", () => ({
  syncCurrentUser: vi.fn().mockResolvedValue({
    id: VIEWER_ID,
    email: "v@e.com",
    display_name: "V E",
    avatar_url: null,
    created_at: new Date().toISOString(),
  }),
}));

vi.mock("@/lib/completionsStore", () => ({
  markCompleted: vi.fn().mockResolvedValue(true),
  unmarkCompleted: vi.fn().mockResolvedValue(true),
  useCompletionIds: () => new Set<string>(),
  useCompletionState: () => ({ completed: false }),
}));

vi.mock("@/lib/trailContent", () => ({
  fetchTrailActivityCounts: vi.fn().mockResolvedValue({}),
  fetchTrailPermissions: vi.fn().mockResolvedValue({
    isOwner: false,
    isModerator: false,
    canModerate: false,
  }),
}));

vi.mock("@/lib/publishedRoutes", () => ({
  listPublishedRoutes: vi.fn().mockResolvedValue([]),
}));

function makeLeafletStub() {
  const map = {
    on: (_evt: string, _cb: () => void) => map,
    off: () => {},
    remove: () => {},
    invalidateSize: () => {},
    getZoom: () => 12,
    getBounds: () => ({
      getSouth: () => 52.9,
      getNorth: () => 53.3,
      getWest: () => -2.1,
      getEast: () => -1.7,
    }),
    createPane: () => {},
    getPane: () => ({ style: {} }),
    fitBounds: () => {},
    setView: () => {},
    hasLayer: () => false,
  };

  const polyline = () => {
    const p: Record<string, unknown> = {};
    p.addTo = () => p;
    p.remove = () => {};
    p.on = () => p;
    p.setStyle = () => {};
    return p;
  };

  const marker = (_latlng: unknown, opts?: Record<string, unknown>) => {
    const m: Record<string, unknown> = {
      options: { ...(opts ?? {}) },
    };
    m.addTo = () => m;
    m.on = () => m;
    m.remove = () => {};
    m.bindPopup = () => m;
    return m;
  };

  const divIcon = (opts: Record<string, unknown>) => opts;

  const L = {
    map: () => map,
    tileLayer: () => ({ addTo: () => ({}), remove: () => {} }),
    marker,
    polyline,
    divIcon,
    latLng: (a: number, b: number) => ({
      lat: a,
      lng: b,
      distanceTo: () => 100,
    }),
    latLngBounds: () => ({}),
    featureGroup: () => ({
      getBounds: () => ({
        getSouth: () => 0,
        getNorth: () => 1,
        getWest: () => 0,
        getEast: () => 1,
      }),
    }),
  } as unknown as typeof window.L;

  return { L, map };
}

let fetchSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  renderTrailLayerSpy.mockClear();
  const stub = makeLeafletStub();
  (window as unknown as { L: unknown }).L = stub.L;

  fetchSpy = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async () => {
      return new Response(JSON.stringify({}), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
});

afterEach(() => {
  delete (window as unknown as { L?: unknown }).L;
  fetchSpy.mockRestore();
  cleanup();
});

describe("MapTab — shared-group badge wiring", () => {
  it("passes showSharedGroupBadges: true to renderTrailLayer", async () => {
    const { default: MapTab } = await import("@/pages/MapTab");

    render(<MapTab />);

    await waitFor(
      () => expect(renderTrailLayerSpy).toHaveBeenCalled(),
      { timeout: 5000 },
    );

    const lastCall =
      renderTrailLayerSpy.mock.calls[
        renderTrailLayerSpy.mock.calls.length - 1
      ];
    const options = lastCall[2] as RenderTrailLayerOptions;
    expect(options.showSharedGroupBadges).toBe(true);

    const trails = lastCall[1] as Trail[];
    const groupTrail = trails.find((t) => t.id === TRAIL_ID);
    expect(groupTrail).toBeDefined();
    expect(groupTrail!.shared_groups).toBeDefined();
    expect(groupTrail!.shared_groups!.length).toBeGreaterThan(0);
    expect(groupTrail!.shared_groups![0]!.name).toBe(GROUP_ALPHA.name);
  });
});
