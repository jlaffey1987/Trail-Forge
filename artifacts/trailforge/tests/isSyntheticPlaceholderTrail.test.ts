import { describe, it, expect } from "vitest";
import { isSyntheticPlaceholderTrail, type Trail } from "@/lib/supabase";

function trail(overrides: Partial<Trail>): Trail {
  return {
    id: "t",
    user_id: null,
    name: "x",
    type: null,
    difficulty: null,
    distance_km: null,
    terrain: null,
    legal_status: null,
    is_public: true,
    created_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

describe("isSyntheticPlaceholderTrail", () => {
  it("flags the legacy 2-point ai-approximated placeholder shape", () => {
    const lat = -37.8;
    const lon = 144.96;
    expect(
      isSyntheticPlaceholderTrail(
        trail({
          verification_status: "ai-approximated",
          path_point_count: 2,
          bbox_min_lat: lat,
          bbox_max_lat: lat + 0.005,
          bbox_min_lng: lon,
          bbox_max_lng: lon,
        }),
      ),
    ).toBe(true);
  });

  it("flags rows with unknown point count but the same degenerate bbox", () => {
    const lat = 12.34;
    const lon = 56.78;
    expect(
      isSyntheticPlaceholderTrail(
        trail({
          verification_status: "ai-approximated",
          path_point_count: null,
          bbox_min_lat: lat,
          bbox_max_lat: lat + 0.005,
          bbox_min_lng: lon,
          bbox_max_lng: lon,
        }),
      ),
    ).toBe(true);
  });

  it("does not flag a real OSM-snapped ai-approximated trail (many points, real bbox)", () => {
    expect(
      isSyntheticPlaceholderTrail(
        trail({
          verification_status: "ai-approximated",
          path_point_count: 47,
          bbox_min_lat: -37.81,
          bbox_max_lat: -37.79,
          bbox_min_lng: 144.95,
          bbox_max_lng: 144.97,
        }),
      ),
    ).toBe(false);
  });

  it("does not flag a verified user-uploaded trail with the same bbox shape", () => {
    const lat = -37.8;
    const lon = 144.96;
    expect(
      isSyntheticPlaceholderTrail(
        trail({
          verification_status: "verified",
          path_point_count: 2,
          bbox_min_lat: lat,
          bbox_max_lat: lat + 0.005,
          bbox_min_lng: lon,
          bbox_max_lng: lon,
        }),
      ),
    ).toBe(false);
  });

  it("does not flag rows missing bbox columns", () => {
    expect(
      isSyntheticPlaceholderTrail(
        trail({
          verification_status: "ai-approximated",
          path_point_count: 2,
          bbox_min_lat: null,
          bbox_max_lat: null,
          bbox_min_lng: null,
          bbox_max_lng: null,
        }),
      ),
    ).toBe(false);
  });

  it("does not flag ai-approximated rows whose lat span is well outside ~500m", () => {
    const lat = 0;
    const lon = 0;
    expect(
      isSyntheticPlaceholderTrail(
        trail({
          verification_status: "ai-approximated",
          path_point_count: 2,
          bbox_min_lat: lat,
          bbox_max_lat: lat + 0.05,
          bbox_min_lng: lon,
          bbox_max_lng: lon,
        }),
      ),
    ).toBe(false);
  });

  it("does not flag rows with non-zero longitude span", () => {
    const lat = 10;
    const lon = 20;
    expect(
      isSyntheticPlaceholderTrail(
        trail({
          verification_status: "ai-approximated",
          path_point_count: 2,
          bbox_min_lat: lat,
          bbox_max_lat: lat + 0.005,
          bbox_min_lng: lon,
          bbox_max_lng: lon + 0.001,
        }),
      ),
    ).toBe(false);
  });
});
