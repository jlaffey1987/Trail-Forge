/**
 * In-memory store for the route currently loaded for navigation.
 * Populated before pushing `/navigate`. Cleared when the user exits navigation.
 */

import type { NavRoute, NavRouteInput } from "./navigation";

let _active: NavRouteInput | null = null;
let _prebuilt: NavRoute | null = null;

export function setActiveNavRoute(route: NavRouteInput, prebuilt?: NavRoute): void {
  _active = route;
  _prebuilt = prebuilt ?? null;
}

export function getActiveNavRoute(): NavRouteInput | null {
  return _active;
}

/** Pre-built route (e.g. TNT after OSRM). Consumed once by the navigate screen. */
export function consumePrebuiltNavRoute(): NavRoute | null {
  const route = _prebuilt;
  _prebuilt = null;
  return route;
}

export function clearActiveNavRoute(): void {
  _active = null;
  _prebuilt = null;
}
