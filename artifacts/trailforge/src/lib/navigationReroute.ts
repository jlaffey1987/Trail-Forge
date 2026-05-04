import {
  type GeoPoint,
  type RouteSection,
  type AssembledRoute,
  type RoadRoute,
  getRoadRoute,
  haversineM,
} from "@/lib/routing";

export const OFF_ROUTE_THRESHOLD_M = 50;
export const REROUTE_COOLDOWN_MS = 10_000;
export const MAX_CONSECUTIVE_FAILURES = 3;

export interface RerouteState {
  lastAttemptAt: number;
  consecutiveFailures: number;
  givenUp: boolean;
  status: "idle" | "recalculating" | "rerouted" | "failed" | "given-up";
}

export function initialRerouteState(): RerouteState {
  return {
    lastAttemptAt: 0,
    consecutiveFailures: 0,
    givenUp: false,
    status: "idle",
  };
}

export function isOffRoute(
  userPos: GeoPoint,
  route: AssembledRoute,
): { offRoute: boolean; distanceM: number; nearestSection: RouteSection | null } {
  let bestSection: RouteSection | null = null;
  let bestDistance = Infinity;

  for (const sec of route.sections) {
    let pts: GeoPoint[];
    if (sec.kind === "road") pts = sec.route.polyline;
    else if (sec.kind === "trail") pts = sec.polyline;
    else pts = [sec.point];

    const stride = Math.max(1, Math.floor(pts.length / 30));
    let minD = Infinity;
    for (let i = 0; i < pts.length; i += stride) {
      const d = haversineM(userPos, pts[i]);
      if (d < minD) minD = d;
    }
    if (minD < bestDistance) {
      bestDistance = minD;
      bestSection = sec;
    }
  }

  return {
    offRoute: bestDistance > OFF_ROUTE_THRESHOLD_M,
    distanceM: bestDistance,
    nearestSection: bestSection,
  };
}

export function findRerouteTarget(
  section: RouteSection,
  route: AssembledRoute,
): GeoPoint | null {
  if (section.kind !== "road") return null;

  const sectionIdx = route.sections.indexOf(section);
  if (sectionIdx < 0) return null;

  for (let i = sectionIdx + 1; i < route.sections.length; i++) {
    const next = route.sections[i];
    if (next.kind === "trail") return next.entry;
    if (next.kind === "waypoint") return next.point;
    if (next.kind === "road") return next.from;
  }

  return section.to;
}

export function canAttemptReroute(state: RerouteState, now: number): boolean {
  if (state.givenUp) return false;
  if (state.status === "recalculating") return false;
  if (now - state.lastAttemptAt < REROUTE_COOLDOWN_MS) return false;
  return true;
}

export function shouldAutoReroute(
  nearestSection: RouteSection | null,
  offRoute: boolean,
): { shouldReroute: boolean; isTrailSection: boolean } {
  if (!offRoute || !nearestSection) {
    return { shouldReroute: false, isTrailSection: false };
  }

  if (nearestSection.kind === "trail") {
    return { shouldReroute: false, isTrailSection: true };
  }

  if (nearestSection.kind === "road") {
    return { shouldReroute: true, isTrailSection: false };
  }

  return { shouldReroute: false, isTrailSection: false };
}

export interface RerouteResult {
  success: boolean;
  newRoute?: RoadRoute;
  error?: string;
}

export async function attemptReroute(
  userPos: GeoPoint,
  target: GeoPoint,
  fetchRoute: typeof getRoadRoute = getRoadRoute,
): Promise<RerouteResult> {
  try {
    const newRoute = await fetchRoute([userPos, target]);
    if (!newRoute) {
      return { success: false, error: "No route found" };
    }
    return { success: true, newRoute };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : "Routing request failed",
    };
  }
}

export function spliceReroutedSection(
  route: AssembledRoute,
  oldSection: Extract<RouteSection, { kind: "road" }>,
  newRoute: RoadRoute,
  userPos: GeoPoint,
): AssembledRoute {
  const newSections = route.sections.map((sec) => {
    if (sec !== oldSection) return sec;
    const updated: RouteSection = {
      ...oldSection,
      from: userPos,
      route: newRoute,
      label: `Re-routed: ${userPos.label || "Current location"} → ${oldSection.to.label || "next stop"}`,
    };
    return updated;
  });

  let totalRoadKm = 0;
  let totalRoadDurationMin = 0;
  for (const sec of newSections) {
    if (sec.kind === "road") {
      totalRoadKm += sec.route.distanceKm;
      totalRoadDurationMin += sec.route.durationMin;
    }
  }

  return {
    ...route,
    sections: newSections,
    totalRoadKm,
    totalRoadDurationMin,
    totalDistanceKm: totalRoadKm + route.totalTrailKm,
    totalDurationMin: totalRoadDurationMin + route.totalTrailDurationMin,
  };
}

export function updateRerouteStateOnAttempt(state: RerouteState, now: number): RerouteState {
  return {
    ...state,
    lastAttemptAt: now,
    status: "recalculating",
  };
}

export function updateRerouteStateOnSuccess(state: RerouteState): RerouteState {
  return {
    ...state,
    consecutiveFailures: 0,
    givenUp: false,
    status: "rerouted",
  };
}

export function updateRerouteStateOnFailure(state: RerouteState): RerouteState {
  const failures = state.consecutiveFailures + 1;
  const givenUp = failures >= MAX_CONSECUTIVE_FAILURES;
  return {
    ...state,
    consecutiveFailures: failures,
    givenUp,
    status: givenUp ? "given-up" : "failed",
  };
}

export function resetRerouteState(): RerouteState {
  return initialRerouteState();
}
