/**
 * Plain-English ride difficulty for non-technical riders (late-40s ADV newcomers).
 * Maps to numeric grades for routing — premium users pick a level; free users see labels only.
 */

export type RideLevelId = "relaxed" | "moderate" | "experienced" | "full";

export interface RideLevel {
  id: RideLevelId;
  /** Large card title */
  title: string;
  /** One line under the title */
  subtitle: string;
  /** Helper shown when selected */
  detail: string;
  maxGrade: number | null;
  /** Tailoring route difficulty — navigation itself requires Premium. */
  requiresPremium: boolean;
}

export const RIDE_LEVELS: RideLevel[] = [
  {
    id: "relaxed",
    title: "Relaxed ride",
    subtitle: "Green lanes & easy tracks",
    detail: "Skips tougher sections — we'll use main roads to link easier trails.",
    maxGrade: 3,
    requiresPremium: true,
  },
  {
    id: "moderate",
    title: "Moderate",
    subtitle: "Typical ADV day out",
    detail: "Balanced route — avoids the most extreme sections.",
    maxGrade: 6,
    requiresPremium: true,
  },
  {
    id: "experienced",
    title: "Experienced",
    subtitle: "Harder trails, still sensible",
    detail: "Includes challenging trails — extreme sections may still be skipped.",
    maxGrade: 8,
    requiresPremium: true,
  },
  {
    id: "full",
    title: "Full route",
    subtitle: "Every section as mapped",
    detail: "The complete community route — all grades included.",
    maxGrade: null,
    requiresPremium: true,
  },
];

export function rideLevelById(id: RideLevelId): RideLevel {
  return RIDE_LEVELS.find((l) => l.id === id) ?? RIDE_LEVELS[RIDE_LEVELS.length - 1];
}

export function gradeRangeLabel(min: number | null, max: number | null): string {
  if (min == null || max == null) return "Mixed difficulty";
  if (max <= 3) return "Mostly easy";
  if (min >= 7) return "Challenging";
  if (max <= 6) return "Easy to moderate";
  return "Moderate to hard";
}
