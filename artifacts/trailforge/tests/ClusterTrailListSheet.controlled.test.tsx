import { describe, it, beforeEach, afterEach, vi, expect } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import React from "react";

const storeMocks = vi.hoisted(() => ({
  addRouteTrail: vi.fn(),
  removeRouteTrail: vi.fn(),
  getRouteTrails: vi.fn(() => []),
  subscribeRouteTrails: vi.fn(() => () => {}),
}));

vi.mock("@/lib/plannerRouteStore", () => storeMocks);

vi.mock("@/lib/trailLayer", () => ({
  getDifficultyColor: () => "#888",
}));

import ClusterTrailListSheet from "@/components/ClusterTrailListSheet";
import type { Trail } from "@/lib/supabase";

function makeTrail(partial: Partial<Trail> & { id: string; name: string }): Trail {
  return {
    id: partial.id,
    name: partial.name,
    difficulty: partial.difficulty ?? null,
    distance_km: partial.distance_km ?? null,
    elevation_gain_m: null,
    elevation_loss_m: null,
    legal_status: null,
    verification_status: partial.verification_status ?? null,
  } as unknown as Trail;
}

const TRAILS: Trail[] = [
  makeTrail({ id: "t1", name: "Alpha", difficulty: 3 }),
  makeTrail({ id: "t2", name: "Bravo", difficulty: 5 }),
];

describe("ClusterTrailListSheet — controlled mode (PlannerMap)", () => {
  beforeEach(() => {
    storeMocks.addRouteTrail.mockReset();
    storeMocks.removeRouteTrail.mockReset();
    storeMocks.getRouteTrails.mockReturnValue([]);
    storeMocks.subscribeRouteTrails.mockReturnValue(() => {});
    window.sessionStorage.clear();
  });

  afterEach(() => {
    cleanup();
    window.sessionStorage.clear();
  });

  it("uses selectedIds for the in-route badge instead of the global store", () => {
    render(
      <ClusterTrailListSheet
        trails={TRAILS}
        selectedIds={new Set(["t2"])}
        onToggleTrail={() => {}}
        onSelectTrail={() => {}}
        onZoomToArea={() => {}}
        onClose={() => {}}
      />,
    );

    expect(screen.getByTestId("cluster-trail-route-toggle-t1")).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    expect(screen.getByTestId("cluster-trail-route-toggle-t2")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(storeMocks.subscribeRouteTrails).not.toHaveBeenCalled();
    expect(storeMocks.getRouteTrails).not.toHaveBeenCalled();
  });

  it("invokes onToggleTrail (not the store) when a row's route button is tapped", async () => {
    const user = userEvent.setup();
    const onToggleTrail = vi.fn();
    render(
      <ClusterTrailListSheet
        trails={TRAILS}
        selectedIds={new Set()}
        onToggleTrail={onToggleTrail}
        onSelectTrail={() => {}}
        onZoomToArea={() => {}}
        onClose={() => {}}
      />,
    );

    await user.click(screen.getByTestId("cluster-trail-route-toggle-t1"));

    expect(onToggleTrail).toHaveBeenCalledTimes(1);
    expect(onToggleTrail.mock.calls[0][0].id).toBe("t1");
    expect(storeMocks.addRouteTrail).not.toHaveBeenCalled();
    expect(storeMocks.removeRouteTrail).not.toHaveBeenCalled();
  });

  it("delegates the approximated guard to onToggleTrail in controlled mode", async () => {
    const user = userEvent.setup();
    const onToggleTrail = vi.fn();
    const trails = [
      makeTrail({
        id: "ai",
        name: "AI route",
        difficulty: 4,
        verification_status: "ai-approximated",
      }),
    ];
    render(
      <ClusterTrailListSheet
        trails={trails}
        selectedIds={new Set()}
        onToggleTrail={onToggleTrail}
        onSelectTrail={() => {}}
        onZoomToArea={() => {}}
        onClose={() => {}}
      />,
    );

    // The button stays disabled visually so the user can't click it. We
    // assert the disabled state itself — the planner's toggle would only
    // ever run if a future change re-enables the button, in which case the
    // parent decides how to surface the rejection.
    const btn = screen.getByTestId("cluster-trail-route-toggle-ai");
    expect(btn).toBeDisabled();
    await user.click(btn).catch(() => {});
    expect(onToggleTrail).not.toHaveBeenCalled();
  });

  it("falls back to the planner route store when controlled props are omitted", async () => {
    const user = userEvent.setup();
    storeMocks.getRouteTrails.mockReturnValue([{ id: "t1" }] as unknown as Trail[]);
    render(
      <ClusterTrailListSheet
        trails={TRAILS}
        onSelectTrail={() => {}}
        onZoomToArea={() => {}}
        onClose={() => {}}
      />,
    );

    // Initial in-route state comes from the store mock.
    expect(screen.getByTestId("cluster-trail-route-toggle-t1")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(storeMocks.subscribeRouteTrails).toHaveBeenCalled();

    // Tapping the un-selected trail's button hits the store, not any
    // controlled callback.
    await user.click(screen.getByTestId("cluster-trail-route-toggle-t2"));
    expect(storeMocks.addRouteTrail).toHaveBeenCalledTimes(1);
    expect(storeMocks.addRouteTrail.mock.calls[0][0].id).toBe("t2");
  });
});
