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

import { haversineM, bearingDeg, type NavLatLng } from "./navigationReroute";
import { gradeFromDifficulty } from "./trailColors";
import { trailMapCoordinates, type TrailPathSource } from "./geo";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface NavTrailInput {
  id: string;
  name: string;
  difficulty: string | null;
  distance_km: number | null;
  /** GeoJSON [lon, lat] pairs, path_geojson, or simplified_path from the API. */
  path?: unknown;
  path_geojson?: { type: string; coordinates: Array<[number, number]> } | null;
  simplified_path?: string | null;
}

export interface NavRouteInput {
  from: NavLatLng & { label: string };
  to: NavLatLng & { label: string };
  trails: NavTrailInput[];
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

function parseTrailPath(trail: TrailPathSource): NavLatLng[] {
  return trailMapCoordinates(trail);
}

function polylineLength(pts: NavLatLng[]): number {
  let d = 0;
  for (let i = 1; i < pts.length; i++) d += haversineM(pts[i - 1], pts[i]);
  return d;
}

/**
 * Build a navigable route from planner data.
 *
 * Road "connector" sections are inserted between the FROM endpoint → first
 * trail, between trails, and from the last trail → TO endpoint. These are
 * straight lines (no OSRM on the critical path at build time); OSRM road
 * polylines can be spliced in later via reroute.
 */
export function buildNavRoute(input: NavRouteInput): NavRoute {
  const sections: NavSection[] = [];
  let cumulative = 0;

  // Helper: road connector between two points.
  function addRoadSection(
    id: string,
    name: string,
    from: NavLatLng,
    to: NavLatLng,
  ) {
    const path = [from, to];
    const distanceM = haversineM(from, to);
    cumulative += distanceM;
    sections.push({ kind: "road", id, name, path, distanceM, cumulativeDistanceM: cumulative });
  }

  // Helper: trail section from path data.
  function addTrailSection(trail: NavTrailInput) {
    const path = parseTrailPath(trail);
    if (path.length < 2) {
      // Trail has no path data — treat as a road connector between its
      // implied start/end (same point if no coords).
      return;
    }
    const distanceM = polylineLength(path);
    cumulative += distanceM;
    sections.push({
      kind: "trail",
      id: trail.id,
      name: trail.name,
      grade: gradeFromDifficulty(trail.difficulty),
      path,
      distanceM,
      cumulativeDistanceM: cumulative,
    });
  }

  // From → first trail (or direct to destination if no trails).
  if (input.trails.length === 0) {
    addRoadSection("road-direct", "Proceed to destination", input.from, input.to);
  } else {
    const firstPath = parseTrailPath(input.trails[0]);
    const firstEntry = firstPath[0] ?? input.to;
    addRoadSection("road-0", `Head to ${input.trails[0].name}`, input.from, firstEntry);

    for (let i = 0; i < input.trails.length; i++) {
      addTrailSection(input.trails[i]);

      // Inter-trail connector: exit of trail[i] → entry of trail[i+1]
      if (i < input.trails.length - 1) {
        const currPath = parseTrailPath(input.trails[i]);
        const nextPath = parseTrailPath(input.trails[i + 1]);
        const from_ = currPath[currPath.length - 1] ?? input.from;
        const to_ = nextPath[0] ?? input.to;
        addRoadSection(
          `road-${i + 1}`,
          `Head to ${input.trails[i + 1].name}`,
          from_,
          to_,
        );
      }
    }

    // Last trail → destination.
    const lastPath = parseTrailPath(input.trails[input.trails.length - 1]);
    const lastExit = lastPath[lastPath.length - 1] ?? input.from;
    addRoadSection("road-final", "Continue to destination", lastExit, input.to);
  }

  // Build flat polyline + section index mapping.
  const polyline: NavLatLng[] = [];
  const polylineSection: number[] = [];
  for (let si = 0; si < sections.length; si++) {
    const sec = sections[si];
    for (const pt of sec.path) {
      polyline.push(pt);
      polylineSection.push(si);
    }
  }

  const totalDistanceM = cumulative;

  // Build instruction list.
  const instructions = buildInstructions(sections, totalDistanceM);

  return { from: input.from, to: input.to, sections, polyline, polylineSection, totalDistanceM, instructions };
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
    cumDist += sec.distanceM;

    if (!next) {
      // Arrival.
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
      // Bearing change at the junction may warrant a turn instruction.
      const secEnd = sec.path[sec.path.length - 1];
      const nextStart = next.path[0];
      const nextSecond = next.path[1] ?? next.path[0];
      if (secEnd && nextStart && nextSecond) {
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

  // Find closest polyline segment — search in a window around the previous
  // snapped index to avoid jumping backward.
  const prevIdx = prevProgress ? Math.max(0, prevProgress.currentSectionIdx - 1) : 0;
  const searchStart = Math.max(0, prevIdx - 5);
  const searchEnd = Math.min(route.polyline.length - 2, route.polyline.length - 1);

  let bestDist = Infinity;
  let bestIdx = searchStart;

  for (let i = searchStart; i <= searchEnd; i++) {
    const a = route.polyline[i];
    const b = route.polyline[i + 1];
    if (!a || !b) continue;
    // Quick equirectangular distance check before haversine.
    const dx = (userPos.longitude - a.longitude) * 80;
    const dy = (userPos.latitude - a.latitude) * 111;
    const approx = dx * dx + dy * dy;
    if (approx > bestDist * bestDist * 2) continue;

    const d = haversineM(userPos, a);
    if (d < bestDist) {
      bestDist = d;
      bestIdx = i;
    }
  }

  // Compute travelled distance = sum of polyline length up to bestIdx.
  let travelled = 0;
  for (let i = 0; i < bestIdx; i++) {
    const a = route.polyline[i];
    const b = route.polyline[i + 1];
    if (a && b) travelled += haversineM(a, b);
  }

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
