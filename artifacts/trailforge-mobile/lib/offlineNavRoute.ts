/**
 * Persist built navigation routes for offline replay (trail geometry + last OSRM legs).
 */
import AsyncStorage from "@react-native-async-storage/async-storage";

import type { NavRoute, NavRouteInput } from "@/lib/navigation";

const KEY_PREFIX = "trailforge:offline-nav:";

export interface CachedNavRoute {
  input: NavRouteInput;
  route: NavRoute;
  cachedAt: number;
}

export function navRouteCacheKey(
  trailIds: string[],
  opts?: { loop?: boolean },
): string {
  const ordered = trailIds.join(",");
  return opts?.loop ? `${ordered}|loop` : ordered;
}

function storageKey(cacheKey: string): string {
  return `${KEY_PREFIX}${cacheKey}`;
}

export async function cacheNavRoute(
  cacheKey: string,
  input: NavRouteInput,
  route: NavRoute,
): Promise<void> {
  if (!cacheKey) return;
  const payload: CachedNavRoute = {
    input,
    route,
    cachedAt: Date.now(),
  };
  try {
    await AsyncStorage.setItem(storageKey(cacheKey), JSON.stringify(payload));
  } catch {
    // non-critical
  }
}

export async function getCachedNavRoute(
  cacheKey: string,
): Promise<CachedNavRoute | null> {
  if (!cacheKey) return null;
  try {
    const raw = await AsyncStorage.getItem(storageKey(cacheKey));
    if (!raw) return null;
    return JSON.parse(raw) as CachedNavRoute;
  } catch {
    return null;
  }
}

export async function removeCachedNavRoute(cacheKey: string): Promise<void> {
  try {
    await AsyncStorage.removeItem(storageKey(cacheKey));
  } catch {
    // ignore
  }
}

/** Cache trail geometry from a built route for offline map display. */
export async function cacheTrailsForNavRoute(route: NavRoute): Promise<void> {
  const { saveTrailOffline } = await import("@/lib/offlineStore");
  for (const sec of route.sections) {
    if (sec.kind !== "trail" || sec.path.length < 2) continue;
    let minLat = 90;
    let maxLat = -90;
    let minLon = 180;
    let maxLon = -180;
    const path: Array<[number, number]> = [];
    for (const p of sec.path) {
      minLat = Math.min(minLat, p.latitude);
      maxLat = Math.max(maxLat, p.latitude);
      minLon = Math.min(minLon, p.longitude);
      maxLon = Math.max(maxLon, p.longitude);
      path.push([p.longitude, p.latitude]);
    }
    await saveTrailOffline({
      id: sec.id,
      name: sec.name,
      difficulty: sec.grade != null ? String(sec.grade) : null,
      distance_km: sec.distanceM / 1000,
      path,
      legal_status: null,
      terrain: null,
      bbox: { minLat, maxLat, minLon, maxLon },
    }).catch(() => undefined);
  }
}
