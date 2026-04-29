import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import React from "react";

// RouteBuilder lazy-fetches GPX data. We never actually need it in this
// test — give it a stable, no-op mock so the component mounts cleanly.
const hoisted = vi.hoisted(() => ({
  fetchTrailGpxByIds: vi.fn().mockResolvedValue(new Map()),
}));

vi.mock("@/lib/supabase", () => ({
  supabase: {},
  fetchTrailGpxByIds: hoisted.fetchTrailGpxByIds,
}));

import RouteBuilder from "@/components/RouteBuilder";
import type { Trail } from "@/lib/supabase";
import type { RouteWaypoint } from "@/lib/routing";

const SAMPLE_GPX = `<?xml version="1.0"?>
<gpx version="1.1" creator="trailforge-test" xmlns="http://www.topografix.com/GPX/1/1">
  <trk><trkseg>
    <trkpt lat="53.61" lon="-2.55"><ele>180</ele></trkpt>
    <trkpt lat="53.62" lon="-2.54"><ele>185</ele></trkpt>
  </trkseg></trk>
</gpx>`;

function makeTrail(): Trail {
  return {
    id: "t-aaaa-1",
    user_id: null,
    name: "Test Trail",
    type: "singletrack",
    difficulty: 3,
    distance_km: 4.2,
    terrain: "dirt",
    legal_status: "BOAT",
    is_public: true,
    created_at: "2026-04-01T00:00:00Z",
    gpx_data: SAMPLE_GPX,
  } as unknown as Trail;
}

beforeEach(() => {
  hoisted.fetchTrailGpxByIds.mockReset().mockResolvedValue(new Map());
});

afterEach(() => {
  cleanup();
});

describe("RouteBuilder — waypoint section", () => {
  it("renders the Stops along route header and a row per waypoint", () => {
    const waypoints: RouteWaypoint[] = [
      { id: "wp-fuel-1", name: "Shell Garage, Stranraer", kind: "fuel", lat: 54.9, lng: -5.0 },
      { id: "wp-camp-1", name: "Bothy Camp", kind: "campsite", lat: 55.0, lng: -4.9 },
    ];

    render(
      <RouteBuilder
        selectedTrails={[makeTrail()]}
        onReorder={() => {}}
        onRemove={() => {}}
        onClose={() => {}}
        waypoints={waypoints}
        onRemoveWaypoint={() => {}}
      />,
    );

    expect(screen.getByText(/Stops along route/i)).toBeInTheDocument();
    expect(screen.getByTestId("route-builder-waypoint-wp-fuel-1")).toBeInTheDocument();
    expect(screen.getByTestId("route-builder-waypoint-wp-camp-1")).toBeInTheDocument();
    expect(screen.getByText("Shell Garage, Stranraer")).toBeInTheDocument();
    expect(screen.getByText("Bothy Camp")).toBeInTheDocument();
  });

  it("hides the section entirely when no waypoints are passed", () => {
    render(
      <RouteBuilder
        selectedTrails={[makeTrail()]}
        onReorder={() => {}}
        onRemove={() => {}}
        onClose={() => {}}
      />,
    );
    expect(screen.queryByText(/Stops along route/i)).not.toBeInTheDocument();
  });

  it("invokes onRemoveWaypoint when the per-row remove button is clicked", async () => {
    const onRemoveWaypoint = vi.fn();
    const waypoints: RouteWaypoint[] = [
      { id: "wp-x", name: "X stop", kind: "fuel", lat: 54.9, lng: -5.0 },
    ];

    render(
      <RouteBuilder
        selectedTrails={[makeTrail()]}
        onReorder={() => {}}
        onRemove={() => {}}
        onClose={() => {}}
        waypoints={waypoints}
        onRemoveWaypoint={onRemoveWaypoint}
      />,
    );

    const btn = screen.getByTestId("route-builder-waypoint-remove-wp-x");
    await userEvent.click(btn);
    expect(onRemoveWaypoint).toHaveBeenCalledWith("wp-x");
  });
});
