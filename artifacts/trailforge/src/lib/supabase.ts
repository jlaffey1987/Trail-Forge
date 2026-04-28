import { createClient } from "@supabase/supabase-js";

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string;

if (!supabaseUrl || !supabaseAnonKey) {
  console.warn("Supabase environment variables not set — running in offline mode");
}

/**
 * Anon-key client. Used for PUBLIC READS only:
 *   - browsing / searching public trails
 *   - reading a single public trail
 *
 * All ownership-sensitive reads / writes (saved_trails, users, trail
 * inserts) go through the API server (`@workspace/api-client-react`),
 * which authenticates via Clerk and uses the Supabase service-role
 * key. The Supabase RLS policies in
 * `supabase/migrations/0003_rls_policies.sql` enforce that the anon
 * key can ONLY read public trails.
 */
export const supabase = createClient(
  supabaseUrl || "https://placeholder.supabase.co",
  supabaseAnonKey || "placeholder",
);

export interface Trail {
  id: string;
  user_id: string | null;
  /** Clerk user id of the trail's owner. Added in migration 0002. */
  owner_user_id?: string | null;
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
  /** Member-authored description / route notes. Added in migration 0005. */
  description?: string | null;
  /** Set when the owner soft-deletes the trail. Added in migration 0005. */
  deleted_at?: string | null;
  /** Object-storage path for the original GPX artifact. Added in migration 0005. */
  gpx_object_path?: string | null;
  /** Decorated by /api/me/group-trails — list of groups this trail is shared into that the viewer also belongs to. */
  shared_groups?: Array<{ id: string; name: string }>;
  /** Provenance: 'user' (default) | 'tet' | 'act' | 'ai-forum' | 'ai-approx'. Added in migration 0007. */
  source?: string | null;
  /** Deep link back to the original source page (TET, ACT, forum thread, etc). Added in migration 0007. */
  source_url?: string | null;
  /** 'verified' | 'ai-approximated' | 'unverified'. Added in migration 0007. */
  verification_status?: string | null;
  /** Cached AI-derived difficulty 1-10. Added in migration 0007. */
  ai_grade?: number | null;
  /** Short rationale paired with `ai_grade`. */
  ai_grade_rationale?: string | null;
  ai_grade_model?: string | null;
  ai_graded_at?: string | null;
  /**
   * Pre-simplified Google encoded polyline (precision 5) derived from
   * `gpx_data` by the trigger added in migration 0008. The Map tab decodes
   * this directly so it can render trails without an XML parse pass.
   */
  simplified_path?: string | null;
  /**
   * GeoJSON LineString counterpart of `simplified_path`, also written by
   * the migration 0008 trigger. Either column is sufficient on its own —
   * the polyline form is more compact, the GeoJSON form is structured for
   * consumers that prefer it.
   */
  path_geojson?: { type: "LineString"; coordinates: [number, number][] } | null;
  /** Number of points stored in the simplified path. */
  path_point_count?: number | null;
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
  opts: BboxFetchOptions = {},
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

export interface SaveOwner {
  userId: string | null;
  sessionId: string | null;
}

/**
 * Save (bookmark) a trail. Goes through the API server so the caller's
 * Clerk session is verified server-side; guests pass `sessionId`.
 */
export async function saveTrail(trailId: string, owner: SaveOwner): Promise<boolean> {
  try {
    const body: Record<string, unknown> = { trailId };
    if (!owner.userId && owner.sessionId) body.sessionId = owner.sessionId;

    const res = await fetch("/api/me/saved-trails", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      console.error("Save trail error:", res.status, await res.text());
      return false;
    }
    return true;
  } catch (err) {
    console.error("Save trail error:", err);
    return false;
  }
}

interface SavedTrailItem {
  trail_id: string;
  status: string | null;
  saved_at: string | null;
  trail: Trail | null;
}

export async function fetchSavedTrails(owner: SaveOwner): Promise<Trail[]> {
  try {
    const url = new URL("/api/me/saved-trails", window.location.origin);
    if (!owner.userId && owner.sessionId) {
      url.searchParams.set("sessionId", owner.sessionId);
    }
    const res = await fetch(url.toString(), { credentials: "include" });
    if (!res.ok) {
      console.error("Fetch saved trails error:", res.status);
      return [];
    }
    const json = (await res.json()) as { items: SavedTrailItem[] };
    return (json.items ?? [])
      .map((it) => it.trail)
      .filter((t): t is Trail => t != null);
  } catch (err) {
    console.error("Fetch saved trails error:", err);
    return [];
  }
}

export type TrailPrivacy = "private" | "public" | "group";

export interface CreateTrailInput {
  name: string;
  type: string | null;
  difficulty: number | null;
  distance_km: number | null;
  terrain: string | null;
  legal_status: string | null;
  gpx_data: unknown | null;
  /** Object-storage path returned by `uploadGpxToStorage`. */
  gpx_object_path?: string | null;
  description?: string | null;
  privacy: TrailPrivacy;
  bbox_min_lat?: number | null;
  bbox_max_lat?: number | null;
  bbox_min_lng?: number | null;
  bbox_max_lng?: number | null;
}

export interface GpxUploadTicket {
  uploadURL: string;
  storageKey: string;
  objectPath: string;
}

/**
 * Two-step upload of a raw GPX file to object storage:
 *   1) Ask the API server for a signed PUT URL.
 *   2) PUT the GPX text to that URL with `Content-Type: application/gpx+xml`.
 *
 * On success, returns the `objectPath` to send back with `addTrail` /
 * `replaceOwnedTrailGpx` so the server can finalize the ACL and persist
 * the artifact reference on the trail row.
 */
export async function uploadGpxToStorage(
  gpxText: string,
): Promise<GpxUploadTicket | null> {
  try {
    const ticketRes = await fetch("/api/trails/gpx/upload-url", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    if (!ticketRes.ok) {
      console.error("gpx upload-url error:", ticketRes.status, await ticketRes.text());
      return null;
    }
    const ticket = (await ticketRes.json()) as GpxUploadTicket;

    const putRes = await fetch(ticket.uploadURL, {
      method: "PUT",
      headers: { "Content-Type": "application/gpx+xml" },
      body: gpxText,
    });
    if (!putRes.ok) {
      console.error("gpx PUT to storage failed:", putRes.status);
      return null;
    }

    return ticket;
  } catch (err) {
    console.error("uploadGpxToStorage error:", err);
    return null;
  }
}

export async function addTrail(
  input: CreateTrailInput,
): Promise<Trail | null> {
  try {
    const res = await fetch("/api/trails", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: input.name,
        type: input.type,
        difficulty: input.difficulty,
        distance_km: input.distance_km,
        terrain: input.terrain,
        legal_status: input.legal_status,
        gpx_data: input.gpx_data,
        gpx_object_path: input.gpx_object_path ?? null,
        is_public: input.privacy === "public",
        privacy: input.privacy,
        description: input.description ?? null,
        bbox_min_lat: input.bbox_min_lat,
        bbox_max_lat: input.bbox_max_lat,
        bbox_min_lng: input.bbox_min_lng,
        bbox_max_lng: input.bbox_max_lng,
      }),
    });
    if (!res.ok) {
      if (res.status === 401) {
        console.warn("Sign in required to record a trail.");
        return null;
      }
      console.error("Add trail error:", res.status, await res.text());
      return null;
    }
    return (await res.json()) as Trail;
  } catch (err) {
    console.error("Add trail error:", err);
    return null;
  }
}

/** Fetch trails owned by the currently signed-in user. */
export async function fetchOwnedTrails(): Promise<Trail[]> {
  try {
    const res = await fetch("/api/me/trails", { credentials: "include" });
    if (!res.ok) {
      if (res.status === 401) return [];
      console.error("fetchOwnedTrails error:", res.status);
      return [];
    }
    const json = (await res.json()) as { items: Trail[] };
    return json.items ?? [];
  } catch (err) {
    console.error("fetchOwnedTrails error:", err);
    return [];
  }
}

export interface UpdateTrailInput {
  name?: string;
  difficulty?: number | null;
  type?: string | null;
  legal_status?: string | null;
  terrain?: string | null;
  distance_km?: number | null;
  description?: string | null;
  privacy?: TrailPrivacy;
}

export async function updateOwnedTrail(
  trailId: string,
  input: UpdateTrailInput,
): Promise<Trail | null> {
  try {
    const res = await fetch(`/api/trails/${trailId}`, {
      method: "PATCH",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    if (!res.ok) {
      console.error("updateOwnedTrail error:", res.status, await res.text());
      return null;
    }
    return (await res.json()) as Trail;
  } catch (err) {
    console.error("updateOwnedTrail error:", err);
    return null;
  }
}

export async function deleteOwnedTrail(trailId: string): Promise<boolean> {
  try {
    const res = await fetch(`/api/trails/${trailId}`, {
      method: "DELETE",
      credentials: "include",
    });
    return res.ok;
  } catch (err) {
    console.error("deleteOwnedTrail error:", err);
    return false;
  }
}

export interface ReplaceGpxInput {
  gpx_data: string;
  /** Object-storage path returned by `uploadGpxToStorage`. */
  gpx_object_path?: string | null;
  distance_km?: number | null;
  bbox_min_lat?: number | null;
  bbox_max_lat?: number | null;
  bbox_min_lng?: number | null;
  bbox_max_lng?: number | null;
}

export async function replaceOwnedTrailGpx(
  trailId: string,
  input: ReplaceGpxInput,
): Promise<Trail | null> {
  try {
    const res = await fetch(`/api/trails/${trailId}/gpx`, {
      method: "PUT",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    if (!res.ok) {
      console.error("replaceOwnedTrailGpx error:", res.status, await res.text());
      return null;
    }
    return (await res.json()) as Trail;
  } catch (err) {
    console.error("replaceOwnedTrailGpx error:", err);
    return null;
  }
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

/**
 * Clear the device-bound session UUID. Called after a signed-in user has
 * merged their session-bound saved_trails over to their account so that
 * future "saved" rows are unambiguously user-owned.
 */
export function clearSessionId(): void {
  localStorage.removeItem(SESSION_KEY);
}
