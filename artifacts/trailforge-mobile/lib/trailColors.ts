/**
 * Difficulty -> map polyline colour for motorcycle trail grades.
 *
 * Grades 1-10 map to four tiers:
 *   1-3  Easy         → green  (any adventure bike)
 *   4-6  Intermediate → blue   (capable adventure bike)
 *   7-9  Hard         → orange (trail / enduro)
 *   10   Extreme      → red    (hard enduro only)
 *
 * Legacy string values ("green", "blue", "black", "double-black") are
 * converted to a representative numeric grade so old data keeps a sensible
 * colour on the map.
 */
import colors from "@/constants/colors";

export type TrailDifficulty =
  | "green"
  | "blue"
  | "black"
  | "double-black"
  | "easy"
  | "intermediate"
  | "advanced"
  | "expert"
  | string
  | number
  | null
  | undefined;

/** Grade 7-9 "Hard" orange — not yet a distinct token in colors.ts. */
export const TRAIL_ORANGE = "#e07828";

/**
 * Convert a difficulty string (legacy or numeric) to a 1-10 grade.
 * Returns null when the value is unrecognisable.
 */
export function gradeFromDifficulty(diff: TrailDifficulty): number | null {
  if (diff == null) return null;
  if (typeof diff === "number") {
    if (Number.isFinite(diff) && diff >= 1 && diff <= 10) return Math.round(diff);
    return null;
  }
  if (typeof diff !== "string") return null;
  const d = diff.trim().toLowerCase();
  if (!d) return null;

  // Numeric string like "7" or "4.5"
  const n = Number(d);
  if (!Number.isNaN(n) && n >= 1 && n <= 10) return Math.round(n);

  // Legacy ski/trail names → representative mid-grade
  if (d === "green" || d === "easy") return 2;
  if (d === "blue" || d === "intermediate" || d === "moderate") return 5;
  if (d === "black" || d === "advanced") return 8;
  if (d === "double-black" || d === "expert") return 10;

  return null;
}

/** Map a 1-10 numeric grade to a hex colour string. */
export function gradeToColor(grade: number | null | undefined): string {
  if (grade == null) return colors.light.trailAmber;
  if (grade <= 3) return colors.light.trailGreen;
  if (grade <= 6) return colors.light.trailBlue;
  if (grade <= 9) return TRAIL_ORANGE;
  return colors.light.destructive;
}

/** Human-readable tier label for a grade (e.g. "Grade 5 — Intermediate"). */
export function gradeLabel(grade: number | null | undefined): string {
  if (grade == null) return "Unknown";
  if (grade <= 3) return `Grade ${grade} — Easy`;
  if (grade <= 6) return `Grade ${grade} — Intermediate`;
  if (grade <= 9) return `Grade ${grade} — Hard`;
  return `Grade ${grade} — Extreme`;
}

/** Short parenthetical tier suffix for inline display (e.g. "(Easy)"). */
export function gradeShortLabel(grade: number | null | undefined): string {
  if (grade == null) return "";
  if (grade <= 3) return "(Easy)";
  if (grade <= 6) return "(Intermediate)";
  if (grade <= 9) return "(Hard)";
  return "(Extreme)";
}

/** Colour for a raw difficulty string (legacy or numeric). */
export function difficultyColor(diff: TrailDifficulty): string {
  return gradeToColor(gradeFromDifficulty(diff));
}

/** Human-readable label for a raw difficulty string (legacy or numeric). */
export function difficultyLabel(diff: TrailDifficulty): string {
  return gradeLabel(gradeFromDifficulty(diff));
}
