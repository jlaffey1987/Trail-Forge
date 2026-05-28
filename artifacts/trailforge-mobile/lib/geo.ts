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
