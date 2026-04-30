import { describe, it, expect, vi, afterEach } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("@/lib/supabase", () => ({ supabase: {} }));
vi.mock("@/lib/trailLayer", () => ({
  getDifficultyColor: () => "#fbbf24",
}));

import MapRoutePanel from "@/components/MapRoutePanel";
import type { Trail } from "@/lib/supabase";
import type { RouteEntry, RouteWaypoint } from "@/lib/routing";

function makeTrail(id: string, name: string): Trail {
  return {
    id,
    user_id: null,
    name,
    type: "singletrack",
    difficulty: 4,
    distance_km: 6.5,
    terrain: "dirt",
    legal_status: "BOAT",
    is_public: true,
    created_at: "2026-04-01T00:00:00Z",
  } as unknown as Trail;
}

function makeWaypoint(id: string, name: string, kind: RouteWaypoint["kind"] = "fuel"): RouteWaypoint {
  return { id, name, kind, lat: 54.5, lng: -2.5 };
}

afterEach(() => {
  cleanup();
});

describe("MapRoutePanel — interleaved entries (Task #126)", () => {
  it("renders trails and waypoints inline in the entries order", async () => {
    const t1 = makeTrail("t-1", "Pennine Bridleway");
    const t2 = makeTrail("t-2", "South Downs Way");
    const wp = makeWaypoint("wp-shell", "Shell Garage");
    const entries: RouteEntry[] = [
      { kind: "trail", trail: t1 },
      { kind: "waypoint", waypoint: wp },
      { kind: "trail", trail: t2 },
    ];

    render(
      <MapRoutePanel
        trails={[t1, t2]}
        onReorder={() => {}}
        onRemove={() => {}}
        onClear={() => {}}
        onBuildRoute={() => {}}
        waypoints={[wp]}
        onRemoveWaypoint={() => {}}
        entries={entries}
        onReorderEntries={() => {}}
      />,
    );

    // The summary bar starts collapsed; expand it to render the list.
    await userEvent.click(screen.getByTestId("map-route-panel-toggle"));

    const list = screen.getByTestId("map-route-panel-list");
    const rows = list.querySelectorAll<HTMLElement>(
      '[data-testid^="map-route-panel-item-"], [data-testid^="map-route-panel-waypoint-wp-"]',
    );
    // Expect three rows in this exact interleaved order: trail, waypoint, trail.
    expect(rows.length).toBe(3);
    expect(rows[0].getAttribute("data-testid")).toBe("map-route-panel-item-0");
    expect(rows[1].getAttribute("data-testid")).toBe(
      "map-route-panel-waypoint-wp-shell",
    );
    expect(rows[2].getAttribute("data-testid")).toBe("map-route-panel-item-1");
  });

  it("calling the waypoint up-arrow swaps it with the preceding trail", async () => {
    const t1 = makeTrail("t-1", "Pennine Bridleway");
    const wp = makeWaypoint("wp-shell", "Shell Garage");
    const entries: RouteEntry[] = [
      { kind: "trail", trail: t1 },
      { kind: "waypoint", waypoint: wp },
    ];
    const onReorderEntries = vi.fn();

    render(
      <MapRoutePanel
        trails={[t1]}
        onReorder={() => {}}
        onRemove={() => {}}
        onClear={() => {}}
        onBuildRoute={() => {}}
        waypoints={[wp]}
        onRemoveWaypoint={() => {}}
        entries={entries}
        onReorderEntries={onReorderEntries}
      />,
    );

    await userEvent.click(screen.getByTestId("map-route-panel-toggle"));
    await userEvent.click(
      screen.getByTestId("map-route-panel-waypoint-up-wp-shell"),
    );

    expect(onReorderEntries).toHaveBeenCalledTimes(1);
    const next = onReorderEntries.mock.calls[0][0] as RouteEntry[];
    expect(next).toHaveLength(2);
    expect(next[0]).toEqual({ kind: "waypoint", waypoint: wp });
    expect(next[1]).toEqual({ kind: "trail", trail: t1 });
  });

  it("trail down-arrow swaps the trail with the next waypoint when interleaved", async () => {
    const t1 = makeTrail("t-1", "Pennine Bridleway");
    const wp = makeWaypoint("wp-shell", "Shell Garage");
    const entries: RouteEntry[] = [
      { kind: "trail", trail: t1 },
      { kind: "waypoint", waypoint: wp },
    ];
    const onReorderEntries = vi.fn();

    render(
      <MapRoutePanel
        trails={[t1]}
        onReorder={() => {}}
        onRemove={() => {}}
        onClear={() => {}}
        onBuildRoute={() => {}}
        waypoints={[wp]}
        onRemoveWaypoint={() => {}}
        entries={entries}
        onReorderEntries={onReorderEntries}
      />,
    );

    await userEvent.click(screen.getByTestId("map-route-panel-toggle"));
    await userEvent.click(screen.getByTestId("map-route-panel-down-0"));

    expect(onReorderEntries).toHaveBeenCalledTimes(1);
    const next = onReorderEntries.mock.calls[0][0] as RouteEntry[];
    expect(next[0]).toEqual({ kind: "waypoint", waypoint: wp });
    expect(next[1]).toEqual({ kind: "trail", trail: t1 });
  });

  it("up-arrow on the first row is disabled, down-arrow on the last row is disabled", async () => {
    const t1 = makeTrail("t-1", "Trail A");
    const wp = makeWaypoint("wp-1", "Stop");
    const entries: RouteEntry[] = [
      { kind: "trail", trail: t1 },
      { kind: "waypoint", waypoint: wp },
    ];

    render(
      <MapRoutePanel
        trails={[t1]}
        onReorder={() => {}}
        onRemove={() => {}}
        onClear={() => {}}
        onBuildRoute={() => {}}
        waypoints={[wp]}
        onRemoveWaypoint={() => {}}
        entries={entries}
        onReorderEntries={() => {}}
      />,
    );

    await userEvent.click(screen.getByTestId("map-route-panel-toggle"));
    expect(screen.getByTestId("map-route-panel-up-0")).toBeDisabled();
    expect(screen.getByTestId("map-route-panel-waypoint-down-wp-1")).toBeDisabled();
  });

  it("falls back to the legacy split layout when no entries prop is passed", async () => {
    const t1 = makeTrail("t-1", "Trail A");
    const wp = makeWaypoint("wp-1", "Stop");

    render(
      <MapRoutePanel
        trails={[t1]}
        onReorder={() => {}}
        onRemove={() => {}}
        onClear={() => {}}
        onBuildRoute={() => {}}
        waypoints={[wp]}
        onRemoveWaypoint={() => {}}
      />,
    );

    await userEvent.click(screen.getByTestId("map-route-panel-toggle"));
    // The "Stops (n)" header from the legacy split layout should appear.
    expect(screen.getByText(/Stops \(1\)/i)).toBeInTheDocument();
    // Waypoint reorder buttons only exist in interleaved mode.
    expect(
      screen.queryByTestId("map-route-panel-waypoint-up-wp-1"),
    ).not.toBeInTheDocument();
  });
});
