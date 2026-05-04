import { describe, it, beforeEach, afterEach, vi, expect } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import React from "react";

const TRAIL_ID = "aaaa1111-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TRAIL_NO_GROUPS_ID = "bbbb2222-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const GROUP_ALPHA = { id: "group-alpha-id", name: "Alpha Riders" };
const GROUP_BETA = { id: "group-beta-id", name: "Beta Trails" };
const VIEWER_ID = "user_viewer_badges";

function baseTrailFields(overrides: Record<string, unknown> = {}) {
  return {
    user_id: null,
    owner_user_id: "user_owner_other",
    type: "singletrack",
    difficulty: 5,
    distance_km: 10,
    terrain: "dirt",
    legal_status: "BOAT",
    is_public: true,
    created_at: "2026-01-15T12:00:00Z",
    source: "user",
    verification_status: "verified",
    ...overrides,
  };
}

describe("renderTrailLayer — shared-group badge markers on the map", () => {
  let leafletStubs: {
    markers: Array<{
      latlng: [number, number];
      icon: { className: string; html: string };
      options: Record<string, unknown>;
      events: Record<string, (() => void)[]>;
    }>;
    polylines: unknown[];
  };

  function makeLeafletStub() {
    const markers: typeof leafletStubs.markers = [];
    const polylines: unknown[] = [];

    const polyline = (_latlngs: unknown, _opts?: unknown) => {
      const p: Record<string, unknown> = {};
      p.addTo = () => { polylines.push(p); return p; };
      p.remove = () => {};
      p.on = () => p;
      p.setStyle = () => {};
      return p;
    };

    const marker = (latlng: [number, number], opts?: Record<string, unknown>) => {
      const m: Record<string, unknown> = {
        options: { ...(opts ?? {}) },
      };
      const events: Record<string, (() => void)[]> = {};
      let capturedIcon: { className: string; html: string } | undefined;
      if (opts?.icon) capturedIcon = opts.icon as typeof capturedIcon;
      m.addTo = () => {
        markers.push({
          latlng,
          icon: capturedIcon ?? { className: "", html: "" },
          options: m.options as Record<string, unknown>,
          events,
        });
        return m;
      };
      m.on = (evt: string, cb: () => void) => {
        if (!events[evt]) events[evt] = [];
        events[evt].push(cb);
        return m;
      };
      m.remove = () => {};
      m.bindPopup = () => m;
      return m;
    };

    const divIcon = (opts: { html: string; className: string; iconSize: unknown; iconAnchor: unknown }) => ({
      html: opts.html,
      className: opts.className ?? "",
      iconSize: opts.iconSize,
      iconAnchor: opts.iconAnchor,
    });

    const map = {
      on: () => map,
      off: () => {},
      remove: () => {},
      invalidateSize: () => {},
      getZoom: () => 12,
      getBounds: () => ({
        getSouth: () => 0,
        getNorth: () => 1,
        getWest: () => 0,
        getEast: () => 1,
      }),
      createPane: () => {},
      getPane: () => ({ style: {} }),
    };

    const L = {
      map: () => map,
      tileLayer: () => ({ addTo: () => ({}) }),
      marker,
      polyline,
      divIcon,
      latLng: (a: number, b: number) => ({ lat: a, lng: b, distanceTo: () => 100 }),
      latLngBounds: () => ({}),
    } as unknown as typeof window.L;

    return { L, map: map as unknown as import("leaflet").Map, markers, polylines };
  }

  beforeEach(() => {
    leafletStubs = { markers: [], polylines: [] };
    const stub = makeLeafletStub();
    leafletStubs = stub;
    (window as unknown as { L: unknown }).L = stub.L;
  });

  afterEach(() => {
    delete (window as unknown as { L?: unknown }).L;
  });

  it("creates a badge marker with trail-shared-group-badge className for a trail with shared_groups", async () => {
    const { renderTrailLayer } = await import("@/lib/trailLayer");

    const trail = {
      id: TRAIL_ID,
      name: "Group Trail",
      ...baseTrailFields(),
      gpx_data: null,
      path_geojson: {
        type: "LineString",
        coordinates: [
          [-2.0, 53.0],
          [-1.9, 53.1],
          [-1.8, 53.2],
        ],
      },
      shared_groups: [GROUP_ALPHA],
    } as unknown as import("@/lib/supabase").Trail;

    renderTrailLayer(leafletStubs.map as unknown as import("leaflet").Map, [trail], {
      showSharedGroupBadges: true,
    });

    const badgeMarkers = leafletStubs.markers.filter(
      (m) => m.icon.className === "trail-shared-group-badge",
    );
    expect(badgeMarkers).toHaveLength(1);
    expect(badgeMarkers[0]!.options.alt).toBe(`shared-group:${TRAIL_ID}`);
    expect(badgeMarkers[0]!.icon.html).toContain("Shared via Alpha Riders");
  });

  it("renders badges for multiple groups on the same trail", async () => {
    const { renderTrailLayer } = await import("@/lib/trailLayer");

    const trail = {
      id: TRAIL_ID,
      name: "Multi-Group Trail",
      ...baseTrailFields(),
      gpx_data: null,
      path_geojson: {
        type: "LineString",
        coordinates: [
          [-2.0, 53.0],
          [-1.9, 53.1],
          [-1.8, 53.2],
        ],
      },
      shared_groups: [GROUP_ALPHA, GROUP_BETA],
    } as unknown as import("@/lib/supabase").Trail;

    renderTrailLayer(leafletStubs.map as unknown as import("leaflet").Map, [trail], {
      showSharedGroupBadges: true,
    });

    const badgeMarkers = leafletStubs.markers.filter(
      (m) => m.icon.className === "trail-shared-group-badge",
    );
    expect(badgeMarkers).toHaveLength(1);
    expect(badgeMarkers[0]!.icon.html).toContain("Shared via Alpha Riders");
    expect(badgeMarkers[0]!.icon.html).toContain("+1");
  });

  it("does NOT create a badge marker when shared_groups is empty", async () => {
    const { renderTrailLayer } = await import("@/lib/trailLayer");

    const trail = {
      id: TRAIL_NO_GROUPS_ID,
      name: "Public Trail",
      ...baseTrailFields(),
      gpx_data: null,
      path_geojson: {
        type: "LineString",
        coordinates: [
          [-2.0, 53.0],
          [-1.9, 53.1],
          [-1.8, 53.2],
        ],
      },
      shared_groups: [],
    } as unknown as import("@/lib/supabase").Trail;

    renderTrailLayer(leafletStubs.map as unknown as import("leaflet").Map, [trail], {
      showSharedGroupBadges: true,
    });

    const badgeMarkers = leafletStubs.markers.filter(
      (m) => m.icon.className === "trail-shared-group-badge",
    );
    expect(badgeMarkers).toHaveLength(0);
  });

  it("does NOT create a badge marker when showSharedGroupBadges is false", async () => {
    const { renderTrailLayer } = await import("@/lib/trailLayer");

    const trail = {
      id: TRAIL_ID,
      name: "Group Trail Hidden Badge",
      ...baseTrailFields(),
      gpx_data: null,
      path_geojson: {
        type: "LineString",
        coordinates: [
          [-2.0, 53.0],
          [-1.9, 53.1],
          [-1.8, 53.2],
        ],
      },
      shared_groups: [GROUP_ALPHA],
    } as unknown as import("@/lib/supabase").Trail;

    renderTrailLayer(leafletStubs.map as unknown as import("leaflet").Map, [trail], {
      showSharedGroupBadges: false,
    });

    const badgeMarkers = leafletStubs.markers.filter(
      (m) => m.icon.className === "trail-shared-group-badge",
    );
    expect(badgeMarkers).toHaveLength(0);
  });
});

vi.mock("@clerk/react", () => ({
  useUser: () => ({
    isLoaded: true,
    isSignedIn: true,
    user: {
      id: VIEWER_ID,
      primaryEmailAddress: { emailAddress: "viewer@example.com" },
      emailAddresses: [{ emailAddress: "viewer@example.com" }],
      firstName: "View",
      lastName: "Er",
      fullName: "View Er",
      username: "viewer",
      imageUrl: null,
    },
  }),
}));

vi.mock("wouter", () => ({
  useLocation: () => ["/discover", vi.fn()],
  useSearch: () => "",
}));

vi.mock("@/lib/supabase", () => ({
  supabase: {},
  fetchCommunityTrails: vi.fn().mockResolvedValue([]),
  saveTrail: vi.fn().mockResolvedValue(true),
  fetchTrailGpxByIds: vi.fn().mockResolvedValue([]),
  isSyntheticPlaceholderTrail: () => false,
}));

vi.mock("@/lib/users", () => ({
  syncCurrentUser: vi.fn().mockResolvedValue({
    id: VIEWER_ID,
    email: "viewer@example.com",
    display_name: "View Er",
    avatar_url: null,
    created_at: new Date().toISOString(),
  }),
}));

vi.mock("@/lib/plannerRouteStore", () => ({
  isInRoute: () => false,
  addRouteTrail: vi.fn(),
  removeRouteTrail: vi.fn(),
  subscribeRouteTrails: () => () => {},
  getRouteTrails: () => [],
  PLANNER_MAX_TRAILS: 20,
}));

vi.mock("@/lib/publishedRoutes", () => ({
  listPublishedRoutes: vi.fn().mockResolvedValue([]),
}));

vi.mock("@/lib/completionsStore", () => ({
  markCompleted: vi.fn().mockResolvedValue(true),
  unmarkCompleted: vi.fn().mockResolvedValue(true),
  useCompletionIds: () => new Set<string>(),
  useCompletionState: () => ({ completed: false }),
}));

const sharedTrailWithGroups = {
  id: TRAIL_ID,
  name: "Shared Group Trail",
  ...baseTrailFields(),
  gpx_data: null,
  shared_groups: [GROUP_ALPHA, GROUP_BETA],
};

const trailWithoutGroups = {
  id: TRAIL_NO_GROUPS_ID,
  name: "Public Only Trail",
  ...baseTrailFields(),
  gpx_data: null,
  shared_groups: [],
};

vi.mock("@/lib/groups", () => ({
  GROUPS_MEMBERSHIP_CHANGED_EVENT: "trailforge:groups-membership-changed",
  fetchGroupTrails: vi.fn().mockResolvedValue([sharedTrailWithGroups]),
  groupCoverPhotoUrl: () => null,
  listDiscoverableGroups: vi.fn().mockResolvedValue([]),
  requestToJoinGroup: vi.fn(),
}));

vi.mock("@/lib/trailContent", () => ({
  fetchTrailActivityCounts: vi.fn().mockResolvedValue({}),
  fetchTrailPermissions: vi.fn().mockResolvedValue({
    isOwner: false,
    isModerator: false,
    canModerate: false,
  }),
}));

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

let fetchSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  fetchSpy = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (input: RequestInfo | URL) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      const u = new URL(url, "http://test.local");
      const path = u.pathname;

      if (path === "/api/admin/whoami") return jsonResponse({ isAdmin: false });
      if (path === "/api/trails/activity-counts")
        return jsonResponse({ counts: {} });
      if (path.match(/\/api\/trails\/[^/]+\/permissions$/))
        return jsonResponse({
          isOwner: false,
          isModerator: false,
          canModerate: false,
        });
      if (path.match(/\/api\/trails\/[^/]+\/shares$/))
        return jsonResponse({ items: [] });
      if (path === "/api/me/group-trails")
        return jsonResponse({ items: [sharedTrailWithGroups] });
      return jsonResponse({});
    });
});

afterEach(() => {
  fetchSpy.mockRestore();
  cleanup();
});

describe("DiscoverTab — shared-group badge on trail cards", () => {
  it("renders a discover-card-group pill for a trail with shared_groups", async () => {
    const { default: DiscoverTab } = await import("@/pages/DiscoverTab");

    render(<DiscoverTab />);

    await waitFor(() =>
      expect(
        screen.getByTestId(`discover-card-group-${TRAIL_ID}`),
      ).toBeInTheDocument(),
    );

    const pill = screen.getByTestId(`discover-card-group-${TRAIL_ID}`);
    expect(pill).toHaveTextContent("Alpha Riders");
    expect(pill).toHaveTextContent("+1");
    expect(pill).toHaveAttribute(
      "title",
      "Shared via Alpha Riders, Beta Trails",
    );
  });

  it("does NOT render a discover-card-group pill for a trail without shared_groups", async () => {
    const groupsMock = await import("@/lib/groups");
    vi.mocked(groupsMock.fetchGroupTrails).mockResolvedValueOnce([
      trailWithoutGroups as never,
    ]);

    const { default: DiscoverTab } = await import("@/pages/DiscoverTab");
    render(<DiscoverTab />);

    await waitFor(() =>
      expect(
        screen.getByTestId(`discover-card-${TRAIL_NO_GROUPS_ID}`),
      ).toBeInTheDocument(),
    );

    expect(
      screen.queryByTestId(`discover-card-group-${TRAIL_NO_GROUPS_ID}`),
    ).not.toBeInTheDocument();
  });
});

describe("TrailDetailSheet — shared-group pills in the detail view", () => {
  it("renders trail-detail-shared-groups container and individual group pills", async () => {
    const { default: TrailDetailSheet } = await import(
      "@/components/TrailDetailSheet"
    );

    render(
      <TrailDetailSheet
        trail={sharedTrailWithGroups as never}
        onClose={() => {}}
      />,
    );

    await waitFor(() =>
      expect(
        screen.getByTestId("trail-detail-shared-groups"),
      ).toBeInTheDocument(),
    );

    expect(
      screen.getByTestId(`trail-detail-shared-group-${GROUP_ALPHA.id}`),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId(`trail-detail-shared-group-${GROUP_BETA.id}`),
    ).toBeInTheDocument();

    const alphaPill = screen.getByTestId(
      `trail-detail-shared-group-${GROUP_ALPHA.id}`,
    );
    expect(alphaPill).toHaveTextContent("Alpha Riders");
    expect(alphaPill).toHaveAttribute("title", "Shared into Alpha Riders");

    const betaPill = screen.getByTestId(
      `trail-detail-shared-group-${GROUP_BETA.id}`,
    );
    expect(betaPill).toHaveTextContent("Beta Trails");
  });

  it("does NOT render shared-group container when trail has no shared_groups", async () => {
    const { default: TrailDetailSheet } = await import(
      "@/components/TrailDetailSheet"
    );

    render(
      <TrailDetailSheet
        trail={trailWithoutGroups as never}
        onClose={() => {}}
      />,
    );

    await waitFor(() =>
      expect(screen.getByTestId("trail-detail-name")).toBeInTheDocument(),
    );

    expect(
      screen.queryByTestId("trail-detail-shared-groups"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId(`trail-detail-shared-group-${GROUP_ALPHA.id}`),
    ).not.toBeInTheDocument();
  });
});
