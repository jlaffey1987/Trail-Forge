import type { Region } from "react-native-maps";

import { MAP_MAX_VISIBLE_POLYLINES } from "@/lib/appConfig";
import { haversineKm } from "@/lib/geo";

export interface MapCoord {
  latitude: number;
  longitude: number;
}

export function cullPolylinesToViewport<T extends { coords: MapCoord[] }>(
  items: T[],
  region: Region,
  maxCount = MAP_MAX_VISIBLE_POLYLINES,
): { visible: T[]; hiddenCount: number } {
  const pad = 0.06;
  const minLat = region.latitude - region.latitudeDelta / 2 - pad;
  const maxLat = region.latitude + region.latitudeDelta / 2 + pad;
  const minLon = region.longitude - region.longitudeDelta / 2 - pad;
  const maxLon = region.longitude + region.longitudeDelta / 2 + pad;

  const inView = items.filter((item) =>
    item.coords.some(
      (c) =>
        c.latitude >= minLat
        && c.latitude <= maxLat
        && c.longitude >= minLon
        && c.longitude <= maxLon,
    ),
  );

  if (inView.length <= maxCount) {
    return { visible: inView, hiddenCount: Math.max(0, items.length - inView.length) };
  }

  const center = { lat: region.latitude, lon: region.longitude };
  const scored = inView
    .map((item) => {
      const mid = item.coords[Math.floor(item.coords.length / 2)];
      const d = mid
        ? haversineKm(center, { lat: mid.latitude, lon: mid.longitude })
        : 999;
      return { item, d };
    })
    .sort((a, b) => a.d - b.d);

  const visible = scored.slice(0, maxCount).map((s) => s.item);
  return { visible, hiddenCount: items.length - visible.length };
}
