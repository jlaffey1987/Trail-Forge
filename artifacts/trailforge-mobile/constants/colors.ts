/**
 * TrailForge mobile design tokens. Mirrors the dark amber palette in the
 * web artifact's `index.css` so both apps feel like one product.
 *
 * Source mapping (web `:root` -> mobile hex):
 *   --background:        22 15% 8%   ->  #18120e
 *   --foreground:        38 15% 90%  ->  #ebe5dc
 *   --card:              22 15% 11%  ->  #211a13
 *   --card-foreground:   38 15% 90%  ->  #ebe5dc
 *   --primary:           38 88% 44%  ->  #d28b0d  (matches web `--color-trail-amber`)
 *   --primary-foreground:22 15% 8%   ->  #18120e
 *   --secondary:         140 25% 25% ->  #305041
 *   --muted:             22 12% 16%  ->  #2c241d
 *   --muted-foreground:  30 10% 55%  ->  #9b8f80
 *   --accent:            140 30% 30% ->  #366b48
 *   --destructive:       0 72% 51%   ->  #dc3433
 *   --border:            30 12% 20%  ->  #3b332a
 *   --input:             30 12% 22%  ->  #423933
 *
 * The single-key brand amber `#f0a832` is the lighter "amber-light" shade used
 * for headings and the GPS dot; the deeper `#d28b0d` is the primary action.
 */

const light = {
    text: "#ebe5dc",
    tint: "#f0a832",

    background: "#18120e",
    foreground: "#ebe5dc",

    card: "#211a13",
    cardForeground: "#ebe5dc",

    primary: "#d28b0d",
    primaryForeground: "#18120e",
    primaryLight: "#f0a832",

    secondary: "#305041",
    secondaryForeground: "#d8e6dc",

    muted: "#2c241d",
    mutedForeground: "#9b8f80",

    accent: "#366b48",
    accentForeground: "#dde9e0",

    destructive: "#dc3433",
    destructiveForeground: "#ffffff",

    border: "#3b332a",
    input: "#423933",

    // Trail-difficulty accents (from the web map's polyline palette).
    trailGreen: "#6aab7a",
    trailBlue: "#5aa7d4",
    trailAmber: "#f0a832",
    trailRed: "#dc6633",
    trailBlack: "#0e0a07",
  } as const;

// Single dark-only palette — the web app is dark-only too. Aliasing `dark`
// to the same object means `useColors()` returns the same tokens
// regardless of the device's `userColorScheme` setting.
const colors = {
  light,
  dark: light,
  radius: 12,
};

export default colors;
