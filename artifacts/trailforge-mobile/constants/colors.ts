/**
 * TrailForge Premium Design System
 *
 * Dark, vivid, glove-friendly. Inspired by Garmin + Strava + Google Maps.
 * Designed for high contrast in direct sunlight, rain, and vibrating hands.
 *
 * Primary accent: #F5A623  amber trail gold
 * Grade colours:  vivid, high-saturation, readable at a glance
 */

const light = {
  // ── Surfaces ─────────────────────────────────────────────────────────────
  background:       "#0D0D0D",   // near-black
  card:             "#1A1A1A",   // raised card surface
  cardElevated:     "#232323",   // cards within cards
  input:            "#1F1F1F",

  // ── Text ─────────────────────────────────────────────────────────────────
  foreground:       "#FFFFFF",
  text:             "#FFFFFF",
  cardForeground:   "#FFFFFF",
  mutedForeground:  "#A0A0A0",
  tint:             "#F5A623",

  // ── Brand / Accent ────────────────────────────────────────────────────────
  primary:          "#F5A623",   // amber — tap targets, highlights
  primaryForeground:"#000000",
  primaryLight:     "#FFD080",

  secondary:        "#1F2C1F",
  secondaryForeground: "#B8EAB8",

  muted:            "#1F1F1F",
  accent:           "#2A1E00",   // very dark amber tint
  accentForeground: "#F5A623",

  // ── Status ───────────────────────────────────────────────────────────────
  destructive:      "#D50000",   // vivid red
  destructiveForeground: "#FFFFFF",
  warning:          "#FF6D00",   // vivid orange
  success:          "#00C853",   // vivid green

  // ── Structure ────────────────────────────────────────────────────────────
  border:           "#2A2A2A",
  borderFocus:      "#F5A623",

  // ── Trail Difficulty (vivid, sunlight-readable) ──────────────────────────
  trailGreen:       "#00C853",   // Grade 1-3 — easy
  trailBlue:        "#2979FF",   // Grade 4-6 — intermediate
  trailAmber:       "#FF6D00",   // Grade 7-9 — hard
  trailRed:         "#D50000",   // Grade 10  — extreme

  // Aliases kept for backward-compat
  trailBlack:       "#0D0D0D",
} as const;

/** Grade 1-10 → vivid colour */
export function gradeColour(g: number): string {
  if (g <= 3) return light.trailGreen;
  if (g <= 6) return light.trailBlue;
  if (g <= 9) return light.trailAmber;
  return light.trailRed;
}

export const GRADE_LABEL: Record<number, string> = {
  1: "Easy", 2: "Easy", 3: "Easy",
  4: "Intermediate", 5: "Intermediate", 6: "Intermediate",
  7: "Hard", 8: "Hard", 9: "Hard",
  10: "Extreme",
};

const colors = {
  light,
  dark: light,   // single dark-only palette
  radius: 12,
};

export default colors;
