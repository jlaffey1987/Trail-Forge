import { describe, it, expect } from "vitest";
import { orderTrailsNearestNeighbour, haversineM } from "@/lib/routing";
import type { Trail } from "@/lib/supabase";

function gpx(coords: [number, number][]): string {
  const pts = coords
    .map(([lat, lon]) => `<trkpt lat="${lat}" lon="${lon}"/>`)
    .join("");
  return `<?xml version="1.0"?><gpx><trk><trkseg>${pts}</trkseg></trk></gpx>`;
}

function makeTrail(
  id: string,
  name: string,
  coords: [number, number][],
): Trail {
  return {
    id,
    user_id: null,
    name,
    type: "singletrack",
    difficulty: 4,
    distance_km: 10,
    terrain: "dirt",
    legal_status: "BOAT",
    is_public: true,
    created_at: "",
    gpx_data: gpx(coords),
    verification_status: "verified",
  } as Trail;
}

describe("orderTrailsNearestNeighbour", () => {
  it("returns empty array for empty input", () => {
    const result = orderTrailsNearestNeighbour({ lat: 0, lng: 0 }, []);
    expect(result).toEqual([]);
  });

  it("returns single trail unchanged", () => {
    const t = makeTrail("a", "A", [[1, 1], [2, 2]]);
    const result = orderTrailsNearestNeighbour({ lat: 0, lng: 0 }, [t]);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("a");
  });

  it("orders trails by proximity to start point", () => {
    const far = makeTrail("far", "Far Trail", [[50, 50], [51, 51]]);
    const near = makeTrail("near", "Near Trail", [[1, 1], [2, 2]]);
    const mid = makeTrail("mid", "Mid Trail", [[10, 10], [11, 11]]);

    const result = orderTrailsNearestNeighbour(
      { lat: 0, lng: 0 },
      [far, near, mid],
    );

    expect(result.map((t) => t.id)).toEqual(["near", "mid", "far"]);
  });

  it("considers trail exit point for chaining (nearest-neighbour greedy)", () => {
    const a = makeTrail("a", "A", [[0, 0], [10, 10]]);
    const b = makeTrail("b", "B", [[11, 11], [20, 20]]);
    const c = makeTrail("c", "C", [[21, 21], [30, 30]]);

    const result = orderTrailsNearestNeighbour({ lat: 0, lng: 0 }, [c, b, a]);
    expect(result.map((t) => t.id)).toEqual(["a", "b", "c"]);
  });

  it("considers reversed direction (exit closer than entry)", () => {
    const a = makeTrail("a", "A", [[5, 5], [0.1, 0.1]]);
    const b = makeTrail("b", "B", [[50, 50], [6, 6]]);

    const result = orderTrailsNearestNeighbour({ lat: 0, lng: 0 }, [b, a]);
    expect(result[0].id).toBe("a");
    expect(result[1].id).toBe("b");
  });

  it("appends trails without GPX data at the end", () => {
    const withGpx1 = makeTrail("g1", "With GPX 1", [[1, 1], [2, 2]]);
    const withGpx2 = makeTrail("g2", "With GPX 2", [[3, 3], [4, 4]]);
    const noGpx = {
      ...makeTrail("no", "No GPX", []),
      gpx_data: null,
    } as Trail;

    const result = orderTrailsNearestNeighbour(
      { lat: 0, lng: 0 },
      [noGpx, withGpx2, withGpx1],
    );

    expect(result[0].id).toBe("g1");
    expect(result[1].id).toBe("g2");
    expect(result[2].id).toBe("no");
  });

  it("handles all trails without GPX gracefully", () => {
    const a = { ...makeTrail("a", "A", []), gpx_data: null } as Trail;
    const b = { ...makeTrail("b", "B", []), gpx_data: null } as Trail;

    const result = orderTrailsNearestNeighbour({ lat: 0, lng: 0 }, [a, b]);
    expect(result).toHaveLength(2);
  });
});

describe("haversineM", () => {
  it("returns 0 for same point", () => {
    expect(haversineM({ lat: 51, lng: -1 }, { lat: 51, lng: -1 })).toBe(0);
  });

  it("returns approximately correct distance for known points", () => {
    const london = { lat: 51.5074, lng: -0.1278 };
    const paris = { lat: 48.8566, lng: 2.3522 };
    const d = haversineM(london, paris);
    expect(d).toBeGreaterThan(340_000);
    expect(d).toBeLessThan(350_000);
  });
});
