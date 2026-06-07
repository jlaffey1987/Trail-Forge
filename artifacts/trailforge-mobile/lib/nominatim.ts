/**
 * Address autocomplete — tries the backend proxy first, then falls back to
 * direct Nominatim from the device (works without signing in).
 */
import * as Location from "expo-location";
import { apiJson } from "@/lib/api";

export interface NominatimResult {
  place_id: number;
  display_name: string;
  lat: string;
  lon: string;
}

const NOMINATIM_DIRECT = "https://nominatim.openstreetmap.org";
const USER_AGENT = "TrailForgeMobile/1.0";

function sortByProximity(
  results: NominatimResult[],
  lat?: number,
  lon?: number,
): NominatimResult[] {
  if (lat == null || lon == null || !Number.isFinite(lat) || !Number.isFinite(lon)) {
    return results;
  }
  return [...results].sort(
    (a, b) =>
      distKm(lat, lon, parseFloat(a.lat), parseFloat(a.lon))
      - distKm(lat, lon, parseFloat(b.lat), parseFloat(b.lon)),
  );
}

async function geocodeDirect(
  query: string,
  opts?: { lat?: number; lon?: number; limit?: number },
): Promise<NominatimResult[]> {
  const limit = opts?.limit ?? 8;
  const params = new URLSearchParams({
    format: "jsonv2",
    q: query,
    limit: String(limit),
    countrycodes: "gb,ie",
    addressdetails: "0",
  });
  const r = await fetch(`${NOMINATIM_DIRECT}/search?${params}`, {
    headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
  });
  if (!r.ok) return [];
  const json = (await r.json()) as NominatimResult[];
  return sortByProximity(Array.isArray(json) ? json : [], opts?.lat, opts?.lon);
}

/**
 * Forward geocode with optional GPS bias (results sorted nearest-first).
 */
export async function geocode(
  query: string,
  opts?: { lat?: number; lon?: number },
): Promise<NominatimResult[]> {
  const q = query.trim();
  if (q.length < 2) return [];

  try {
    let url = `/api/geocode/search?q=${encodeURIComponent(q)}&limit=8`;
    if (opts?.lat != null && opts?.lon != null) {
      url += `&lat=${opts.lat.toFixed(5)}&lon=${opts.lon.toFixed(5)}`;
    }
    const res = await apiJson<{ results: NominatimResult[] }>(url);
    const results = Array.isArray(res.results) ? res.results : [];
    if (results.length > 0) {
      return sortByProximity(results, opts?.lat, opts?.lon);
    }
  } catch {
    // fall through to direct Nominatim
  }

  return geocodeDirect(q, opts);
}

export async function reverseGeocode(
  lat: number,
  lon: number,
): Promise<{ display_name?: string } | null> {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;

  // Prefer on-device reverse geocode — works without signing in.
  try {
    const hits = await Location.reverseGeocodeAsync({ latitude: lat, longitude: lon });
    const h = hits[0];
    if (h) {
      const parts = [h.name, h.city, h.district, h.subregion, h.region]
        .filter(Boolean)
        .map(String);
      const unique = [...new Set(parts)];
      if (unique.length > 0) {
        return { display_name: unique.slice(0, 3).join(", ") };
      }
    }
  } catch {
    // fall through to API proxy
  }

  try {
    return await apiJson<{ display_name?: string }>(
      `/api/geocode/reverse?lat=${lat}&lon=${lon}`,
    );
  } catch {
    return null;
  }
}

/**
 * Shorten a Nominatim display_name to a rider-friendly label.
 */
export function shortLabel(displayName: string): string {
  const parts = displayName.split(",").map(s => s.trim());
  const trimmed = parts.filter(p =>
    !["United Kingdom", "England", "Scotland", "Wales",
      "Northern Ireland", "Great Britain", "Ireland"].includes(p),
  );
  return trimmed.slice(0, 3).join(", ");
}

/** Haversine distance in km between two lat/lon points. */
export function distKm(
  aLat: number, aLon: number,
  bLat: number, bLon: number,
): number {
  const R = 6371;
  const dLat = ((bLat - aLat) * Math.PI) / 180;
  const dLon = ((bLon - aLon) * Math.PI) / 180;
  const s = Math.sin(dLat / 2) ** 2
    + Math.cos((aLat * Math.PI) / 180)
    * Math.cos((bLat * Math.PI) / 180)
    * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.asin(Math.sqrt(s));
}

/** Format a distance nicely: "1.2 km" or "340 m" */
export function formatDistKm(km: number): string {
  if (km < 1) return `${Math.round(km * 1000)} m`;
  return `${km.toFixed(1)} km`;
}
