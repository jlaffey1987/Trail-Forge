import { createClient } from "@supabase/supabase-js";

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string;

if (!supabaseUrl || !supabaseAnonKey) {
  console.warn("Supabase environment variables not set — running in offline mode");
}

export const supabase = createClient(
  supabaseUrl || "https://placeholder.supabase.co",
  supabaseAnonKey || "placeholder"
);

export interface Trail {
  id: string;
  user_id: string | null;
  name: string;
  type: string | null;
  difficulty: number | null;
  distance_km: number | null;
  terrain: string | null;
  legal_status: string | null;
  gpx_data: unknown | null;
  is_public: boolean;
  created_at: string;
  bbox_min_lat?: number | null;
  bbox_max_lat?: number | null;
  bbox_min_lng?: number | null;
  bbox_max_lng?: number | null;
}

export interface MapBbox {
  minLat: number;
  maxLat: number;
  minLng: number;
  maxLng: number;
}

export interface BboxFetchOptions {
  difficulties?: number[];
  trailTypes?: string[];
  limit?: number;
}

/**
 * Fetch public trails whose bounding box intersects the given viewport.
 *
 * Uses the bbox columns added by `supabase/migrations/0001_trail_bbox.sql`
 * when present. If the columns are missing (migration not yet applied),
 * gracefully falls back to fetching all public trails (capped) so the Map
 * tab still works — the caller can filter client-side using the GPX cache.
 */
export async function fetchTrailsInBbox(
  bbox: MapBbox,
  opts: BboxFetchOptions = {}
): Promise<{ trails: Trail[]; usedBbox: boolean }> {
  const limit = opts.limit ?? 200;

  let q = supabase
    .from("trails")
    .select("*")
    .eq("is_public", true)
    .lte("bbox_min_lat", bbox.maxLat)
    .gte("bbox_max_lat", bbox.minLat)
    .lte("bbox_min_lng", bbox.maxLng)
    .gte("bbox_max_lng", bbox.minLng);

  if (opts.difficulties && opts.difficulties.length > 0) {
    q = q.in("difficulty", opts.difficulties);
  }
  if (opts.trailTypes && opts.trailTypes.length > 0) {
    q = q.in("legal_status", opts.trailTypes);
  }

  const { data, error } = await q.limit(limit);

  if (error) {
    // Column missing or other schema mismatch — fall back to fetching all public trails.
    if (
      error.code === "42703" ||
      /bbox|column/i.test(error.message ?? "")
    ) {
      let fallback = supabase.from("trails").select("*").eq("is_public", true);
      if (opts.difficulties && opts.difficulties.length > 0) {
        fallback = fallback.in("difficulty", opts.difficulties);
      }
      if (opts.trailTypes && opts.trailTypes.length > 0) {
        fallback = fallback.in("legal_status", opts.trailTypes);
      }
      const { data: allData, error: fallbackErr } = await fallback.limit(limit);
      if (fallbackErr) {
        console.error("Trail bbox fallback fetch failed:", fallbackErr.message);
        return { trails: [], usedBbox: false };
      }
      return { trails: (allData as Trail[]) || [], usedBbox: false };
    }
    console.error("Trail bbox fetch failed:", error.message);
    return { trails: [], usedBbox: false };
  }

  return { trails: (data as Trail[]) || [], usedBbox: true };
}

export async function fetchCommunityTrails(): Promise<Trail[]> {
  const { data, error } = await supabase
    .from("trails")
    .select("*")
    .eq("is_public", true)
    .order("created_at", { ascending: false });

  if (error) {
    console.error("Failed to fetch trails:", error.message);
    return [];
  }
  return data || [];
}

export async function searchTrails(opts: {
  difficulties?: number[];
  trailTypes?: string[];
  minDistance?: number;
  maxDistance?: number;
}): Promise<Trail[]> {
  let query = supabase.from("trails").select("*").eq("is_public", true);

  if (opts.difficulties && opts.difficulties.length > 0) {
    query = query.in("difficulty", opts.difficulties);
  }

  if (opts.trailTypes && opts.trailTypes.length > 0) {
    query = query.in("legal_status", opts.trailTypes);
  }

  const { data, error } = await query.order("difficulty", { ascending: true }).limit(20);
  if (error) {
    console.error("Search error:", error.message);
    return [];
  }
  return data || [];
}

export async function saveTrail(trailId: string, sessionId: string): Promise<boolean> {
  const { error } = await supabase.from("saved_trails").upsert({
    trail_id: trailId,
    session_id: sessionId,
    status: "planned",
  });
  if (error) {
    console.error("Save trail error:", error.message);
    return false;
  }
  return true;
}

export async function fetchSavedTrails(sessionId: string): Promise<Trail[]> {
  const { data, error } = await supabase
    .from("saved_trails")
    .select("trail_id, status, saved_at, trails(*)")
    .eq("session_id", sessionId)
    .order("saved_at", { ascending: false });

  if (error) {
    console.error("Fetch saved trails error:", error.message);
    return [];
  }
  // The Supabase relation join may return `trails` as either a single object
  // or a single-element array depending on FK inference — normalise both.
  return (data || [])
    .map((row: { trails: Trail | Trail[] | null }) => {
      const t = row.trails;
      if (Array.isArray(t)) return t[0] ?? null;
      return t ?? null;
    })
    .filter((t): t is Trail => t != null);
}

export async function addTrail(trail: Omit<Trail, "id" | "created_at">): Promise<Trail | null> {
  const { data, error } = await supabase.from("trails").insert(trail).select().single();
  if (error) {
    console.error("Add trail error:", error.message);
    return null;
  }
  return data;
}

export async function likeTrail(trailId: string): Promise<void> {
  await supabase.rpc("increment_likes", { trail_id: trailId });
}

const SESSION_KEY = "trailforge_session_id";
export function getSessionId(): string {
  let id = localStorage.getItem(SESSION_KEY);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(SESSION_KEY, id);
  }
  return id;
}
