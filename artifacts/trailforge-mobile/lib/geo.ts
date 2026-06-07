/**
 * Shared geodesy utilities for TrailForge mobile.
 *
 * Single source of truth for the haversine distance formula, replacing four
 * separate implementations that existed across `lib/recording.ts`,
 * `lib/navigationReroute.ts`, `app/record.tsx`, and `app/(tabs)/discover.tsx`.
 */

const R_METRES = 6_371_000;
const R_KM = 6_371;

/**
 * Core haversine computation. Returns distance in the units of `R`.
 * @internal Prefer the typed wrappers below.
 */
function haversine(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
  R: number,
): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/**
 * Distance in **metres** between two `{ lat, lon }` points.
 * Used by recording, planner, and anywhere that works with the API's
 * `lat/lon` coordinate shape.
 */
export function haversineMeters(
  a: { lat: number; lon: number },
  b: { lat: number; lon: number },
): number {
  return haversine(a.lat, a.lon, b.lat, b.lon, R_METRES);
}

/**
 * Distance in **kilometres** between two `{ lat, lon }` points.
 * Convenience wrapper — avoids dividing by 1000 at every call site.
 */
export function haversineKm(
  a: { lat: number; lon: number },
  b: { lat: number; lon: number },
): number {
  return haversine(a.lat, a.lon, b.lat, b.lon, R_KM);
}

/**
 * Distance in **metres** between two `{ latitude, longitude }` points.
 * Used by navigation and rerouting where react-native-maps LatLng is the
 * coordinate type.
 */
export function haversineLatLng(
  a: { latitude: number; longitude: number },
  b: { latitude: number; longitude: number },
): number {
  return haversine(a.latitude, a.longitude, b.latitude, b.longitude, R_METRES);
}

/**
 * Parse a GeoJSON `[lon, lat]` path array (as returned by the TrailForge API)
 * into react-native-maps `{ latitude, longitude }` coordinates.
 *
 * Consolidates the identical inline loops in `CorridorMap`, `GroupTrailsMap`,
 * `map.tsx:extractCoords`, and `navigation.ts:parseTrailPath`.
 */
export function parseGeoJsonPath(
  path: unknown,
): Array<{ latitude: number; longitude: number }> {
  if (!Array.isArray(path)) return [];
  const out: Array<{ latitude: number; longitude: number }> = [];
  for (const p of path) {
    if (Array.isArray(p) && p.length >= 2) {
      const [lon, lat] = p as [unknown, unknown];
      if (typeof lat === "number" && typeof lon === "number") {
        out.push({ latitude: lat, longitude: lon });
      }
    }
  }
  return out;
}

/**
 * Bearing in degrees (0 = north, clockwise) from point A to point B.
 */
export function bearingDeg(
  a: { latitude: number; longitude: number },
  b: { latitude: number; longitude: number },
): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLon = toRad(b.longitude - a.longitude);
  const lat1 = toRad(a.latitude);
  const lat2 = toRad(b.latitude);
  const y = Math.sin(dLon) * Math.cos(lat2);
  const x =
    Math.cos(lat1) * Math.sin(lat2) -
    Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  return (((Math.atan2(y, x) * 180) / Math.PI) + 360) % 360;
}

/** API `/trails/search?bbox=` expects `minLat,minLng,maxLat,maxLng`. */
export function formatSearchBbox(
  minLat: number,
  minLng: number,
  maxLat: number,
  maxLng: number,
): string {
  return `${minLat.toFixed(4)},${minLng.toFixed(4)},${maxLat.toFixed(4)},${maxLng.toFixed(4)}`;
}

/** Build a search bbox string from a react-native-maps region. */
export function formatSearchBboxFromRegion(r: {
  latitude: number;
  longitude: number;
  latitudeDelta: number;
  longitudeDelta: number;
}): string {
  const minLat = r.latitude - r.latitudeDelta / 2;
  const maxLat = r.latitude + r.latitudeDelta / 2;
  const minLng = r.longitude - r.longitudeDelta / 2;
  const maxLng = r.longitude + r.longitudeDelta / 2;
  return formatSearchBbox(minLat, minLng, maxLat, maxLng);
}

/** Decode Google encoded polyline (precision 5) into `[lat, lon]` pairs. */
export function decodePolyline(encoded: string): Array<[number, number]> {
  const points: Array<[number, number]> = [];
  let index = 0;
  let lat = 0;
  let lon = 0;
  while (index < encoded.length) {
    let result = 0;
    let shift = 0;
    let b: number;
    do {
      b = encoded.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20 && index < encoded.length);
    const dLat = (result & 1) !== 0 ? ~(result >> 1) : result >> 1;
    lat += dLat;

    result = 0;
    shift = 0;
    do {
      b = encoded.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20 && index < encoded.length);
    const dLon = (result & 1) !== 0 ? ~(result >> 1) : result >> 1;
    lon += dLon;

    points.push([lat / 1e5, lon / 1e5]);
  }
  return points;
}

export interface TrailPathSource {
  path?: unknown;
  path_geojson?: { type?: string; coordinates?: unknown } | string | null;
  simplified_path?: string | null;
}

function normalizePathGeojson(
  raw: TrailPathSource["path_geojson"],
): { type?: string; coordinates?: unknown } | null {
  if (raw == null) return null;
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw) as { type?: string; coordinates?: unknown };
      return parsed && typeof parsed === "object" ? parsed : null;
    } catch {
      return null;
    }
  }
  if (typeof raw === "object") return raw;
  return null;
}

/**
 * Resolve trail geometry for map rendering.
 * Prefers simplified_path → path_geojson → legacy path array.
 */
export function trailMapCoordinates(
  trail: TrailPathSource,
): Array<{ latitude: number; longitude: number }> {
  if (typeof trail.simplified_path === "string" && trail.simplified_path.length > 0) {
    try {
      const decoded = decodePolyline(trail.simplified_path);
      if (decoded.length >= 2) {
        return decoded.map(([lat, lon]) => ({ latitude: lat, longitude: lon }));
      }
    } catch {
      // fall through
    }
  }

  const geo = normalizePathGeojson(trail.path_geojson);
  if (geo && Array.isArray(geo.coordinates)) {
    const coords = parseGeoJsonPath(geo.coordinates);
    if (coords.length >= 2) return coords;
  }

  if (Array.isArray(trail.path)) {
    if (trail.path.length > 0 && Array.isArray(trail.path[0])) {
      return parseGeoJsonPath(trail.path);
    }
    const legacy: Array<{ latitude: number; longitude: number }> = [];
    for (const pt of trail.path) {
      if (pt && typeof pt === "object") {
        const o = pt as Record<string, unknown>;
        const lat =
          typeof o.lat === "number" ? o.lat :
          typeof o.latitude === "number" ? o.latitude : null;
        const lon =
          typeof o.lon === "number" ? o.lon :
          typeof o.lng === "number" ? o.lng :
          typeof o.longitude === "number" ? o.longitude : null;
        if (lat != null && lon != null) {
          legacy.push({ latitude: lat, longitude: lon });
        }
      }
    }
    if (legacy.length >= 2) return legacy;
  }

  return [];
}

export function trailCentroid(trail: TrailPathSource & {
  centroid_lat?: number | null;
  centroid_lon?: number | null;
  bbox_min_lat?: number | null;
  bbox_max_lat?: number | null;
  bbox_min_lng?: number | null;
  bbox_max_lng?: number | null;
}): { latitude: number; longitude: number } | null {
  if (typeof trail.centroid_lat === "number" && typeof trail.centroid_lon === "number") {
    return { latitude: trail.centroid_lat, longitude: trail.centroid_lon };
  }
  const {
    bbox_min_lat: minLat,
    bbox_max_lat: maxLat,
    bbox_min_lng: minLng,
    bbox_max_lng: maxLng,
  } = trail;
  if (
    typeof minLat === "number" && typeof maxLat === "number"
    && typeof minLng === "number" && typeof maxLng === "number"
  ) {
    return { latitude: (minLat + maxLat) / 2, longitude: (minLng + maxLng) / 2 };
  }
  const coords = trailMapCoordinates(trail);
  return coords[0] ?? null;
}
