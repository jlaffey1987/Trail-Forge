import { describe, it, beforeEach, afterEach, vi, expect } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import React from "react";

vi.mock("@/lib/plannerRouteStore", () => ({
  getRouteTrails: () => [],
  subscribeRouteTrails: () => () => {},
  addRouteTrail: vi.fn(),
  removeRouteTrail: vi.fn(),
  PLANNER_MAX_TRAILS: 10,
}));

vi.mock("@/lib/trailLayer", () => ({
  getDifficultyColor: () => "#888",
}));

vi.mock("@/hooks/useCurrentUser", () => ({
  useCurrentUser: () => ({ isLoaded: true, isSignedIn: false, user: null, userId: null, isModerator: false }),
}));

vi.mock("@/lib/completionsStore", () => ({
  markCompleted: vi.fn(),
  unmarkCompleted: vi.fn(),
  useCompletionIds: () => new Set<string>(),
}));

vi.mock("wouter", () => ({
  useLocation: () => ["/", vi.fn()],
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
    verification_status: null,
    geometry: null,
    centroid_lat: 0,
    centroid_lng: 0,
    bbox_min_lat: 0,
    bbox_min_lng: 0,
    bbox_max_lat: 0,
    bbox_max_lng: 0,
    description: null,
    surface_type: null,
    trail_type: null,
    direction: null,
    region: null,
    country: null,
    osm_id: null,
    osm_type: null,
    source: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  } as unknown as Trail;
}

const TRAILS: Trail[] = [
  makeTrail({ id: "a", name: "Charlie", difficulty: 5, distance_km: 12 }),
  makeTrail({ id: "b", name: "Alpha", difficulty: 8, distance_km: 3 }),
  makeTrail({ id: "c", name: "Bravo", difficulty: 2, distance_km: 7 }),
  makeTrail({ id: "d", name: "Delta", difficulty: null, distance_km: null }),
];

const ID_TO_NAME: Record<string, string> = {
  a: "Charlie",
  b: "Alpha",
  c: "Bravo",
  d: "Delta",
};

function rowOrder(): string[] {
  const list = screen.getByTestId("cluster-trail-list-rows");
  return within(list)
    .getAllByRole("button")
    .map((b) => b.getAttribute("data-testid") ?? "")
    .filter((id) => id.startsWith("cluster-trail-row-"))
    .map((id) => ID_TO_NAME[id.replace("cluster-trail-row-", "")] ?? id);
}

const defaultProps = {
  trails: TRAILS,
  onSelectTrail: () => {},
  onZoomToArea: () => {},
  onClose: () => {},
};

describe("ClusterTrailListSheet sort", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
  });

  afterEach(() => {
    cleanup();
    window.sessionStorage.clear();
  });

  it("defaults to sorting by difficulty ascending with unrated at the end", () => {
    render(<ClusterTrailListSheet {...defaultProps} />);

    expect(rowOrder()).toEqual(["Bravo", "Charlie", "Alpha", "Delta"]);
    expect(
      screen.getByTestId("cluster-trail-list-sort-difficulty"),
    ).toHaveAttribute("aria-checked", "true");
  });

  it("re-sorts the list when the user picks Distance", async () => {
    const user = userEvent.setup();
    render(<ClusterTrailListSheet {...defaultProps} />);

    await user.click(screen.getByTestId("cluster-trail-list-sort-distance"));

    expect(rowOrder()).toEqual(["Alpha", "Bravo", "Charlie", "Delta"]);
  });

  it("re-sorts the list when the user picks Name", async () => {
    const user = userEvent.setup();
    render(<ClusterTrailListSheet {...defaultProps} />);

    await user.click(screen.getByTestId("cluster-trail-list-sort-name"));

    expect(rowOrder()).toEqual(["Alpha", "Bravo", "Charlie", "Delta"]);
  });

  it("remembers the chosen sort across remounts via sessionStorage", async () => {
    const user = userEvent.setup();
    const { unmount } = render(<ClusterTrailListSheet {...defaultProps} />);

    await user.click(screen.getByTestId("cluster-trail-list-sort-distance"));
    expect(window.sessionStorage.getItem("trailforge:clusterTrailListSort")).toBe(
      "distance",
    );

    unmount();

    render(<ClusterTrailListSheet {...defaultProps} />);

    expect(
      screen.getByTestId("cluster-trail-list-sort-distance"),
    ).toHaveAttribute("aria-checked", "true");
    expect(rowOrder()).toEqual(["Alpha", "Bravo", "Charlie", "Delta"]);
  });
});

describe("ClusterTrailListSheet sort direction toggle", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
  });

  afterEach(() => {
    cleanup();
    window.sessionStorage.clear();
  });

  it("shows the direction toggle button defaulting to ascending", () => {
    render(<ClusterTrailListSheet {...defaultProps} />);

    const btn = screen.getByTestId("cluster-trail-list-sort-direction");
    expect(btn).toBeInTheDocument();
    expect(btn.textContent).toContain("↑");
  });

  it("reverses difficulty order when toggled to descending — hardest first, unrated still at end", async () => {
    const user = userEvent.setup();
    render(<ClusterTrailListSheet {...defaultProps} />);

    expect(rowOrder()).toEqual(["Bravo", "Charlie", "Alpha", "Delta"]);

    await user.click(screen.getByTestId("cluster-trail-list-sort-direction"));

    expect(rowOrder()).toEqual(["Alpha", "Charlie", "Bravo", "Delta"]);

    const btn = screen.getByTestId("cluster-trail-list-sort-direction");
    expect(btn.textContent).toContain("↓");
  });

  it("reverses distance order when toggled to descending — longest first, missing still at end", async () => {
    const user = userEvent.setup();
    render(<ClusterTrailListSheet {...defaultProps} />);

    await user.click(screen.getByTestId("cluster-trail-list-sort-distance"));
    expect(rowOrder()).toEqual(["Alpha", "Bravo", "Charlie", "Delta"]);

    await user.click(screen.getByTestId("cluster-trail-list-sort-direction"));
    expect(rowOrder()).toEqual(["Charlie", "Bravo", "Alpha", "Delta"]);
  });

  it("reverses name order when toggled to descending", async () => {
    const user = userEvent.setup();
    render(<ClusterTrailListSheet {...defaultProps} />);

    await user.click(screen.getByTestId("cluster-trail-list-sort-name"));
    expect(rowOrder()).toEqual(["Alpha", "Bravo", "Charlie", "Delta"]);

    await user.click(screen.getByTestId("cluster-trail-list-sort-direction"));
    expect(rowOrder()).toEqual(["Delta", "Charlie", "Bravo", "Alpha"]);
  });

  it("toggles back to ascending on second click", async () => {
    const user = userEvent.setup();
    render(<ClusterTrailListSheet {...defaultProps} />);

    await user.click(screen.getByTestId("cluster-trail-list-sort-direction"));
    expect(rowOrder()).toEqual(["Alpha", "Charlie", "Bravo", "Delta"]);

    await user.click(screen.getByTestId("cluster-trail-list-sort-direction"));
    expect(rowOrder()).toEqual(["Bravo", "Charlie", "Alpha", "Delta"]);

    const btn = screen.getByTestId("cluster-trail-list-sort-direction");
    expect(btn.textContent).toContain("↑");
  });

  it("persists direction in sessionStorage and restores on remount", async () => {
    const user = userEvent.setup();
    const { unmount } = render(<ClusterTrailListSheet {...defaultProps} />);

    await user.click(screen.getByTestId("cluster-trail-list-sort-direction"));
    expect(window.sessionStorage.getItem("trailforge:clusterTrailListSortDir")).toBe(
      "desc",
    );

    unmount();

    render(<ClusterTrailListSheet {...defaultProps} />);

    expect(rowOrder()).toEqual(["Alpha", "Charlie", "Bravo", "Delta"]);
    const btn = screen.getByTestId("cluster-trail-list-sort-direction");
    expect(btn.textContent).toContain("↓");
  });

  it("persists both sort key and direction independently", async () => {
    const user = userEvent.setup();
    const { unmount } = render(<ClusterTrailListSheet {...defaultProps} />);

    await user.click(screen.getByTestId("cluster-trail-list-sort-distance"));
    await user.click(screen.getByTestId("cluster-trail-list-sort-direction"));
    expect(rowOrder()).toEqual(["Charlie", "Bravo", "Alpha", "Delta"]);

    unmount();

    render(<ClusterTrailListSheet {...defaultProps} />);

    expect(
      screen.getByTestId("cluster-trail-list-sort-distance"),
    ).toHaveAttribute("aria-checked", "true");
    expect(rowOrder()).toEqual(["Charlie", "Bravo", "Alpha", "Delta"]);
  });
});
