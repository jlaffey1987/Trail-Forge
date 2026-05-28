/**
 * In-memory store for the route currently loaded for navigation.
 * Populated by the Planner tab before pushing `/navigate`.
 * Cleared when the user exits navigation.
 */

import type { NavRouteInput } from "./navigation";

let _active: NavRouteInput | null = null;

export function setActiveNavRoute(route: NavRouteInput): void {
  _active = route;
}

export function getActiveNavRoute(): NavRouteInput | null {
  return _active;
}

export function clearActiveNavRoute(): void {
  _active = null;
}
