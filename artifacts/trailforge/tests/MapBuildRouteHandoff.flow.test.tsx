import { describe, it, beforeEach, afterEach, vi, expect } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import React, { useEffect, useState } from "react";

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

vi.mock("wouter", () => ({
  useLocation: () => ["/", () => {}],
}));

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
 * Mirrors the App.tsx `trailforge:open-planner` bridge: when MapTab fires the
 * event we set `?build=1` on the URL and switch which page renders. Keeps the
 * test focused on the handoff contract without dragging in ClerkProvider,
 * wouter routing, or the rest of MainShell.
 */
function Harness({
  MapTab,
  PlannerTab,
}: {
  MapTab: React.ComponentType;
  PlannerTab: React.ComponentType;
}) {
  const [tab, setTab] = useState<"map" | "planner">("map");
  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ build?: boolean }>).detail ?? {};
      const params = new URLSearchParams(window.location.search);
      if (detail.build) params.set("build", "1");
      const qs = params.toString();
      window.history.replaceState(
        null,
        "",
        `${window.location.pathname}${qs ? `?${qs}` : ""}`,
      );
      setTab("planner");
    };
    window.addEventListener(
      "trailforge:open-planner",
      handler as EventListener,
    );
    return () =>
      window.removeEventListener(
        "trailforge:open-planner",
        handler as EventListener,
      );
  }, []);
  return tab === "map" ? <MapTab /> : <PlannerTab />;
}

beforeEach(() => {
  // The planner-route store reads localStorage at module-load time. Reset the
  // module cache so every test gets a fresh hydration from the seed below.
  vi.resetModules();
  window.history.replaceState(null, "", "/");
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
