import { describe, it, expect } from "vitest";
import { distancePointToPolylineM } from "@/lib/poi";

describe("poi.distancePointToPolylineM", () => {
  it("returns Infinity for an empty polyline", () => {
    expect(distancePointToPolylineM({ lat: 53.6, lng: -2.5 }, [])).toBe(Infinity);
  });

  it("falls back to haversine for a single-point polyline", () => {
    const d = distancePointToPolylineM(
      { lat: 53.6, lng: -2.5 },
      [{ lat: 53.6, lng: -2.5 }],
    );
    expect(d).toBeCloseTo(0, 1);
  });

  it("returns ~0 for a point sitting on a segment", () => {
    const d = distancePointToPolylineM(
      { lat: 53.6, lng: -2.5 },
      [
        { lat: 53.6, lng: -2.6 },
        { lat: 53.6, lng: -2.4 },
      ],
    );
    expect(d).toBeLessThan(50); // metres, within projection error
  });

  it("returns the perpendicular distance for a point off the segment", () => {
    // Segment: ~10km west-east at lat 53.6 (-2.6 -> -2.4). A point at lat
    // 53.61 is ~1.11km north of the segment.
    const d = distancePointToPolylineM(
      { lat: 53.61, lng: -2.5 },
      [
        { lat: 53.6, lng: -2.6 },
        { lat: 53.6, lng: -2.4 },
      ],
    );
    expect(d).toBeGreaterThan(900);
    expect(d).toBeLessThan(1300);
  });

  it("filters POIs outside an N-km corridor and keeps the ones inside", () => {
    // Polyline is the same west-east segment at lat 53.6.
    const polyline = [
      { lat: 53.6, lng: -2.6 },
      { lat: 53.6, lng: -2.4 },
    ];
    const pois = [
      { lat: 53.601, lng: -2.5 }, // ~110m north — should pass a 1km corridor
      { lat: 53.605, lng: -2.5 }, // ~555m north — should pass a 1km corridor
      { lat: 53.62, lng: -2.5 }, // ~2.2km north — should fail a 1km corridor
    ];
    const corridorM = 1000;
    const inside = pois.filter(
      (p) => distancePointToPolylineM(p, polyline) <= corridorM,
    );
    expect(inside).toHaveLength(2);
    expect(inside).toEqual([pois[0], pois[1]]);
  });

  it("uses the closest segment when multiple are present (no false positives)", () => {
    // L-shaped polyline. Point sits very close to the second leg only.
    const polyline = [
      { lat: 53.6, lng: -2.6 },
      { lat: 53.6, lng: -2.5 },
      { lat: 53.65, lng: -2.5 },
    ];
    const d = distancePointToPolylineM({ lat: 53.625, lng: -2.501 }, polyline);
    // Lng offset of 0.001° at lat 53.6 ≈ 66m east of the vertical leg.
    expect(d).toBeLessThan(120);
  });
});
