/**
 * One-tap offline pack: nav route + trail geometry + map tiles.
 */
import { trailMapCoordinates } from "@/lib/geo";
import type { NavRouteInput } from "@/lib/navigation";
import { buildNavRouteAsync } from "@/lib/navigation";
import {
  cacheNavRoute,
  cacheTrailsForNavRoute,
  navRouteCacheKey,
} from "@/lib/offlineNavRoute";
import { cacheTiles } from "@/lib/offlineStore";

export interface OfflinePackProgress {
  phase: "route" | "trails" | "tiles";
  message: string;
  percent: number;
}

function computeBbox(
  input: NavRouteInput,
  routePolyline: { latitude: number; longitude: number }[],
) {
  const lats: number[] = [input.from.latitude, input.to.latitude];
  const lons: number[] = [input.from.longitude, input.to.longitude];

  for (const t of input.trails ?? []) {
    for (const p of trailMapCoordinates(t)) {
      lats.push(p.latitude);
      lons.push(p.longitude);
    }
  }
  for (const p of routePolyline) {
    lats.push(p.latitude);
    lons.push(p.longitude);
  }

  const pad = 0.04;
  return {
    minLat: Math.min(...lats) - pad,
    maxLat: Math.max(...lats) + pad,
    minLon: Math.min(...lons) - pad,
    maxLon: Math.max(...lons) + pad,
  };
}

export async function downloadRideOfflinePack(
  input: NavRouteInput,
  onProgress?: (p: OfflinePackProgress) => void,
): Promise<void> {
  onProgress?.({ phase: "route", message: "Building route…", percent: 8 });

  const route = await buildNavRouteAsync(input);
  const trailIds = input.trails?.map((t) => t.id) ?? [];
  const cacheKey =
    input.cacheKey ??
    navRouteCacheKey(trailIds, { loop: input.localRideLoop });

  await cacheNavRoute(cacheKey, { ...input, cacheKey }, route);

  onProgress?.({ phase: "trails", message: "Saving trail data…", percent: 35 });
  await cacheTrailsForNavRoute(route);

  onProgress?.({ phase: "tiles", message: "Downloading map tiles…", percent: 45 });
  const bbox = computeBbox(input, route.polyline);

  await cacheTiles(bbox, (tileP) => {
    const tilePct =
      tileP.total > 0 ? Math.round((tileP.downloaded / tileP.total) * 55) : 0;
    onProgress?.({
      phase: "tiles",
      message: `Map tiles ${tileP.downloaded}/${tileP.total}`,
      percent: 45 + tilePct,
    });
  });

  onProgress?.({ phase: "tiles", message: "Ready for offline", percent: 100 });
}
