import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  isOffRoute,
  shouldAutoReroute,
  canAttemptReroute,
  findRerouteTarget,
  attemptReroute,
  spliceReroutedSection,
  initialRerouteState,
  updateRerouteStateOnAttempt,
  updateRerouteStateOnSuccess,
  updateRerouteStateOnFailure,
  OFF_ROUTE_THRESHOLD_M,
  REROUTE_COOLDOWN_MS,
  MAX_CONSECUTIVE_FAILURES,
  type RerouteState,
} from "@/lib/navigationReroute";
import type { AssembledRoute, RouteSection, GeoPoint, RoadRoute } from "@/lib/routing";

function makeRoadPolyline(baseLat: number, baseLng: number, count: number): GeoPoint[] {
  const pts: GeoPoint[] = [];
  for (let i = 0; i < count; i++) {
    pts.push({ lat: baseLat + i * 0.001, lng: baseLng });
  }
  return pts;
}

function makeTrailPolyline(baseLat: number, baseLng: number, count: number): GeoPoint[] {
  const pts: GeoPoint[] = [];
  for (let i = 0; i < count; i++) {
    pts.push({ lat: baseLat + i * 0.0005, lng: baseLng + i * 0.0005 });
  }
  return pts;
}

function makeRoadSection(index: number, baseLat: number, baseLng: number): Extract<RouteSection, { kind: "road" }> {
  const polyline = makeRoadPolyline(baseLat, baseLng, 20);
  return {
    kind: "road",
    index,
    from: polyline[0],
    to: polyline[polyline.length - 1],
    route: {
      polyline,
      distanceKm: 2.0,
      durationMin: 3.0,
      steps: [
        { instruction: "Depart", maneuver: "depart", distanceM: 500, durationS: 60, location: polyline[0] },
        { instruction: "Turn right", maneuver: "turn", modifier: "right", distanceM: 1000, durationS: 120, location: polyline[10] },
      ],
    },
    label: "Test Road",
  };
}

function makeTrailSection(index: number, baseLat: number, baseLng: number): Extract<RouteSection, { kind: "trail" }> {
  const polyline = makeTrailPolyline(baseLat, baseLng, 20);
  return {
    kind: "trail",
    index,
    trail: {
      id: `trail-${index}`,
      user_id: null,
      name: `Test Trail ${index}`,
      type: "singletrack",
      difficulty: 3,
      distance_km: 1.5,
      terrain: "dirt",
      legal_status: "BOAT",
      is_public: true,
      created_at: "2026-01-01T00:00:00Z",
    },
    polyline,
    distanceKm: 1.5,
    entry: polyline[0],
    exit: polyline[polyline.length - 1],
  };
}

function makeRoute(sections: RouteSection[]): AssembledRoute {
  const first = sections[0];
  const last = sections[sections.length - 1];
  const start = first.kind === "road" ? first.from : first.kind === "trail" ? first.entry : first.point;
  const end = last.kind === "road" ? last.to : last.kind === "trail" ? last.exit : last.point;

  let totalRoadKm = 0;
  let totalTrailKm = 0;
  let totalRoadDurationMin = 0;
  let totalTrailDurationMin = 0;
  for (const s of sections) {
    if (s.kind === "road") {
      totalRoadKm += s.route.distanceKm;
      totalRoadDurationMin += s.route.durationMin;
    } else if (s.kind === "trail") {
      totalTrailKm += s.distanceKm;
      totalTrailDurationMin += (s.distanceKm / 25) * 60;
    }
  }

  return {
    start,
    end,
    sections,
    totalDistanceKm: totalRoadKm + totalTrailKm,
    totalDurationMin: totalRoadDurationMin + totalTrailDurationMin,
    totalRoadKm,
    totalTrailKm,
    totalRoadDurationMin,
    totalTrailDurationMin,
    skippedTrails: [],
    failedRoadSegments: 0,
  };
}

describe("isOffRoute", () => {
  it("returns offRoute=false when user is near the road polyline", () => {
    const roadSec = makeRoadSection(0, 53.0, -2.0);
    const route = makeRoute([roadSec]);
    const userPos: GeoPoint = { lat: 53.005, lng: -2.0 };
    const result = isOffRoute(userPos, route);
    expect(result.offRoute).toBe(false);
    expect(result.nearestSection).toBe(roadSec);
  });

  it("returns offRoute=true when user is far from all sections", () => {
    const roadSec = makeRoadSection(0, 53.0, -2.0);
    const route = makeRoute([roadSec]);
    const userPos: GeoPoint = { lat: 54.0, lng: -1.0 };
    const result = isOffRoute(userPos, route);
    expect(result.offRoute).toBe(true);
    expect(result.distanceM).toBeGreaterThan(OFF_ROUTE_THRESHOLD_M);
  });

  it("identifies nearest section correctly among multiple sections", () => {
    const road = makeRoadSection(0, 53.0, -2.0);
    const trail = makeTrailSection(1, 53.1, -1.9);
    const route = makeRoute([road, trail]);
    const userPos: GeoPoint = { lat: 53.1, lng: -1.9 };
    const result = isOffRoute(userPos, route);
    expect(result.nearestSection).toBe(trail);
  });
});

describe("shouldAutoReroute", () => {
  it("returns shouldReroute=true for off-route road section", () => {
    const roadSec = makeRoadSection(0, 53.0, -2.0);
    const result = shouldAutoReroute(roadSec, true);
    expect(result.shouldReroute).toBe(true);
    expect(result.isTrailSection).toBe(false);
  });

  it("returns shouldReroute=false for off-route trail section", () => {
    const trailSec = makeTrailSection(0, 53.0, -2.0);
    const result = shouldAutoReroute(trailSec, true);
    expect(result.shouldReroute).toBe(false);
    expect(result.isTrailSection).toBe(true);
  });

  it("returns shouldReroute=false when not off-route", () => {
    const roadSec = makeRoadSection(0, 53.0, -2.0);
    const result = shouldAutoReroute(roadSec, false);
    expect(result.shouldReroute).toBe(false);
  });

  it("returns shouldReroute=false when nearestSection is null", () => {
    const result = shouldAutoReroute(null, true);
    expect(result.shouldReroute).toBe(false);
  });
});

describe("canAttemptReroute", () => {
  it("allows attempt on fresh state", () => {
    const state = initialRerouteState();
    expect(canAttemptReroute(state, Date.now())).toBe(true);
  });

  it("blocks during cooldown", () => {
    const state: RerouteState = {
      ...initialRerouteState(),
      lastAttemptAt: Date.now() - 5000,
    };
    expect(canAttemptReroute(state, Date.now())).toBe(false);
  });

  it("allows attempt after cooldown expires", () => {
    const now = Date.now();
    const state: RerouteState = {
      ...initialRerouteState(),
      lastAttemptAt: now - REROUTE_COOLDOWN_MS - 1,
    };
    expect(canAttemptReroute(state, now)).toBe(true);
  });

  it("blocks when given up", () => {
    const state: RerouteState = {
      ...initialRerouteState(),
      givenUp: true,
      consecutiveFailures: MAX_CONSECUTIVE_FAILURES,
    };
    expect(canAttemptReroute(state, Date.now())).toBe(false);
  });

  it("blocks during recalculating", () => {
    const state: RerouteState = {
      ...initialRerouteState(),
      status: "recalculating",
    };
    expect(canAttemptReroute(state, Date.now())).toBe(false);
  });
});

describe("findRerouteTarget", () => {
  it("returns the next trail entry as the target", () => {
    const road = makeRoadSection(0, 53.0, -2.0);
    const trail = makeTrailSection(1, 53.02, -1.98);
    const route = makeRoute([road, trail]);
    const target = findRerouteTarget(road, route);
    expect(target).toEqual(trail.entry);
  });

  it("returns section.to when there is no next section", () => {
    const road = makeRoadSection(0, 53.0, -2.0);
    const route = makeRoute([road]);
    const target = findRerouteTarget(road, route);
    expect(target).toEqual(road.to);
  });

  it("returns null for trail sections", () => {
    const trail = makeTrailSection(0, 53.0, -2.0);
    const route = makeRoute([trail]);
    const target = findRerouteTarget(trail, route);
    expect(target).toBeNull();
  });
});

describe("attemptReroute", () => {
  it("calls OSRM and returns success on valid route", async () => {
    const newRoute: RoadRoute = {
      polyline: [{ lat: 54.0, lng: -1.0 }, { lat: 53.02, lng: -1.98 }],
      distanceKm: 1.5,
      durationMin: 2.0,
      steps: [],
    };
    const mockFetch = vi.fn().mockResolvedValue(newRoute);
    const result = await attemptReroute(
      { lat: 54.0, lng: -1.0 },
      { lat: 53.02, lng: -1.98 },
      mockFetch,
    );
    expect(result.success).toBe(true);
    expect(result.newRoute).toEqual(newRoute);
    expect(mockFetch).toHaveBeenCalledWith([
      { lat: 54.0, lng: -1.0 },
      { lat: 53.02, lng: -1.98 },
    ]);
  });

  it("returns failure when OSRM returns null", async () => {
    const mockFetch = vi.fn().mockResolvedValue(null);
    const result = await attemptReroute(
      { lat: 54.0, lng: -1.0 },
      { lat: 53.02, lng: -1.98 },
      mockFetch,
    );
    expect(result.success).toBe(false);
    expect(mockFetch).toHaveBeenCalled();
  });

  it("returns failure when OSRM throws", async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error("Network error"));
    const result = await attemptReroute(
      { lat: 54.0, lng: -1.0 },
      { lat: 53.02, lng: -1.98 },
      mockFetch,
    );
    expect(result.success).toBe(false);
    expect(result.error).toBe("Network error");
  });
});

describe("spliceReroutedSection", () => {
  it("replaces the road section route with the new one", () => {
    const road = makeRoadSection(0, 53.0, -2.0);
    const trail = makeTrailSection(1, 53.02, -1.98);
    const route = makeRoute([road, trail]);

    const newRoute: RoadRoute = {
      polyline: [{ lat: 54.0, lng: -1.0 }, { lat: 53.02, lng: -1.98 }],
      distanceKm: 3.0,
      durationMin: 5.0,
      steps: [],
    };
    const userPos: GeoPoint = { lat: 54.0, lng: -1.0 };
    const updated = spliceReroutedSection(route, road, newRoute, userPos);

    const updatedRoad = updated.sections[0] as Extract<RouteSection, { kind: "road" }>;
    expect(updatedRoad.route).toBe(newRoute);
    expect(updatedRoad.from).toBe(userPos);
    expect(updated.totalRoadKm).toBe(3.0);
    expect(updated.totalTrailKm).toBe(trail.distanceKm);
  });
});

describe("reroute state machine", () => {
  it("tracks consecutive failures and gives up after max", () => {
    let state = initialRerouteState();
    for (let i = 0; i < MAX_CONSECUTIVE_FAILURES; i++) {
      state = updateRerouteStateOnAttempt(state, Date.now());
      state = updateRerouteStateOnFailure(state);
    }
    expect(state.givenUp).toBe(true);
    expect(state.consecutiveFailures).toBe(MAX_CONSECUTIVE_FAILURES);
    expect(state.status).toBe("given-up");
  });

  it("resets consecutive failures on success", () => {
    let state = initialRerouteState();
    state = updateRerouteStateOnAttempt(state, Date.now());
    state = updateRerouteStateOnFailure(state);
    state = updateRerouteStateOnAttempt(state, Date.now());
    state = updateRerouteStateOnFailure(state);
    expect(state.consecutiveFailures).toBe(2);

    state = updateRerouteStateOnAttempt(state, Date.now());
    state = updateRerouteStateOnSuccess(state);
    expect(state.consecutiveFailures).toBe(0);
    expect(state.givenUp).toBe(false);
    expect(state.status).toBe("rerouted");
  });
});

describe("road vs trail off-route integration", () => {
  it("triggers OSRM re-route for road section drift", async () => {
    const road = makeRoadSection(0, 53.0, -2.0);
    const route = makeRoute([road]);

    const driftedUser: GeoPoint = { lat: 54.0, lng: -1.0 };
    const offRouteResult = isOffRoute(driftedUser, route);
    expect(offRouteResult.offRoute).toBe(true);

    const autoResult = shouldAutoReroute(offRouteResult.nearestSection, offRouteResult.offRoute);
    expect(autoResult.shouldReroute).toBe(true);
    expect(autoResult.isTrailSection).toBe(false);

    const target = findRerouteTarget(offRouteResult.nearestSection!, route);
    expect(target).not.toBeNull();

    const mockRoute: RoadRoute = {
      polyline: [driftedUser, target!],
      distanceKm: 5.0,
      durationMin: 8.0,
      steps: [],
    };
    const mockFetch = vi.fn().mockResolvedValue(mockRoute);
    const rerouteResult = await attemptReroute(driftedUser, target!, mockFetch);
    expect(rerouteResult.success).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("does NOT trigger OSRM re-route for trail section drift", () => {
    const trail = makeTrailSection(0, 53.0, -2.0);
    const route = makeRoute([trail]);

    const driftedUser: GeoPoint = { lat: 54.0, lng: -1.0 };
    const offRouteResult = isOffRoute(driftedUser, route);
    expect(offRouteResult.offRoute).toBe(true);

    const autoResult = shouldAutoReroute(offRouteResult.nearestSection, offRouteResult.offRoute);
    expect(autoResult.shouldReroute).toBe(false);
    expect(autoResult.isTrailSection).toBe(true);
  });
});
