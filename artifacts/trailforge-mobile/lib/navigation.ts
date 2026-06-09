/**
 * Navigation engine for TrailForge mobile.
 *
 * Converts a planned route (from/to + selected trail polylines) into a
 * navigable structure, tracks progress against GPS position, and generates
 * turn-by-turn instructions that understand the transition between road and
 * off-road trail sections.
 *
 * Design:
 *   1. buildNavRoute()   — assemble sections from trail data + road connectors
 *   2. computeProgress() — snap user position to route, compute remaining dist
 *   3. getInstruction()  — determine next instruction from progress
 *   4. Camera helpers    — heading-up offset centre for bottom-third positioning
 */

import { haversineM, bearingDeg, fetchRoadRoute, type NavLatLng, type RoadRouteStep } from "./navigationReroute";
import { gradeFromDifficulty, type TrailDifficulty } from "./trailColors";
import { trailMapCoordinates, type TrailPathSource } from "./geo";
import { closestPointOnSegment, pathLengthM } from "./polylineSnap";

/** Minimum gap (m) before inserting a road connector between legs. */
export const ROAD_CONNECT_THRESHOLD_M = 80;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface NavTrailInput {
  id: string;
  name: string;
  difficulty: TrailDifficulty;
  distance_km: number | null;
  /** GeoJSON [lon, lat] pairs, path_geojson, or simplified_path from the API. */
  path?: unknown;
  path_geojson?: { type: string; coordinates: Array<[number, number]> } | null;
  simplified_path?: string | null;
  /** Pre-trimmed path (e.g. mid-section TNT join). Takes precedence over trail geometry. */
  pathOverride?: NavLatLng[];
}

/** Explicit ordered leg — trail or road — for collection routes like TNT. */
export interface NavRouteLeg {
  kind: NavSectionKind;
  id: string;
  name: string;
  path: NavLatLng[];
  difficulty?: TrailDifficulty;
  grade?: number | null;
  /** Road leg inserted to bypass a filtered trail section. */
  isBypass?: boolean;
}

export interface NavRouteInput {
  from: NavLatLng & { label: string };
  to: NavLatLng & { label: string };
  /** Legacy: trail-only list with auto road connectors. */
  trails?: NavTrailInput[];
  /** Preferred: fully ordered legs including TNT road links and bypasses. */
  legs?: NavRouteLeg[];
}

// ---------------------------------------------------------------------------

export type InstructionIcon =
  | "straight"
  | "turn-left"
  | "turn-right"
  | "u-turn"
  | "enter-trail"
  | "exit-trail"
  | "arrive"
  | "start";

export interface NavInstruction {
  /** Full text for display panel and TTS. */
  text: string;
  /** Short text for the next-instruction preview. */
  shortText: string;
  icon: InstructionIcon;
  /** Distance from route start at which this instruction fires. */
  triggerDistanceM: number;
  /** Trail name if entering a trail section. */
  trailName?: string;
  /** Numeric grade (1-10) if entering a trail section. */
  grade?: number | null;
}

export type NavSectionKind = "road" | "trail";

export interface NavSection {
  kind: NavSectionKind;
  id: string;
  name: string;
  grade?: number | null;
  path: NavLatLng[];
  distanceM: number;
  /** Cumulative distance from route START to end of this section. */
  cumulativeDistanceM: number;
  /** OSRM turn-by-turn for road sections. */
  osrmSteps?: RoadRouteStep[];
}

export interface NavRoute {
  from: NavLatLng & { label: string };
  to: NavLatLng & { label: string };
  sections: NavSection[];
  /** Flat polyline (all sections concatenated, used for snap-to-route). */
  polyline: NavLatLng[];
  /** Per-polyline-point: index of its parent section. */
  polylineSection: number[];
  totalDistanceM: number;
  instructions: NavInstruction[];
  /** Some road legs used straight-line fallback (OSRM unavailable). */
  routingDegraded?: boolean;
}

export interface NavProgress {
  distanceTravelledM: number;
  distanceRemainingM: number;
  /** Index into route.sections of the section the user is currently in. */
  currentSectionIdx: number;
  /** Index into route.instructions of the NEXT instruction to deliver. */
  nextInstructionIdx: number;
  isOnTrail: boolean;
  arrived: boolean;
  speedKmh: number;
  etaMin: number;
  /** IDs of sections the user has passed through (for greying them out). */
  completedSectionIds: string[];
}

// gradeFromDifficulty and gradeToColor are imported from lib/trailColors.

// ---------------------------------------------------------------------------
// Route builder
// ---------------------------------------------------------------------------

function parseTrailPath(trail: TrailPathSource & { pathOverride?: NavLatLng[] }): NavLatLng[] {
  if (trail.pathOverride?.length) return trail.pathOverride;
  return trailMapCoordinates(trail);
}

function polylineLength(pts: NavLatLng[]): number {
  return pathLengthM(pts);
}

/** Orient a trail path so the nearest endpoint to `approach` is the entry. */
export function orientTrailPath(path: NavLatLng[], approach: NavLatLng): NavLatLng[] {
  if (path.length <= 1) return path;
  const first = path[0];
  const last = path[path.length - 1];
  const dFirst = haversineM(approach, first);
  const dLast = haversineM(approach, last);
  return dFirst <= dLast ? path : [...path].reverse();
}

function finalizeNavRoute(
  from: NavRouteInput["from"],
  to: NavRouteInput["to"],
  sections: NavSection[],
): NavRoute {
  const polyline: NavLatLng[] = [];
  const polylineSection: number[] = [];
  for (let si = 0; si < sections.length; si++) {
    for (const pt of sections[si].path) {
      polyline.push(pt);
      polylineSection.push(si);
    }
  }
  const totalDistanceM = sections.length
    ? sections[sections.length - 1].cumulativeDistanceM
    : 0;
  const instructions = buildInstructions(sections, totalDistanceM);
  return { from, to, sections, polyline, polylineSection, totalDistanceM, instructions };
}

function appendSection(
  sections: NavSection[],
  cumulative: { value: number },
  sec: Omit<NavSection, "cumulativeDistanceM">,
) {
  cumulative.value += sec.distanceM;
  sections.push({ ...sec, cumulativeDistanceM: cumulative.value });
}

/**
 * Build a navigable route (straight-line road placeholders).
 * Call {@link buildNavRouteAsync} to hydrate road legs via OSRM.
 */
export function buildNavRoute(input: NavRouteInput): NavRoute {
  const sections: NavSection[] = [];
  const cumulative = { value: 0 };
  let approach: NavLatLng = input.from;

  function addRoad(from: NavLatLng, to: NavLatLng, id: string, name: string) {
    if (haversineM(from, to) < 15) {
      approach = to;
      return;
    }
    const path = [from, to];
    appendSection(sections, cumulative, {
      kind: "road",
      id,
      name,
      path,
      distanceM: haversineM(from, to),
    });
    approach = to;
  }

  function addLeg(leg: NavRouteLeg) {
    if (leg.path.length < 2) return;
    const entry = leg.path[0];
    if (haversineM(approach, entry) >= ROAD_CONNECT_THRESHOLD_M) {
      addRoad(
        approach,
        entry,
        `road-to-${leg.id}`,
        leg.kind === "trail" ? `Head to ${leg.name}` : leg.name,
      );
    } else {
      approach = entry;
    }
    appendSection(sections, cumulative, {
      kind: leg.kind,
      id: leg.id,
      name: leg.name,
      grade: leg.grade ?? (leg.kind === "trail" ? leg.grade : undefined),
      path: leg.path,
      distanceM: polylineLength(leg.path),
    });
    approach = leg.path[leg.path.length - 1];
  }

  if (input.legs?.length) {
    for (const leg of input.legs) addLeg(leg);
  } else {
    for (let i = 0; i < (input.trails ?? []).length; i++) {
      const trail = input.trails![i];
      const oriented = orientTrailPath(parseTrailPath(trail), approach);
      if (oriented.length < 2) continue;
      addLeg({
        kind: "trail",
        id: trail.id,
        name: trail.name,
        path: oriented,
        grade: gradeFromDifficulty(trail.difficulty),
      });
    }
  }

  if (haversineM(approach, input.to) >= ROAD_CONNECT_THRESHOLD_M) {
    addRoad(approach, input.to, "road-final", "Continue to destination");
  }

  if (sections.length === 0) {
    addRoad(input.from, input.to, "road-direct", "Proceed to destination");
  }

  return finalizeNavRoute(input.from, input.to, sections);
}

/**
 * Build route with OSRM road geometry for every road connector.
 */
export async function buildNavRouteAsync(
  input: NavRouteInput,
  signal?: AbortSignal,
): Promise<NavRoute> {
  const draft = buildNavRoute(input);
  return hydrateRoadSections(draft, signal);
}

/** Replace straight road sections with OSRM geometry. */
export async function hydrateRoadSections(
  draft: NavRoute,
  signal?: AbortSignal,
): Promise<NavRoute> {
  const roadIndices = draft.sections
    .map((s, i) => (s.kind === "road" ? i : -1))
    .filter((i) => i >= 0);

  if (roadIndices.length === 0) return draft;

  let routingDegraded = false;

  const results = await Promise.all(
    roadIndices.map(async (idx) => {
      const sec = draft.sections[idx];
      const from = sec.path[0];
      const to = sec.path[sec.path.length - 1];
      if (!from || !to || haversineM(from, to) < 25) {
        return { idx, path: sec.path, distanceM: sec.distanceM };
      }
      const res = await fetchRoadRoute(from, to, signal);
      if (res.ok && res.polyline.length >= 2) {
        return {
          idx,
          path: res.polyline,
          distanceM: res.distanceM,
          osrmSteps: res.steps.length > 0 ? res.steps : undefined,
        };
      }
      if (!res.ok) routingDegraded = true;
      return { idx, path: sec.path, distanceM: sec.distanceM, osrmSteps: undefined };
    }),
  );

  const sections = draft.sections.map((s) => ({ ...s }));
  for (const { idx, path, distanceM, osrmSteps } of results) {
    sections[idx] = { ...sections[idx], path, distanceM, osrmSteps };
  }

  let cum = 0;
  const rebuilt = sections.map((sec) => {
    cum += sec.distanceM;
    return { ...sec, cumulativeDistanceM: cum };
  });

  return { ...finalizeNavRoute(draft.from, draft.to, rebuilt), routingDegraded };
}

/** Recompute polyline, instructions, and cumulative distances after section edits. */
export function rebuildNavRouteFromSections(
  from: NavRoute["from"],
  to: NavRoute["to"],
  sections: NavSection[],
): NavRoute {
  let cum = 0;
  const rebuilt = sections.map((sec) => {
    cum += sec.distanceM;
    return { ...sec, cumulativeDistanceM: cum };
  });
  return finalizeNavRoute(from, to, rebuilt);
}

function buildInstructions(sections: NavSection[], totalDistanceM: number): NavInstruction[] {
  const list: NavInstruction[] = [];

  // Opening instruction.
  if (sections.length > 0) {
    const first = sections[0];
    list.push({
      text: first.kind === "trail"
        ? `Enter trail section: ${first.name}`
        : `Head towards your route`,
      shortText: first.kind === "trail" ? `Enter ${first.name}` : "Start navigation",
      icon: first.kind === "trail" ? "enter-trail" : "start",
      triggerDistanceM: 0,
      trailName: first.kind === "trail" ? first.name : undefined,
      grade: first.kind === "trail" ? first.grade : undefined,
    });
  }

  // Section transition instructions.
  let cumDist = 0;
  for (let i = 0; i < sections.length; i++) {
    const sec = sections[i];
    const next = sections[i + 1];
    const sectionStart = cumDist;

    if (sec.kind === "road" && sec.osrmSteps?.length) {
      let stepOffset = sectionStart;
      for (const step of sec.osrmSteps) {
        stepOffset += step.distanceM;
        if (step.distanceM < 25) continue;
        list.push({
          text: step.instruction,
          shortText: step.shortInstruction,
          icon: step.icon as InstructionIcon,
          triggerDistanceM: Math.min(stepOffset, totalDistanceM),
        });
      }
    }

    cumDist += sec.distanceM;

    if (!next) {
      list.push({
        text: "You have arrived at your destination",
        shortText: "Arriving",
        icon: "arrive",
        triggerDistanceM: totalDistanceM,
      });
      break;
    }

    if (sec.kind === "road" && next.kind === "trail") {
      const grade = next.grade;
      const gradeLabel =
        grade == null ? "" :
        grade <= 3 ? " (Easy)" :
        grade <= 6 ? " (Intermediate)" :
        grade <= 9 ? " (Hard)" :
        " (Extreme)";
      list.push({
        text: `Entering trail section: ${next.name}${grade ? ` — Grade ${grade}${gradeLabel}` : ""}`,
        shortText: `Enter trail: ${next.name}`,
        icon: "enter-trail",
        triggerDistanceM: cumDist,
        trailName: next.name,
        grade: next.grade,
      });
    } else if (sec.kind === "trail" && next.kind === "road") {
      list.push({
        text: "Trail section ended — returning to road",
        shortText: "Returning to road",
        icon: "exit-trail",
        triggerDistanceM: cumDist,
      });
    } else if (sec.kind === "road" && next.kind === "road") {
      const secEnd = sec.path[sec.path.length - 1];
      const nextStart = next.path[0];
      const nextSecond = next.path[1] ?? next.path[0];
      if (!sec.osrmSteps?.length && secEnd && nextStart && nextSecond) {
        const bearing1 = bearingDeg(sec.path[sec.path.length > 1 ? sec.path.length - 2 : 0], secEnd);
        const bearing2 = bearingDeg(nextStart, nextSecond);
        const diff = ((bearing2 - bearing1 + 540) % 360) - 180;
        let icon: InstructionIcon = "straight";
        let turnText = "Continue";
        if (diff > 25) { icon = "turn-right"; turnText = "Turn right"; }
        else if (diff < -25) { icon = "turn-left"; turnText = "Turn left"; }
        list.push({
          text: `${turnText} towards ${next.name}`,
          shortText: turnText,
          icon,
          triggerDistanceM: cumDist,
        });
      }
    } else if (sec.kind === "trail" && next.kind === "trail") {
      const grade = next.grade;
      list.push({
        text: `Next trail section: ${next.name}${grade ? ` — Grade ${grade}` : ""}`,
        shortText: `Next: ${next.name}`,
        icon: "enter-trail",
        triggerDistanceM: cumDist,
        trailName: next.name,
        grade: next.grade,
      });
    }
  }

  return list;
}

function findPolylineIndex(route: NavRoute, sectionIdx: number): number {
  const idx = route.polylineSection.indexOf(sectionIdx);
  return idx >= 0 ? idx : 0;
}

// ---------------------------------------------------------------------------
// Progress computation
// ---------------------------------------------------------------------------

/**
 * Snap the user's position to the route polyline and return progress state.
 *
 * This is called on every GPS update (~1 Hz while navigating). We find the
 * closest segment in the polyline to avoid expensive full-scan on every tick.
 */
export function computeProgress(
  userPos: NavLatLng,
  route: NavRoute,
  prevProgress: NavProgress | null,
  speedKmh: number,
): NavProgress {
  if (route.polyline.length < 2) {
    return {
      distanceTravelledM: 0,
      distanceRemainingM: route.totalDistanceM,
      currentSectionIdx: 0,
      nextInstructionIdx: 0,
      isOnTrail: false,
      arrived: false,
      speedKmh,
      etaMin: speedKmh > 0 ? Math.round((route.totalDistanceM / 1000 / speedKmh) * 60) : 999,
      completedSectionIds: [],
    };
  }

  // Find closest point on route polyline (segment-accurate snap).
  const prevSegIdx = prevProgress?.currentSectionIdx ?? 0;
  const prevSection = route.sections[prevSegIdx];
  const searchFrom = Math.max(0, (prevProgress ? findPolylineIndex(route, prevSegIdx) : 0) - 20);
  const searchTo = route.polyline.length - 2;

  let bestDist = Infinity;
  let bestIdx = searchFrom;
  let bestAlong = 0;
  let alongAccum = 0;

  for (let i = 0; i < route.polyline.length - 1; i++) {
    const segLen = haversineM(route.polyline[i], route.polyline[i + 1]);
    if (i < searchFrom) {
      alongAccum += segLen;
      continue;
    }
    if (i > searchTo) break;

    const a = route.polyline[i];
    const b = route.polyline[i + 1];
    const snapped = closestPointOnSegment(userPos, a, b);
    const d = haversineM(userPos, snapped);
    const alongHere = alongAccum + haversineM(a, snapped);
    if (d < bestDist) {
      bestDist = d;
      bestIdx = i;
      bestAlong = alongHere;
    }
    alongAccum += segLen;
  }

  void prevSection;
  const travelled = bestAlong;

  const remaining = Math.max(0, route.totalDistanceM - travelled);
  const currentSectionIdx = route.polylineSection[bestIdx] ?? 0;
  const currentSection = route.sections[currentSectionIdx];
  const isOnTrail = (currentSection?.kind ?? "road") === "trail";

  // Arrived if within 30 m of destination.
  const destDist = haversineM(userPos, route.to);
  const arrived = destDist < 30;

  // Advance instruction index: skip instructions that have already fired.
  let nextInstructionIdx = prevProgress?.nextInstructionIdx ?? 0;
  while (
    nextInstructionIdx < route.instructions.length - 1 &&
    travelled >= route.instructions[nextInstructionIdx].triggerDistanceM
  ) {
    nextInstructionIdx++;
  }

  // Completed sections: any section whose end cumulative distance < travelled.
  const completedSectionIds: string[] = [];
  for (const sec of route.sections) {
    if (sec.cumulativeDistanceM <= travelled) {
      completedSectionIds.push(sec.id);
    }
  }

  const etaMin =
    speedKmh > 0
      ? Math.round((remaining / 1000 / speedKmh) * 60)
      : prevProgress?.etaMin ?? Math.round((remaining / 1000 / 20) * 60);

  return {
    distanceTravelledM: travelled,
    distanceRemainingM: remaining,
    currentSectionIdx,
    nextInstructionIdx,
    isOnTrail,
    arrived,
    speedKmh,
    etaMin,
    completedSectionIds,
  };
}

// ---------------------------------------------------------------------------
// Camera helpers — heading-up with user at bottom-third
// ---------------------------------------------------------------------------

/**
 * Compute the camera center offset so the user marker appears in the lower
 * third of the screen. We project `lookAheadM` metres in the direction of
 * travel and use that as the camera center.
 *
 * This is equivalent to "move the viewport forward" so the destination is
 * visible rather than behind the user.
 */
export function getNavigationCameraCenter(
  pos: NavLatLng,
  headingDeg: number,
  lookAheadM = 250,
): NavLatLng {
  const headingRad = (headingDeg * Math.PI) / 180;
  const dLat = (Math.cos(headingRad) * lookAheadM) / 111_320;
  const dLon =
    (Math.sin(headingRad) * lookAheadM) /
    (111_320 * Math.cos((pos.latitude * Math.PI) / 180));
  return { latitude: pos.latitude + dLat, longitude: pos.longitude + dLon };
}

// ---------------------------------------------------------------------------
// Instruction distance formatting
// ---------------------------------------------------------------------------

export function formatDistance(metres: number): string {
  if (metres < 50) return "Now";
  if (metres < 1000) return `In ${Math.round(metres / 50) * 50} m`;
  return `In ${(metres / 1000).toFixed(1)} km`;
}

export function formatEta(etaMin: number): string {
  if (etaMin < 1) return "<1 min";
  if (etaMin < 60) return `${etaMin} min`;
  const h = Math.floor(etaMin / 60);
  const m = etaMin % 60;
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

export function formatArrivalTime(etaMin: number): string {
  const now = new Date(Date.now() + etaMin * 60 * 1000);
  return now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
