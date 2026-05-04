import { describe, it, expect, afterEach } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import React from "react";
import RouteThumbnail from "@/components/RouteThumbnail";
import type { Trail } from "@/lib/supabase";

afterEach(() => {
  cleanup();
});

function makeTrail(overrides: Partial<Trail> = {}): Trail {
  // Minimal Trail shape — many fields are optional for the thumbnail
  // (it only consumes `path_geojson`, `simplified_path`, `difficulty`).
  return {
    id: "t1",
    name: "Trail 1",
    distance_km: 5,
    difficulty: 4,
    terrain: null,
    legal_status: "BOAT",
    type: null,
    created_at: new Date().toISOString(),
    elevation_gain_m: null,
    elevation_loss_m: null,
    ...overrides,
  } as unknown as Trail;
}

describe("RouteThumbnail", () => {
  it("renders an SVG with one polyline per trail that has coordinates", () => {
    const trails = [
      makeTrail({
        id: "a",
        difficulty: 3,
        path_geojson: {
          type: "LineString",
          coordinates: [
            [-2, 54],
            [-2.001, 54.001],
            [-2.002, 54.0],
          ],
        },
      }),
      makeTrail({
        id: "b",
        difficulty: 8,
        path_geojson: {
          type: "LineString",
          coordinates: [
            [-2.002, 54.0],
            [-2.003, 53.999],
          ],
        },
      }),
    ];
    render(<RouteThumbnail trails={trails} testIdSuffix="route-1" />);
    const svg = screen.getByTestId("route-thumbnail-route-1");
    expect(svg.tagName.toLowerCase()).toBe("svg");
    // One polyline per trail with coords.
    const polylines = svg.querySelectorAll("polyline");
    expect(polylines.length).toBe(2);
    // Difficulty colors are applied so easy + hard trails are visually
    // distinguishable in the strip.
    expect(polylines[0]!.getAttribute("stroke")).toBe("#a3e635"); // diff=3
    expect(polylines[1]!.getAttribute("stroke")).toBe("#ef4444"); // diff=8
  });

  it("falls back to simplified_path JSON when path_geojson is absent", () => {
    const trails = [
      makeTrail({
        id: "c",
        path_geojson: null,
        simplified_path: JSON.stringify([
          [-2, 54],
          [-2.01, 54.01],
        ]),
      }),
    ];
    render(<RouteThumbnail trails={trails} testIdSuffix="route-2" />);
    const svg = screen.getByTestId("route-thumbnail-route-2");
    expect(svg.querySelectorAll("polyline").length).toBe(1);
  });

  it("renders an empty placeholder when no trail carries coords", () => {
    const trails = [
      makeTrail({ id: "d", path_geojson: null, simplified_path: null }),
    ];
    render(<RouteThumbnail trails={trails} testIdSuffix="route-3" />);
    // Empty state uses a <div> with the `-empty` suffix so layout
    // height stays stable between rows that do and don't have data.
    const empty = screen.getByTestId("route-thumbnail-route-3-empty");
    expect(empty.tagName.toLowerCase()).toBe("div");
  });

  it("renders nothing-of-value when trails array is empty", () => {
    render(<RouteThumbnail trails={[]} testIdSuffix="route-4" />);
    expect(screen.getByTestId("route-thumbnail-route-4-empty")).toBeInTheDocument();
  });
});
