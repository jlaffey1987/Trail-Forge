import { describe, it, beforeEach, afterEach, vi, expect } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import React from "react";
import { useLocation } from "wouter";

vi.mock("@clerk/react", () => ({
  useUser: () => ({ isLoaded: true, isSignedIn: false, user: null }),
}));

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
  const useSearch = (): string => {
    return window.location.search.replace(/^\?/, "");
  };
  return { useLocation, useSearch };
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
  fetchTrailGpxByIds: vi.fn().mockResolvedValue(new Map()),
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

vi.mock("@/components/NavigationView", () => ({
  default: () => {
    const reactMod = require("react");
    return reactMod.createElement("div", { "data-testid": "navigation-view" }, "Navigation View");
  },
  formatKm: (km: number) => `${km}km`,
  formatDurationMin: (min: number) => `${min}min`,
}));

const TRAIL_1 = "11111111-1111-4111-8111-111111111111";
const TRAIL_2 = "22222222-2222-4222-8222-222222222222";

const mockSearchTrails = vi.fn().mockResolvedValue({
  results: [
    {
      id: TRAIL_1,
      name: "Alpine Ridge Trail",
      type: "singletrack",
      difficulty: 4,
      distance_km: 5.4,
      terrain: "dirt",
      legal_status: "BOAT",
      is_public: true,
      verification_status: "verified",
      source_region: "Swiss Alps",
      path_geojson: { type: "LineString", coordinates: [[-1, 51], [-0.9, 51.1]] },
    },
    {
      id: TRAIL_2,
      name: "Alpine Valley Loop",
      type: "singletrack",
      difficulty: 6,
      distance_km: 8.2,
      terrain: "rocky",
      legal_status: "BOAT",
      is_public: true,
      verification_status: "verified",
      source_region: "Swiss Alps",
      path_geojson: { type: "LineString", coordinates: [[-1, 52], [-0.9, 52.1]] },
    },
  ],
});

vi.mock("@workspace/api-client-react", () => ({
  searchTrails: (...args: unknown[]) => mockSearchTrails(...args),
}));

const mockAssemble = vi.fn().mockResolvedValue({
  start: { lat: 51, lng: -1, label: "Start" },
  end: null,
  sections: [
    { kind: "trail", index: 0, trail: { id: TRAIL_1, name: "Alpine Ridge Trail" }, polyline: [], distanceKm: 5, entry: { lat: 51, lng: -1 }, exit: { lat: 51.1, lng: -0.9 } },
    { kind: "road", index: 1, from: { lat: 51.1, lng: -0.9 }, to: { lat: 52, lng: -1 }, route: { polyline: [], distanceKm: 100, durationMin: 60, steps: [] }, label: "Road" },
    { kind: "trail", index: 2, trail: { id: TRAIL_2, name: "Alpine Valley Loop" }, polyline: [], distanceKm: 5, entry: { lat: 52, lng: -1 }, exit: { lat: 52.1, lng: -0.9 } },
  ],
  totalDistanceKm: 110,
  totalDurationMin: 120,
  totalRoadKm: 100,
  totalTrailKm: 10,
  totalRoadDurationMin: 60,
  totalTrailDurationMin: 60,
  skippedTrails: [],
  failedRoadSegments: 0,
});

vi.mock("@/lib/routing", () => ({
  geocode: vi.fn().mockResolvedValue(null),
  reverseGeocode: vi.fn().mockResolvedValue(null),
  assembleMultiModalRoute: (...args: unknown[]) => mockAssemble(...args),
  orderTrailsNearestNeighbour: (_start: unknown, trails: unknown[]) => trails,
  formatDistance: (m: number) => `${m}m`,
  formatKm: (km: number) => `${km}km`,
  formatDurationMin: (min: number) => `${min}min`,
  haversineM: () => 0,
  maneuverArrow: () => "→",
  HYBRID_LABEL_TILE_URL: "",
  HYBRID_LABEL_TILE_ATTRIBUTION: "",
}));

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
  vi.resetModules();
  wouterState.path = "/map";
  wouterState.listeners.clear();
  window.history.replaceState(null, "", "/map");
  localStorage.clear();
  sessionStorage.clear();
});

afterEach(() => {
  cleanup();
  mockAssemble.mockClear();
  mockSearchTrails.mockClear();
});

describe("Map → Search, add trails, build route", () => {
  it(
    "searches for trails, adds two from results, then auto-routes to Planner",
    async () => {
      const user = userEvent.setup();

      const MapTab = (await import("@/pages/MapTab")).default;
      const PlannerTab = (await import("@/pages/PlannerTab")).default;
      const { setPlannerRouteUserId } = await import(
        "@/lib/plannerRouteStore"
      );
      const { setMapSelectionUserId } = await import(
        "@/lib/mapSelectionStore"
      );
      setPlannerRouteUserId(null);
      setMapSelectionUserId(null);

      render(<Harness MapTab={MapTab} PlannerTab={PlannerTab} />);

      const searchInput = await screen.findByTestId("map-trail-search-input");
      await user.type(searchInput, "Alpine");

      await waitFor(() => {
        expect(mockSearchTrails).toHaveBeenCalledWith(
          expect.objectContaining({ q: "Alpine" }),
        );
      });

      const resultsList = await screen.findByTestId("map-trail-search-results");
      expect(resultsList).toBeInTheDocument();

      const addBtn1 = await screen.findByTestId(`map-search-toggle-${TRAIL_1}`);
      await user.click(addBtn1);

      const addBtn2 = await screen.findByTestId(`map-search-toggle-${TRAIL_2}`);
      await user.click(addBtn2);

      const panel = await screen.findByTestId("map-route-panel");
      expect(
        within(panel).getByTestId("map-route-panel-summary").textContent,
      ).toMatch(/2 Trails/);

      await user.click(screen.getByTestId("map-route-panel-toggle"));
      const buildButton = await screen.findByTestId("map-route-panel-build");
      await user.click(buildButton);

      const chooser = await screen.findByTestId("start-chooser");
      const firstTrailBtn = within(chooser).getByTestId("start-chooser-first");
      await user.click(firstTrailBtn);

      await waitFor(() => {
        expect(mockAssemble).toHaveBeenCalled();
      });

      expect(mockAssemble).toHaveBeenCalledWith(
        expect.objectContaining({ lat: expect.any(Number), lng: expect.any(Number) }),
        null,
        expect.any(Array),
        expect.any(Function),
      );

      await waitFor(() => {
        expect(wouterState.path).toBe("/");
      });
    },
  );
});
