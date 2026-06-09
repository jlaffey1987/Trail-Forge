/** Runtime config from Expo public env vars. */

const trimSlash = (url: string) => url.replace(/\/$/, "");

export const OSRM_BASE = trimSlash(
  process.env.EXPO_PUBLIC_OSRM_BASE_URL ?? "https://router.project-osrm.org",
);

export const PREMIUM_UPGRADE_URL =
  process.env.EXPO_PUBLIC_PREMIUM_URL?.trim() || null;

/** Max trail polylines drawn at once when zoomed in. */
export const MAP_MAX_VISIBLE_POLYLINES = 600;
