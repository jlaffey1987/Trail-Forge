import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fetchSavedTrails } from "@/lib/supabase";

const realTrail = {
  id: "real",
  user_id: null,
  name: "Real OSM-snapped",
  type: null,
  difficulty: 4,
  distance_km: 7.2,
  terrain: null,
  legal_status: "BOAT",
  is_public: true,
  created_at: "2026-01-01T00:00:00Z",
  verification_status: "ai-approximated",
  path_point_count: 47,
  bbox_min_lat: -37.81,
  bbox_max_lat: -37.79,
  bbox_min_lng: 144.95,
  bbox_max_lng: 144.97,
};

const verifiedTrail = {
  ...realTrail,
  id: "verified",
  name: "User-uploaded verified",
  verification_status: "verified",
};

describe("fetchSavedTrails — read-path contract", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "window",
      Object.assign(globalThis, {
        location: { origin: "http://localhost" },
      }),
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  // Legacy 2-point ai-approximated placeholder rows used to be filtered out
  // here in the client. As of supabase migration
  // `0019_phantom_ai_trails_cleanup.sql` they are soft-deleted in the DB
  // (and a CHECK constraint blocks new ones), so the API server's
  // `/api/me/saved-trails` join naturally hides them and the client just
  // forwards whatever the API returns. This test pins that simpler
  // contract so we don't accidentally re-introduce a redundant filter.
  it("returns whatever the API server returns, without re-filtering", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        items: [
          { trail_id: "real", status: null, saved_at: null, trail: realTrail },
          { trail_id: "verified", status: null, saved_at: null, trail: verifiedTrail },
          { trail_id: "missing", status: null, saved_at: null, trail: null },
        ],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchSavedTrails({ userId: "user_123", sessionId: null });

    expect(result.map((t) => t.id).sort()).toEqual(["real", "verified"]);
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
