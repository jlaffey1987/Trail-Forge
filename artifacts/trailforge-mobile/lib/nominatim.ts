/**
 * Address autocomplete via the backend's `/api/geocode/*` proxy. The
 * server controls the Nominatim User-Agent and rate-limiting so we
 * never call the OSM service directly from the device.
 */
import { apiJson } from "@/lib/api";

export interface NominatimResult {
  place_id: number;
  display_name: string;
  lat: string;
  lon: string;
}

export async function geocode(query: string): Promise<NominatimResult[]> {
  const q = query.trim();
  if (!q) return [];
  try {
    const res = await apiJson<{ results: NominatimResult[] }>(
      `/api/geocode/search?q=${encodeURIComponent(q)}&limit=5`,
    );
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
