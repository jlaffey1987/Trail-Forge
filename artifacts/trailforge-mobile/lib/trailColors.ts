/**
 * Difficulty -> map polyline colour. Mirrors the web's trail-layer palette
 * (`artifacts/trailforge/src/lib/trailLayer.ts`) so a trail looks the same
 * on both surfaces. Fallback is amber for the "unknown" bucket.
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
  | null
  | undefined;

export function difficultyColor(diff: TrailDifficulty): string {
  if (!diff) return colors.light.trailAmber;
  const d = diff.toLowerCase();
  if (d === "green" || d === "easy") return colors.light.trailGreen;
  if (d === "blue" || d === "intermediate") return colors.light.trailBlue;
  if (d === "black" || d === "advanced") return colors.light.trailRed;
  if (d === "double-black" || d === "expert") return colors.light.trailBlack;
  return colors.light.trailAmber;
}

export function difficultyLabel(diff: TrailDifficulty): string {
  if (!diff) return "Unknown";
  const d = diff.toLowerCase();
  if (d === "green" || d === "easy") return "Green / Easy";
  if (d === "blue" || d === "intermediate") return "Blue / Intermediate";
  if (d === "black" || d === "advanced") return "Black / Advanced";
  if (d === "double-black" || d === "expert") return "Double-Black / Expert";
  return diff;
}
