import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Verifies that the Map-tab fetch (`fetchTrailsInBbox`) actually requests the
 * slim column projection that omits `gpx_data`, and that it falls back to
 * `select("*")` if the slim columns introduced by migration 0008 aren't
 * present (Postgres error code 42703).
 *
 * The supabase JS client is mocked via `vi.mock("@supabase/supabase-js")` so
 * the test never touches the network.
 */

const hoisted = vi.hoisted(() => ({
  selectCalls: [] as string[],
  bboxCalls: 0,
  // Each entry corresponds to one `.limit()` resolution, in the order they
  // are invoked by `fetchTrailsInBbox`. Tests push in the responses they
  // want before importing the module under test.
  nextResults: [] as Array<{ data: unknown; error: { code?: string; message?: string } | null }>,
}));

vi.mock("@supabase/supabase-js", () => {
  const makeBuilder = () => {
    const builder: Record<string, unknown> = {
      eq: () => builder,
      lte: () => {
        // Track that bbox columns are referenced — the implementation chains
        // four `.lte/.gte` calls on the bbox columns, so any `.lte` invocation
        // is a strong signal that we took the bbox-filtered path.
        hoisted.bboxCalls++;
        return builder;
      },
      gte: () => builder,
      in: () => builder,
      limit: () => {
        const next = hoisted.nextResults.shift() ?? { data: [], error: null };
        return Promise.resolve(next);
      },
    };
    return builder;
  };
  return {
    createClient: () => ({
      from: () => ({
        select: (cols: string) => {
          hoisted.selectCalls.push(cols);
          return makeBuilder();
        },
      }),
    }),
  };
});

const TRAIL_SLIM_COLUMNS = [
  "id",
  "user_id",
  "owner_user_id",
  "name",
  "type",
  "difficulty",
  "distance_km",
  "terrain",
  "legal_status",
  "is_public",
  "created_at",
  "bbox_min_lat",
  "bbox_max_lat",
  "bbox_min_lng",
  "bbox_max_lng",
  "description",
  "deleted_at",
  "gpx_object_path",
  "source",
  "source_url",
  "verification_status",
  "ai_grade",
  "ai_grade_rationale",
  "ai_grade_model",
  "ai_graded_at",
  "simplified_path",
  "path_geojson",
  "path_point_count",
  "elevation_profile",
  "elevation_gain_m",
  "elevation_loss_m",
].join(",");

const BBOX = { minLat: 53.0, maxLat: 54.0, minLng: -3.0, maxLng: -2.0 };

beforeEach(() => {
  hoisted.selectCalls.length = 0;
  hoisted.nextResults.length = 0;
  hoisted.bboxCalls = 0;
  vi.resetModules();
});

describe("fetchTrailsInBbox — slim projection", () => {
  it("requests every map column except gpx_data on the fast path", async () => {
    hoisted.nextResults.push({
      data: [
        {
          id: "11111111-1111-4111-8111-111111111111",
          user_id: null,
          name: "Slim Trail",
          type: null,
          difficulty: 4,
          distance_km: 5.4,
          terrain: null,
          legal_status: "BOAT",
          is_public: true,
          created_at: "2026-04-01T00:00:00Z",
          verification_status: "verified",
          path_point_count: 50,
        },
      ],
      error: null,
    });

    const { fetchTrailsInBbox } = await import("@/lib/supabase");
    const result = await fetchTrailsInBbox(BBOX);

    // Exactly one Supabase query was needed — the fast slim+bbox path.
    expect(hoisted.selectCalls).toHaveLength(1);
    expect(hoisted.selectCalls[0]).toBe(TRAIL_SLIM_COLUMNS);
    // gpx_data is the heavy column that the Map tab is explicitly NOT
    // fetching anymore — guard against accidental regressions.
    expect(hoisted.selectCalls[0]).not.toMatch(/(^|,)gpx_data(,|$)/);
    // Bbox filters were chained on, so we used the spatial fast path.
    expect(hoisted.bboxCalls).toBeGreaterThan(0);
    expect(result.usedBbox).toBe(true);
    expect(result.trails.map((t) => t.id)).toEqual([
      "11111111-1111-4111-8111-111111111111",
    ]);
  });

  it("falls back to select(*) when the slim path fails with 42703 (migration 0008 not applied)", async () => {
    // First attempt — slim+bbox — fails because `simplified_path` doesn't
    // exist on this older database.
    hoisted.nextResults.push({
      data: null,
      error: {
        code: "42703",
        message: 'column trails.simplified_path does not exist',
      },
    });
    // Second attempt — bbox + "*" — succeeds.
    hoisted.nextResults.push({
      data: [
        {
          id: "22222222-2222-4222-8222-222222222222",
          user_id: null,
          name: "Legacy Trail",
          type: null,
          difficulty: 3,
          distance_km: 2.1,
          terrain: null,
          legal_status: "BOAT",
          is_public: true,
          created_at: "2025-01-01T00:00:00Z",
          verification_status: "verified",
          path_point_count: 80,
          gpx_data: "<gpx></gpx>",
        },
      ],
      error: null,
    });

    const { fetchTrailsInBbox } = await import("@/lib/supabase");
    const result = await fetchTrailsInBbox(BBOX);

    expect(hoisted.selectCalls).toHaveLength(2);
    expect(hoisted.selectCalls[0]).toBe(TRAIL_SLIM_COLUMNS);
    // The retry uses "*" so older databases without the slim columns still
    // work end-to-end.
    expect(hoisted.selectCalls[1]).toBe("*");
    expect(result.usedBbox).toBe(true);
    expect(result.trails.map((t) => t.id)).toEqual([
      "22222222-2222-4222-8222-222222222222",
    ]);
  });
});
