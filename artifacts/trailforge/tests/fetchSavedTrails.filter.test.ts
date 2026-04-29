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

const phantomTrail = {
  id: "phantom",
  user_id: null,
  name: "Legacy 2-point placeholder",
  type: null,
  difficulty: null,
  distance_km: 0.5,
  terrain: null,
  legal_status: null,
  is_public: true,
  created_at: "2025-06-01T00:00:00Z",
  verification_status: "ai-approximated",
  path_point_count: 2,
  bbox_min_lat: -37.8,
  bbox_max_lat: -37.795,
  bbox_min_lng: 144.96,
  bbox_max_lng: 144.96,
};

const verifiedTrail = {
  ...realTrail,
  id: "verified",
  name: "User-uploaded verified",
  verification_status: "verified",
};

describe("fetchSavedTrails — synthetic placeholder filter", () => {
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

  it("drops legacy 2-point ai-approximated placeholders even if the API returns them", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        items: [
          { trail_id: "real", status: null, saved_at: null, trail: realTrail },
          { trail_id: "phantom", status: null, saved_at: null, trail: phantomTrail },
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
