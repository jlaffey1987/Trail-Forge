/**
 * Route timeline for the navigation steps sheet — sections + turn instructions.
 */
import type { NavInstruction, NavProgress, NavRoute, NavSectionKind } from "@/lib/navigation";

export type TimelineLegStatus = "done" | "current" | "upcoming";

export interface RouteTimelineLeg {
  sectionIdx: number;
  sectionId: string;
  kind: NavSectionKind;
  name: string;
  distanceM: number;
  grade?: number | null;
  cumulativeEndM: number;
  instructions: NavInstruction[];
  status: TimelineLegStatus;
}

export function buildRouteTimeline(
  route: NavRoute,
  progress: NavProgress | null,
): RouteTimelineLeg[] {
  return route.sections.map((sec, sectionIdx) => {
    const sectionStart = sec.cumulativeDistanceM - sec.distanceM;
    const instructions = route.instructions.filter(
      (instr) =>
        instr.triggerDistanceM >= sectionStart - 1 &&
        instr.triggerDistanceM <= sec.cumulativeDistanceM + 1,
    );

    let status: TimelineLegStatus = "upcoming";
    if (progress) {
      if (progress.completedSectionIds.includes(sec.id)) {
        status = "done";
      } else if (sectionIdx === progress.currentSectionIdx) {
        status = "current";
      } else if (sectionIdx < progress.currentSectionIdx) {
        status = "done";
      }
    } else if (sectionIdx === 0) {
      status = "current";
    }

    return {
      sectionIdx,
      sectionId: sec.id,
      kind: sec.kind,
      name: sec.name,
      distanceM: sec.distanceM,
      grade: sec.grade,
      cumulativeEndM: sec.cumulativeDistanceM,
      instructions,
      status,
    };
  });
}

export function distanceToInstructionM(
  progress: NavProgress | null,
  triggerDistanceM: number,
): number | null {
  if (!progress) return null;
  return Math.max(0, triggerDistanceM - progress.distanceTravelledM);
}

export function formatLegDistance(m: number): string {
  if (m >= 1000) return `${(m / 1000).toFixed(1)} km`;
  return `${Math.round(m)} m`;
}
