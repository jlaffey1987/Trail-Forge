import { describe, it, beforeEach, afterEach, vi, expect } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import React from "react";
import { useLocation } from "wouter";

// ---------------------------------------------------------------------------
// Module mocks. These are hoisted by vitest so they apply to every dynamic
// import below — including the modules that MapTab and PlannerTab transitively
// pull in (Clerk, Supabase, Leaflet, group fetches, etc.). The map-init
// effect bails out as soon as `useLeaflet()` reports "not loaded", so no
// network or browser-only API is touched on mount.
// ---------------------------------------------------------------------------

vi.mock("@clerk/react", () => ({
  useUser: () => ({ isLoaded: true, isSignedIn: false, user: null }),
}));

// Minimal stateful wouter mock so MapTab's `setLocation` actually moves the
// shared "current path" forward. Components reading `useLocation` re-render
// when the path changes, which is what lets the harness swap MapTab for
// PlannerTab in response to the Build Route click.
const wouterState = vi.hoisted(() => {
  return {
    path: "/map",
    listeners: new Set<() => void>(),
  };
});

vi.mock("wouter", async () => {
  const reactMod = await import("react");
  const useLocation = (): [string, (to: string) => void] => {
    const [, force] = reactMod.useState(0);
    reactMod.useEffect(() => {
      const cb = () => force((n) => n + 1);
      wouterState.listeners.add(cb);
      return () => {
        wouterState.listeners.delete(cb);
      };
    }, []);
    const setLocation = (to: string) => {
      const [path] = to.split("?");
      wouterState.path = path || "/";
      window.history.replaceState(null, "", to);
      wouterState.listeners.forEach((cb) => cb());
    };
    return [wouterState.path, setLocation];
  };
  return { useLocation };
});

vi.mock("@/lib/useLeaflet", () => ({
  useLeaflet: () => false,
}));

vi.mock("@/lib/supabase", () => ({
  supabase: {},
  fetchTrailsInBbox: vi.fn().mockResolvedValue({ trails: [], usedBbox: false }),
  searchTrails: vi.fn().mockResolvedValue([]),
  saveTrail: vi.fn().mockResolvedValue(true),
  fetchSavedTrails: vi.fn().mockResolvedValue([]),
  fetchTrailGpxByIds: vi.fn().mockResolvedValue([]),
  fetchCommunityTrails: vi.fn().mockResolvedValue([]),
  fetchOwnedTrails: vi.fn().mockResolvedValue([]),
  uploadGpxToStorage: vi.fn(),
  addTrail: vi.fn(),
  updateOwnedTrail: vi.fn(),
  deleteOwnedTrail: vi.fn(),
  replaceOwnedTrailGpx: vi.fn(),
  likeTrail: vi.fn(),
  getSessionId: () => "session_test",
  clearSessionId: () => {},
}));

vi.mock("@/lib/groups", () => ({
  GROUPS_MEMBERSHIP_CHANGED_EVENT: "trailforge:groups-membership-changed",
  emitMembershipChanged: vi.fn(),
  fetchGroupTrails: vi.fn().mockResolvedValue([]),
  setTrailShares: vi.fn().mockResolvedValue(undefined),
  listMyGroups: vi.fn().mockResolvedValue({ groups: [] }),
}));

vi.mock("@/lib/users", () => ({
  syncCurrentUser: vi.fn().mockResolvedValue(null),
}));

vi.mock("@/lib/routing", () => ({
  geocode: vi.fn().mockResolvedValue(null),
  assembleMultiModalRoute: vi.fn(),
  formatDistance: (m: number) => `${m}m`,
  formatKm: (km: number) => `${km}km`,
  formatDurationMin: (min: number) => `${min}min`,
  haversineM: () => 0,
  maneuverArrow: () => "→",
}));

const TRAIL_1 = "11111111-1111-4111-8111-111111111111";
const TRAIL_2 = "22222222-2222-4222-8222-222222222222";

function makeTrail(id: string, name: string) {
  return {
    id,
    user_id: null,
    name,
    type: "singletrack",
    difficulty: 4,
    distance_km: 5.4,
    terrain: "dirt",
    legal_status: "BOAT",
    is_public: true,
    created_at: new Date().toISOString(),
    source: "user",
    verification_status: "verified",
  };
}

/**
 * Mirrors how MainShell picks the active tab from the URL: when MapTab calls
 * `setLocation("/?build=1")` directly (the new behaviour after the cross-tab
 * event bridge was removed), our mocked wouter updates `wouterState.path` and
 * notifies subscribers, so `useLocation` here re-renders with the new path
 * and the harness swaps MapTab for PlannerTab. Keeps the test focused on the
 * handoff contract without dragging in ClerkProvider or the rest of
 * MainShell.
 */
function Harness({
  MapTab,
  PlannerTab,
}: {
  MapTab: React.ComponentType;
  PlannerTab: React.ComponentType;
}) {
  const [path] = useLocation();
  return path === "/map" ? <MapTab /> : <PlannerTab />;
}

beforeEach(() => {
  // The planner-route store reads localStorage at module-load time. Reset the
  // module cache so every test gets a fresh hydration from the seed below.
  vi.resetModules();
  wouterState.path = "/map";
  wouterState.listeners.clear();
  window.history.replaceState(null, "", "/map");
  localStorage.clear();
  localStorage.setItem(
    "trailforge_planner_route",
    JSON.stringify({
      ownerId: null,
      trails: [
        makeTrail(TRAIL_1, "Test Trail A"),
        makeTrail(TRAIL_2, "Test Trail B"),
      ],
    }),
  );
});

afterEach(() => {
  cleanup();
});

describe("Map → Planner Build Route handoff", () => {
  it(
    "shows the route panel from the seeded localStorage route, then on Build Route lands on the Planner with the start address focused and ?build=1 stripped",
    async () => {
      const user = userEvent.setup();

      const MapTab = (await import("@/pages/MapTab")).default;
      const PlannerTab = (await import("@/pages/PlannerTab")).default;
      const { setPlannerRouteUserId } = await import(
        "@/lib/plannerRouteStore"
      );

      // The store holds boot-time data back until Clerk reports who is signed
      // in. Anonymous mode is `null` — surfaces the seeded local route.
      setPlannerRouteUserId(null);

      render(<Harness MapTab={MapTab} PlannerTab={PlannerTab} />);

      // 1. Route panel renders because the seeded route has 2 trails.
      const panel = await screen.findByTestId("map-route-panel");
      expect(
        within(panel).getByTestId("map-route-panel-summary").textContent,
      ).toMatch(/2 Trails/);

      // 2. Expand the panel so the Build Route button is reachable.
      await user.click(screen.getByTestId("map-route-panel-toggle"));
      const buildButton = await screen.findByTestId("map-route-panel-build");

      // 3. Click Build Route — fires the handoff event.
      await user.click(buildButton);

      // 4. Planner is now mounted: the start input is in the DOM and focused.
      const startInput = await screen.findByTestId("planner-start-address");
      await waitFor(() =>
        expect(document.activeElement).toBe(startInput),
      );

      // 5. The mount-effect on PlannerTab strips the build flag from the URL.
      await waitFor(() =>
        expect(window.location.search).not.toContain("build=1"),
      );

      // The Map tab's panel is gone now that we've left the Map tab.
      expect(screen.queryByTestId("map-route-panel")).not.toBeInTheDocument();
    },
  );
});
