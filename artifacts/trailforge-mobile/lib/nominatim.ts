/**
 * Address autocomplete via the backend's `/api/geocode/*` proxy.
 * The server controls the Nominatim User-Agent and rate-limiting so we
 * never call the OSM service directly from the device.
 */
import { apiJson } from "@/lib/api";

export interface NominatimResult {
  place_id: number;
  display_name: string;
  lat: string;
  lon: string;
}

/**
 * Forward geocode with optional GPS bias.
 * Passing lat/lon asks the server to favour results near that position.
 */
export async function geocode(
  query: string,
  opts?: { lat?: number; lon?: number },
): Promise<NominatimResult[]> {
  const q = query.trim();
  if (!q) return [];
  try {
    let url = `/api/geocode/search?q=${encodeURIComponent(q)}&limit=6`;
    if (opts?.lat != null && opts?.lon != null) {
      url += `&lat=${opts.lat.toFixed(5)}&lon=${opts.lon.toFixed(5)}`;
    }
    const res = await apiJson<{ results: NominatimResult[] }>(url);
    return Array.isArray(res.results) ? res.results : [];
  } catch {
    return [];
  }
}

export async function reverseGeocode(
  lat: number,
  lon: number,
): Promise<{ display_name?: string } | null> {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
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
 * "Kielder, Northumberland, England, United Kingdom" → "Kielder, Northumberland"
 */
export function shortLabel(displayName: string): string {
  const parts = displayName.split(",").map(s => s.trim());
  // Drop country + top-level region at the end
  const trimmed = parts.filter(p =>
    !["United Kingdom", "England", "Scotland", "Wales",
      "Northern Ireland", "Great Britain"].includes(p),
  );
  return trimmed.slice(0, 3).join(", ");
}

/**
 * Haversine distance in km between two lat/lon points.
 */
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
