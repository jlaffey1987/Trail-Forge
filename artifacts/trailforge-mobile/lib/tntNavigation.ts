/**
 * Trans Northern Trail — precise join, direction, grade bypass, OSRM bridges.
 */
import type { CollectionSectionRow, MapTrail } from "@/lib/api";
import { haversineLatLng, trailMapCoordinates } from "@/lib/geo";
import {
  buildNavRouteAsync,
  orientTrailPath,
  ROAD_CONNECT_THRESHOLD_M,
  type NavRoute,
  type NavRouteInput,
  type NavRouteLeg,
} from "@/lib/navigation";
import type { NavLatLng } from "@/lib/navigationReroute";
import { gradeFromDifficulty } from "@/lib/trailColors";
import { RIDE_LEVELS } from "@/lib/rideLevels";
import {
  pathLengthM,
  snapToPolyline,
  trimPathBackward,
  trimPathForward,
  type PolylineSnap,
} from "@/lib/polylineSnap";

export type TntDirection = "forward" | "reverse";

export interface TntJoinSnap {
  sectionIndex: number;
  snap: PolylineSnap;
  /** True when join section is a road liaison link. */
  isRoad: boolean;
}

export interface TntNavPlan {
  join: TntJoinSnap;
  direction: TntDirection;
  legs: NavRouteLeg[];
  skippedHardSections: number;
  bypassRoadKm: number;
  from: NavLatLng & { label: string };
  to: NavLatLng & { label: string };
}

export interface TntNavPlanResult {
  plan: TntNavPlan;
  routeInput: NavRouteInput;
}

/** Canonical section order from collection rows (or fallback list as-is). */
export function orderedTntTrails(
  rows: CollectionSectionRow[],
  fallback: MapTrail[],
): MapTrail[] {
  if (rows.length) {
    return [...rows]
      .sort((a, b) => a.order_index - b.order_index)
      .map((r) => r.trail)
      .filter(Boolean);
  }
  return fallback;
}

function trailGrade(t: MapTrail): number | null {
  return (
    gradeFromDifficulty(t.difficulty) ??
    gradeFromDifficulty(t.ai_difficulty ?? null)
  );
}

function isRoadSection(t: MapTrail): boolean {
  return t.terrain === "road";
}

/** Exact nearest point on any TNT section polyline. */
export function findTntJoinSnap(sections: MapTrail[], pos: NavLatLng): TntJoinSnap | null {
  let best: TntJoinSnap | null = null;

  for (let i = 0; i < sections.length; i++) {
    const path = trailMapCoordinates(sections[i]);
    const snap = snapToPolyline(path, pos);
    if (!snap) continue;
    if (!best || snap.distanceM < best.snap.distanceM) {
      best = {
        sectionIndex: i,
        snap,
        isRoad: isRoadSection(sections[i]),
      };
    }
  }

  return best;
}

/** Remaining route length from join in each direction (metres). */
export function remainingDistanceM(
  sections: MapTrail[],
  join: TntJoinSnap,
  direction: TntDirection,
): number {
  const { sectionIndex, snap } = join;
  let total = 0;

  if (direction === "forward") {
    total += pathLengthM(trimPathForward(trailMapCoordinates(sections[sectionIndex]), snap));
    for (let i = sectionIndex + 1; i < sections.length; i++) {
      total += pathLengthM(trailMapCoordinates(sections[i]));
    }
  } else {
    total += pathLengthM(trimPathBackward(trailMapCoordinates(sections[sectionIndex]), snap));
    for (let i = sectionIndex - 1; i >= 0; i--) {
      total += pathLengthM(trailMapCoordinates(sections[i]));
    }
  }

  return total;
}

/** Prefer the direction with more riding ahead from an explicit join point. */
export function suggestTntDirectionFromJoin(
  sections: MapTrail[],
  join: TntJoinSnap,
): TntDirection {
  if (sections.length < 2) return "forward";
  const fwd = remainingDistanceM(sections, join, "forward");
  const rev = remainingDistanceM(sections, join, "reverse");
  if (Math.abs(fwd - rev) > 3000) return fwd >= rev ? "forward" : "reverse";
  return fwd >= rev ? "forward" : "reverse";
}

/** Prefer the direction with more riding ahead; tie-break by nearest route end. */
export function suggestTntDirection(sections: MapTrail[], pos: NavLatLng): TntDirection {
  const join = findTntJoinSnap(sections, pos);
  if (!join || sections.length < 2) return "forward";

  const fwd = remainingDistanceM(sections, join, "forward");
  const rev = remainingDistanceM(sections, join, "reverse");
  if (Math.abs(fwd - rev) > 5000) {
    return suggestTntDirectionFromJoin(sections, join);
  }

  const startPts = trailMapCoordinates(sections[0]);
  const endPts = trailMapCoordinates(sections[sections.length - 1]);
  if (startPts.length === 0 || endPts.length === 0) return "forward";

  const dStart = Math.min(
    haversineLatLng(pos, startPts[0]),
    haversineLatLng(pos, startPts[startPts.length - 1]),
  );
  const dEnd = Math.min(
    haversineLatLng(pos, endPts[0]),
    haversineLatLng(pos, endPts[endPts.length - 1]),
  );
  return dEnd < dStart ? "reverse" : "forward";
}

function sectionAllowed(t: MapTrail, maxGrade: number | null): boolean {
  if (isRoadSection(t)) return true;
  if (maxGrade == null) return true;
  const g = trailGrade(t);
  return g == null || g <= maxGrade;
}

function trimJoinSection(
  t: MapTrail,
  snap: PolylineSnap,
  direction: TntDirection,
): NavLatLng[] {
  const path = trailMapCoordinates(t);
  const trimmed =
    direction === "forward"
      ? trimPathForward(path, snap)
      : trimPathBackward(path, snap);
  if (trimmed.length >= 2) return trimmed;
  return path.length >= 2 ? path : trimmed;
}

/**
 * Compile ordered nav legs from join point with grade bypass and road bridges.
 */
export function compileTntLegs(
  sections: MapTrail[],
  join: TntJoinSnap,
  direction: TntDirection,
  maxGrade: number | null,
): { legs: NavRouteLeg[]; skippedHardSections: number; bypassRoadKm: number } {
  const indices: number[] = [];
  if (direction === "forward") {
    for (let i = join.sectionIndex; i < sections.length; i++) indices.push(i);
  } else {
    for (let i = join.sectionIndex; i >= 0; i--) indices.push(i);
  }

  const legs: NavRouteLeg[] = [];
  let lastExit: NavLatLng = join.snap.point;
  let skippedHardSections = 0;
  let bypassRoadKm = 0;
  let afterGradeSkip = false;
  let isFirst = true;

  for (const idx of indices) {
    const t = sections[idx];
    const isRoad = isRoadSection(t);

    if (!isFirst && !isRoad && !sectionAllowed(t, maxGrade)) {
      skippedHardSections += 1;
      afterGradeSkip = true;
      continue;
    }

    let path: NavLatLng[];
    if (isFirst) {
      path = trimJoinSection(t, join.snap, direction);
      isFirst = false;
    } else if (isRoad) {
      if (afterGradeSkip) continue;
      path = orientTrailPath(trailMapCoordinates(t), lastExit);
    } else {
      path = orientTrailPath(trailMapCoordinates(t), lastExit);
    }

    if (path.length < 2) continue;

    const entry = path[0];
    const gapM = haversineLatLng(lastExit, entry);

    if (gapM >= ROAD_CONNECT_THRESHOLD_M) {
      legs.push({
        kind: "road",
        id: `bypass-${t.id}-${legs.length}`,
        name: afterGradeSkip
          ? `Road bypass (${(gapM / 1000).toFixed(1)} km)`
          : `Link to ${t.name}`,
        path: [lastExit, entry],
        isBypass: afterGradeSkip || gapM > 500,
      });
      bypassRoadKm += gapM / 1000;
      afterGradeSkip = false;
    } else {
      afterGradeSkip = false;
    }

    legs.push({
      kind: isRoad ? "road" : "trail",
      id: t.id,
      name: t.name,
      path,
      grade: isRoad ? undefined : trailGrade(t),
    });
    lastExit = path[path.length - 1];
  }

  return { legs, skippedHardSections, bypassRoadKm };
}

export function buildTntNavPlan(params: {
  allTrails: MapTrail[];
  userPos: NavLatLng;
  userLabel?: string;
  direction: TntDirection;
  maxGrade: number | null;
  /** When set, join here instead of nearest snap to userPos. */
  joinOverride?: TntJoinSnap;
}): TntNavPlanResult | null {
  const { allTrails, userPos, direction, maxGrade, joinOverride } = params;
  if (allTrails.length === 0) return null;

  const join = joinOverride ?? findTntJoinSnap(allTrails, userPos);
  if (!join) return null;

  const { legs, skippedHardSections, bypassRoadKm } = compileTntLegs(
    allTrails,
    join,
    direction,
    maxGrade,
  );
  if (legs.length === 0) return null;

  const from = { ...userPos, label: params.userLabel ?? "Current location" };
  const lastLeg = legs[legs.length - 1];
  const to = {
    ...lastLeg.path[lastLeg.path.length - 1],
    label: direction === "forward" ? "Route end" : "Route start",
  };

  const plan: TntNavPlan = {
    join,
    direction,
    legs,
    skippedHardSections,
    bypassRoadKm,
    from,
    to,
  };

  return {
    plan,
    routeInput: { from, to, legs },
  };
}

export async function buildTntNavRouteAsync(
  params: Parameters<typeof buildTntNavPlan>[0],
  signal?: AbortSignal,
): Promise<{ plan: TntNavPlan; routeInput: NavRouteInput; route: NavRoute } | null> {
  const built = buildTntNavPlan(params);
  if (!built) return null;
  const route = await buildNavRouteAsync(built.routeInput, signal);
  return { plan: built.plan, routeInput: built.routeInput, route };
}

export function tntNavPlanToRouteInput(result: TntNavPlanResult): NavRouteInput {
  return result.routeInput;
}

/** @deprecated Use {@link RIDE_LEVELS} from rideLevels.ts */
export const TNT_GRADE_PRESETS = RIDE_LEVELS.map((l) => ({
  label: l.title,
  maxGrade: l.maxGrade,
  description: l.detail,
}));
