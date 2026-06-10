/**
 * Navigation preferences — persisted to AsyncStorage.
 * Used by navigate.tsx and nav-settings.tsx.
 */

import AsyncStorage from "@react-native-async-storage/async-storage";

const KEY = "@trailforge/nav-prefs-v1";

export type NavMapType = "standard" | "satellite" | "terrain";

export interface NavPrefs {
  /** Position marker style shown on the navigation map */
  markerStyle: "arrow" | "motorcycle";
  /** Whether voice guidance is enabled */
  voiceEnabled: boolean;
  /** Speed display unit */
  speedUnit: "mph" | "kmh";
  /** Whether speed-adaptive camera zoom is enabled */
  autoZoom: boolean;
  /** Night mode setting */
  nightMode: "auto" | "on" | "off";
  /** Base map style during navigation */
  mapType: NavMapType;
}

export const NAV_PREFS_DEFAULT: NavPrefs = {
  markerStyle: "arrow",
  voiceEnabled: true,
  speedUnit: "mph",
  autoZoom: true,
  nightMode: "auto",
  mapType: "standard",
};

/** Cycle map layer: standard → satellite → terrain. */
export function cycleNavMapType(current: NavMapType): NavMapType {
  if (current === "standard") return "satellite";
  if (current === "satellite") return "terrain";
  return "standard";
}

export function navMapTypeLabel(t: NavMapType): string {
  if (t === "satellite") return "Satellite";
  if (t === "terrain") return "Terrain";
  return "Standard";
}

export async function loadNavPrefs(): Promise<NavPrefs> {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    if (!raw) return { ...NAV_PREFS_DEFAULT };
    return { ...NAV_PREFS_DEFAULT, ...(JSON.parse(raw) as Partial<NavPrefs>) };
  } catch {
    return { ...NAV_PREFS_DEFAULT };
  }
}

export async function saveNavPrefs(prefs: NavPrefs): Promise<void> {
  try {
    await AsyncStorage.setItem(KEY, JSON.stringify(prefs));
  } catch {
    // ignore — non-critical
  }
}

export async function patchNavPrefs(patch: Partial<NavPrefs>): Promise<NavPrefs> {
  const current = await loadNavPrefs();
  const next = { ...current, ...patch };
  await saveNavPrefs(next);
  return next;
}

// ── Night-mode helpers ─────────────────────────────────────────────────────

/**
 * Rough sunrise/sunset times for UK latitudes (accurate ±1h).
 * index = month (0-11), value = [sunrise, sunset] in decimal hours.
 */
const UK_SUN_HOURS: [number, number][] = [
  [8.0, 16.0],  // Jan
  [7.5, 17.0],  // Feb
  [6.5, 18.0],  // Mar
  [5.5, 20.0],  // Apr
  [5.0, 21.0],  // May
  [4.5, 21.5],  // Jun
  [5.0, 21.5],  // Jul
  [5.5, 21.0],  // Aug
  [6.5, 20.0],  // Sep
  [7.0, 18.5],  // Oct
  [7.5, 16.5],  // Nov
  [8.0, 15.5],  // Dec
];

/** Returns true if the current local time is outside daylight hours (UK approx). */
export function isNightTime(): boolean {
  const now = new Date();
  const month = now.getMonth();
  const h = now.getHours() + now.getMinutes() / 60;
  const [rise, set] = UK_SUN_HOURS[month];
  return h < rise || h > set;
}

/** Returns true when night mode should be active given a preference and current time. */
export function resolveNightMode(pref: NavPrefs["nightMode"]): boolean {
  if (pref === "on") return true;
  if (pref === "off") return false;
  return isNightTime(); // auto
}

// ── Speed helpers ──────────────────────────────────────────────────────────

/** Convert m/s to the user's preferred unit, return formatted string. */
export function formatSpeed(speedMs: number, unit: NavPrefs["speedUnit"]): string {
  if (unit === "mph") {
    return `${Math.round(speedMs * 2.237)}`;
  }
  return `${Math.round(speedMs * 3.6)}`;
}
