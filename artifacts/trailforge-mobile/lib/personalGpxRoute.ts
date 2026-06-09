/**
 * Personal GPX routes — stored on-device only (not redistributed).
 * Used when riders import an official third-party GPX for private navigation.
 */
import AsyncStorage from "@react-native-async-storage/async-storage";

import type { GpxWaypoint } from "@/lib/gpxImport";
import { buildNavRouteAsync, type NavRoute, type NavRouteInput } from "@/lib/navigation";
import type { NavLatLng } from "@/lib/navigationReroute";
import {
  pathLengthM,
  snapToPolyline,
  trimPathBackward,
  trimPathForward,
} from "@/lib/polylineSnap";

export interface PersonalGpxRoute {
  name: string;
  waypoints: GpxWaypoint[];
  distanceKm: number;
  importedAt: number;
  sourceUrl?: string;
}

export type PersonalGpxDirection = "forward" | "reverse";

function waypointsToNavLatLng(waypoints: GpxWaypoint[]): NavLatLng[] {
  return waypoints.map((w) => ({ latitude: w.lat, longitude: w.lon }));
}

export async function loadPersonalGpxRoute(storageKey: string): Promise<PersonalGpxRoute | null> {
  try {
    const raw = await AsyncStorage.getItem(storageKey);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PersonalGpxRoute;
    if (!parsed?.waypoints?.length) return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function savePersonalGpxRoute(
  storageKey: string,
  route: PersonalGpxRoute,
): Promise<void> {
  await AsyncStorage.setItem(storageKey, JSON.stringify(route));
}

export async function clearPersonalGpxRoute(storageKey: string): Promise<void> {
  await AsyncStorage.removeItem(storageKey);
}

export function personalGpxMapCoords(route: PersonalGpxRoute) {
  return route.waypoints.map((w) => ({ latitude: w.lat, longitude: w.lon }));
}

export function suggestPersonalGpxDirection(
  path: NavLatLng[],
  userPos: NavLatLng,
): PersonalGpxDirection {
  const snap = snapToPolyline(path, userPos);
  if (!snap || path.length < 2) return "forward";
  const forward = trimPathForward(path, snap);
  const backward = trimPathBackward(path, snap);
  return pathLengthM(forward) >= pathLengthM(backward) ? "forward" : "reverse";
}

export interface PersonalGpxNavPreview {
  joinDistanceKm: number;
  remainingKm: number;
  direction: PersonalGpxDirection;
}

export function previewPersonalGpxNav(
  route: PersonalGpxRoute,
  userPos: NavLatLng,
  direction: PersonalGpxDirection,
): PersonalGpxNavPreview | null {
  const path = waypointsToNavLatLng(route.waypoints);
  if (path.length < 2) return null;
  const snap = snapToPolyline(path, userPos);
  if (!snap) return null;
  const trimmed =
    direction === "forward"
      ? trimPathForward(path, snap)
      : trimPathBackward(path, snap);
  if (trimmed.length < 2) return null;
  return {
    joinDistanceKm: snap.distanceM / 1000,
    remainingKm: pathLengthM(trimmed) / 1000,
    direction,
  };
}

export async function buildPersonalGpxNavRouteAsync(
  route: PersonalGpxRoute,
  userPos: NavLatLng,
  direction: PersonalGpxDirection,
  signal?: AbortSignal,
): Promise<{ routeInput: NavRouteInput; route: NavRoute } | null> {
  const path = waypointsToNavLatLng(route.waypoints);
  if (path.length < 2) return null;

  const snap = snapToPolyline(path, userPos);
  if (!snap) return null;

  const trimmed =
    direction === "forward"
      ? trimPathForward(path, snap)
      : trimPathBackward(path, snap);
  if (trimmed.length < 2) return null;

  const end = trimmed[trimmed.length - 1];
  const routeInput: NavRouteInput = {
    from: { ...userPos, label: "You" },
    to: { ...end, label: route.name },
    trails: [
      {
        id: "personal-gpx",
        name: route.name,
        difficulty: "Moderate",
        distance_km: route.distanceKm,
        pathOverride: trimmed,
      },
    ],
  };

  const built = await buildNavRouteAsync(routeInput, signal);
  return { routeInput, route: built };
}
