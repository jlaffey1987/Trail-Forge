/**
 * Address autocomplete via OpenStreetMap Nominatim. Same provider the web
 * planner uses so suggestions match between surfaces.
 *
 * Nominatim's usage policy requires an identifying User-Agent and rate
 * limiting; we send a TrailForge-specific UA and debounce calls in the
 * UI layer (see `app/(tabs)/index.tsx`).
 */

const NOMINATIM_URL = "https://nominatim.openstreetmap.org";
const USER_AGENT = "TrailForge-Mobile/1.0 (https://trailforge.app)";

export interface NominatimResult {
  place_id: number;
  display_name: string;
  lat: string;
  lon: string;
}

export async function geocode(query: string): Promise<NominatimResult[]> {
  if (!query.trim()) return [];
  const url = `${NOMINATIM_URL}/search?format=jsonv2&limit=5&q=${encodeURIComponent(query)}`;
  try {
    const res = await fetch(url, {
      headers: { "user-agent": USER_AGENT, accept: "application/json" },
    });
    if (!res.ok) return [];
    return (await res.json()) as NominatimResult[];
  } catch {
    return [];
  }
}
