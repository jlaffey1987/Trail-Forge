import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Verifies that `assembleMultiModalRoute` lazy-fetches `gpx_data` for trails
 * that came from the slim Map-tab response (no GPX) BEFORE it tries to parse
 * waypoints. Without hydration, `parseGPX(undefined)` returns 0 waypoints
 * and the trail would be dropped into `skippedTrails` — which would silently
 * break multi-modal routing for any trail added straight from the Map tab.
 */

const hoisted = vi.hoisted(() => ({
  fetchTrailGpxByIds: vi.fn(),
}));

vi.mock("@/lib/supabase", () => ({
  supabase: {},
  fetchTrailGpxByIds: hoisted.fetchTrailGpxByIds,
}));

const SAMPLE_GPX = `<?xml version="1.0"?>
<gpx version="1.1" creator="trailforge-test" xmlns="http://www.topografix.com/GPX/1/1">
  <trk><trkseg>
    <trkpt lat="53.6100" lon="-2.5500"><ele>180</ele></trkpt>
    <trkpt lat="53.6105" lon="-2.5495"><ele>182</ele></trkpt>
    <trkpt lat="53.6112" lon="-2.5488"><ele>185</ele></trkpt>
    <trkpt lat="53.6118" lon="-2.5479"><ele>188</ele></trkpt>
  </trkseg></trk>
</gpx>`;

const TRAIL_ID = "33333333-3333-4333-8333-333333333333";

function makeSlimTrail() {
  return {
    id: TRAIL_ID,
    user_id: null,
    name: "Slim Map Trail",
    type: "singletrack",
    difficulty: 4,
    distance_km: 5.4,
    terrain: "dirt",
    legal_status: "BOAT",
    is_public: true,
    created_at: "2026-04-01T00:00:00Z",
    // gpx_data intentionally omitted — slim Map-tab response.
  };
}

beforeEach(() => {
  hoisted.fetchTrailGpxByIds.mockReset();
  // Stub fetch so getRoadRoute (OSRM) returns null without making real
  // network calls. The road segments aren't what we're testing here — we
  // only care that the trail GPX gets hydrated and parsed.
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => ({}),
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("assembleMultiModalRoute — lazy GPX hydration", () => {
  it("calls fetchTrailGpxByIds for trails missing gpx_data and uses the result to build the trail polyline", async () => {
    hoisted.fetchTrailGpxByIds.mockResolvedValue(
      new Map<string, unknown>([[TRAIL_ID, SAMPLE_GPX]]),
    );

    const { assembleMultiModalRoute } = await import("@/lib/routing");
    const trail = makeSlimTrail();

    const result = await assembleMultiModalRoute(
      { lat: 53.60, lng: -2.56, label: "Start" },
      { lat: 53.62, lng: -2.54, label: "End" },
      [trail as never],
    );

    // The hydration call fired with exactly the missing trail id BEFORE any
    // waypoint parsing occurred (otherwise the trail would have been
    // dropped into skippedTrails below).
    expect(hoisted.fetchTrailGpxByIds).toHaveBeenCalledTimes(1);
    expect(hoisted.fetchTrailGpxByIds).toHaveBeenCalledWith([TRAIL_ID]);

    // Trail was NOT skipped — proves the hydrated GPX flowed into parseGPX.
    expect(result.skippedTrails).toEqual([]);

    // A trail section exists with a polyline matching our fixture's points.
    const trailSections = result.sections.filter((s) => s.kind === "trail");
    expect(trailSections).toHaveLength(1);
    const trailSection = trailSections[0];
    if (trailSection.kind !== "trail") throw new Error("expected trail section");
    expect(trailSection.polyline.length).toBeGreaterThanOrEqual(4);
    expect(trailSection.polyline[0]).toEqual({ lat: 53.61, lng: -2.55 });
    expect(trailSection.trail.id).toBe(TRAIL_ID);
  });

  it("does not call fetchTrailGpxByIds when every trail already has gpx_data", async () => {
    hoisted.fetchTrailGpxByIds.mockResolvedValue(new Map());

    const { assembleMultiModalRoute } = await import("@/lib/routing");
    const trail = { ...makeSlimTrail(), gpx_data: SAMPLE_GPX };

    const result = await assembleMultiModalRoute(
      { lat: 53.60, lng: -2.56 },
      { lat: 53.62, lng: -2.54 },
      [trail as never],
    );

    expect(hoisted.fetchTrailGpxByIds).not.toHaveBeenCalled();
    expect(result.skippedTrails).toEqual([]);
    const trailSections = result.sections.filter((s) => s.kind === "trail");
    expect(trailSections).toHaveLength(1);
  });
});
