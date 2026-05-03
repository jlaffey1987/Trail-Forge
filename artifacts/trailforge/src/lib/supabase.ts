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
  /**
   * Raw GPX XML for the trail. Heavy. Intentionally OMITTED from the bbox
   * Map-tab fetch (`fetchTrailsInBbox`) — the Map renders from
   * `simplified_path` / `path_geojson` instead, which are much smaller.
   * Fetched lazily via `fetchTrailGpxByIds` when the user opens a trail or
   * starts route planning.
   */
  gpx_data?: unknown | null;
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
  /**
   * Pre-computed elevation profile derived from `<ele>` tags in `gpx_data`
   * by the trigger added in migration 0011. Downsampled array of integer
   * metres aligned with `simplified_path`, with `null` entries for points
   * whose source GPX was missing elevation. NULL when the GPX has no
   * usable elevation data at all.
   */
  elevation_profile?: Array<number | null> | null;
  /** Total ascent in metres (jitter-filtered). Added in migration 0011. */
  elevation_gain_m?: number | null;
  /** Total descent in metres, expressed as a positive number. Added in migration 0011. */
  elevation_loss_m?: number | null;
}

export interface MapBbox {
  minLat: number;
  maxLat: number;
  minLng: number;
  maxLng: number;
}

/**
 * Detect a synthetic "phantom" AI-discovered trail.
 *
 * Until this was tightened up, the AI forum scanner would persist a fake
 * 2-point ~500m straight-line placeholder whenever it had no GPX and could
 * not snap to a real OSM track. Those rows look like ruler-straight lines
 * cutting across countryside on the map — they're essentially noise, even
 * though they carry the dashed `ai-approximated` styling.
 *
 * As of migration `0019_phantom_ai_trails_cleanup.sql`:
 *   * every existing row matching this shape was soft-deleted
 *     (`deleted_at = now()`), so the public RLS policy and standard
 *     `deleted_at IS NULL` filters hide them everywhere;
 *   * a CHECK constraint (`trails_no_phantom_ai_placeholder`) rejects any
 *     future INSERT or UPDATE that would persist the same shape.
 *
 * Consumers therefore no longer need to filter on this — the helper is
 * kept exported as defence-in-depth (e.g. for admin tooling that bypasses
 * RLS, or to guard a dev DB that has not had the migration applied yet)
 * and as documentation of the legacy shape.
 *
 * Detection is conservative: only flips to true when ALL of the following
 * hold so a real snapped trail is never hidden by accident:
 *   1. verification_status === 'ai-approximated'
 *   2. simplified path is exactly 2 points (or unknown but bbox is degenerate)
 *   3. bbox has zero longitude span and ~400-700m latitude span — the exact
 *      shape of the legacy `dLat = 0.005, same lng` placeholder.
 */
export function isSyntheticPlaceholderTrail(trail: Trail): boolean {
  if (trail.verification_status !== "ai-approximated") return false;
  // If we know the simplified-path point count, anything other than 2
  // points cannot be the legacy 2-point placeholder.
  if (trail.path_point_count != null && trail.path_point_count !== 2) {
    return false;
  }
  if (
    trail.bbox_min_lat == null ||
    trail.bbox_max_lat == null ||
    trail.bbox_min_lng == null ||
    trail.bbox_max_lng == null
  ) {
    return false;
  }
  const latSpanDeg = Math.abs(trail.bbox_max_lat - trail.bbox_min_lat);
  const lngSpanDeg = Math.abs(trail.bbox_max_lng - trail.bbox_min_lng);
  // 1 degree of latitude ≈ 111.32 km everywhere.
  const latSpanM = latSpanDeg * 111_320;
  return lngSpanDeg < 1e-6 && latSpanM >= 400 && latSpanM <= 700;
}

export interface BboxFetchOptions {
  difficulties?: number[];
  trailTypes?: string[];
  limit?: number;
}

/**
 * Slim projection used by the Map tab — every Trail column EXCEPT `gpx_data`.
 *
 * The raw GPX XML is the dominant payload (often 50–500 KB per trail), and
 * the Map tab now renders trails using the much smaller `simplified_path` /
 * `path_geojson` columns added by migration 0008. Fetching `gpx_data` for
 * every trail in the viewport was wasting 5–20× more bandwidth than needed
 * on slow connections. `gpx_data` is fetched lazily via `fetchTrailGpxByIds`
 * when the user opens a trail or starts route planning.
 */
const TRAIL_SLIM_COLUMNS = [
  "id",
  "user_id",
  "owner_user_id",
  "name",
  "type",
  "difficulty",
  "distance_km",
  "terrain",
  "legal_status",
  "is_public",
  "created_at",
  "bbox_min_lat",
  "bbox_max_lat",
  "bbox_min_lng",
  "bbox_max_lng",
  "description",
  "deleted_at",
  "gpx_object_path",
  "source",
  "source_url",
  "verification_status",
  "ai_grade",
  "ai_grade_rationale",
  "ai_grade_model",
  "ai_graded_at",
  "simplified_path",
  "path_geojson",
  "path_point_count",
  "elevation_profile",
  "elevation_gain_m",
  "elevation_loss_m",
].join(",");

/**
 * Fetch public trails whose bounding box intersects the given viewport.
 *
 * Uses the bbox columns added by `supabase/migrations/0001_trail_bbox.sql`
 * and the slim projection (no `gpx_data`) so the Map tab stays fast on slow
 * connections. If the bbox columns are missing (migration not yet applied)
 * we fall back to fetching all public trails (capped). If the simplified
 * path columns from migration 0008 are also missing we further fall back
 * to `select("*")` so older databases keep working.
 */
export async function fetchTrailsInBbox(
  bbox: MapBbox,
  opts: BboxFetchOptions = {},
): Promise<{ trails: Trail[]; usedBbox: boolean }> {
  const limit = opts.limit ?? 200;

  const buildBbox = (cols: string) => {
    let q = supabase
      .from("trails")
      .select(cols)
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
    return q.limit(limit);
  };

  const buildAll = (cols: string) => {
    let q = supabase.from("trails").select(cols).eq("is_public", true);
    if (opts.difficulties && opts.difficulties.length > 0) {
      q = q.in("difficulty", opts.difficulties);
    }
    if (opts.trailTypes && opts.trailTypes.length > 0) {
      q = q.in("legal_status", opts.trailTypes);
    }
    return q.limit(limit);
  };

  // Legacy synthetic 2-point AI placeholders are soft-deleted by
  // migration 0019 and a CHECK constraint blocks new ones. The public
  // RLS policy on `trails` (anon key, used here) requires
  // `deleted_at IS NULL`, so the soft-deleted phantoms are hidden from
  // these reads automatically — no client-side filter needed. See
  // isSyntheticPlaceholderTrail in this file for the historical shape
  // and the defence-in-depth helper.

  // Try slim + bbox first (the fast path).
  let { data, error } = await buildBbox(TRAIL_SLIM_COLUMNS);
  if (!error) {
    return { trails: (data as unknown as Trail[]) || [], usedBbox: true };
  }

  const msg = error.message ?? "";
  const isMissingColumn = error.code === "42703" || /column/i.test(msg);

  if (isMissingColumn) {
    // Bbox columns missing → fall back to fetching all public trails.
    if (/bbox/i.test(msg)) {
      let r = await buildAll(TRAIL_SLIM_COLUMNS);
      if (r.error && (r.error.code === "42703" || /column/i.test(r.error.message ?? ""))) {
        // simplified_path / path_geojson also missing → final fallback to "*".
        r = await buildAll("*");
      }
      if (r.error) {
        console.error("Trail bbox fallback fetch failed:", r.error.message);
        return { trails: [], usedBbox: false };
      }
      return { trails: (r.data as unknown as Trail[]) || [], usedBbox: false };
    }

    // Slim columns missing (migration 0008 not applied) → retry bbox with "*".
    const r = await buildBbox("*");
    if (!r.error) {
      return { trails: (r.data as unknown as Trail[]) || [], usedBbox: true };
    }
    if (r.error.code === "42703" && /bbox/i.test(r.error.message ?? "")) {
      const all = await buildAll("*");
      if (all.error) {
        console.error("Trail bbox fallback fetch failed:", all.error.message);
        return { trails: [], usedBbox: false };
      }
      return { trails: (all.data as unknown as Trail[]) || [], usedBbox: false };
    }
    console.error("Trail bbox fetch failed:", r.error.message);
    return { trails: [], usedBbox: false };
  }

  console.error("Trail bbox fetch failed:", msg);
  return { trails: [], usedBbox: false };
}

/**
 * In-memory cache of `gpx_data` keyed by trail id, populated by
 * `fetchTrailGpxByIds`. Persists for the lifetime of the page so
 * reopening the same trail or reordering planner trails does not
 * re-download the (often 50–500 KB) GPX XML.
 *
 * Local mutations that change a trail's GPX (re-upload, edit, delete)
 * MUST call `invalidateTrailGpxCache(trailId)` so the next fetch goes
 * back to Supabase. `addTrail` does not need to invalidate because the
 * new id was never cached.
 */
const trailGpxCache = new Map<string, unknown>();

/**
 * Per-id in-flight tracker for `fetchTrailGpxByIds`. If the user reorders
 * the planner or opens the same trail again before the first request
 * resolves, the second call awaits the same network round-trip rather
 * than firing a duplicate one.
 */
const trailGpxInflight = new Map<string, Promise<void>>();

/**
 * Per-id generation counter. Bumped by `invalidateTrailGpxCache(id)` so
 * that an in-flight fetch which raced an invalidation can't write its
 * (potentially stale) result back into the cache after the fact. Each
 * fetch snapshots the generation at start and only writes if the
 * snapshot still matches at completion.
 */
const trailGpxGeneration = new Map<string, number>();

/**
 * Drop the cached `gpx_data` for `trailId`, or the entire cache when
 * `trailId` is omitted. Call this after any local mutation that changes
 * a trail's GPX so subsequent reads pick up the new payload.
 *
 * Also bumps the per-id generation and forgets any in-flight fetch for
 * the same id, so a request that was already on the wire when the
 * mutation happened can't repopulate the cache with a stale value.
 */
export function invalidateTrailGpxCache(trailId?: string): void {
  if (trailId == null) {
    trailGpxCache.clear();
    // Bump every id we've ever seen (cached or in-flight) so any racing
    // fetch in progress is discarded on completion.
    for (const id of trailGpxInflight.keys()) {
      trailGpxGeneration.set(id, (trailGpxGeneration.get(id) ?? 0) + 1);
    }
    trailGpxInflight.clear();
    return;
  }
  trailGpxCache.delete(trailId);
  trailGpxGeneration.set(trailId, (trailGpxGeneration.get(trailId) ?? 0) + 1);
  trailGpxInflight.delete(trailId);
}

/** Test-only: read the cached value (or `undefined` if not cached). */
export function __getCachedTrailGpx(trailId: string): unknown | undefined {
  return trailGpxCache.get(trailId);
}

/**
 * Lazy-fetch the raw `gpx_data` XML for the given trail ids.
 *
 * Used by the planner / route-builder flows that need full GPX (combined
 * GPX export, multi-modal road routing, etc) for trails that came from the
 * slim Map-tab response. Anon-key reads are constrained by RLS to public
 * trails — for private group-shared trails the gpx_data is already
 * populated when the trail row arrives via `/api/me/group-trails`.
 *
 * Results are cached in `trailGpxCache` for the lifetime of the page —
 * subsequent calls for the same ids resolve immediately without hitting
 * Supabase. Concurrent calls for the same id share a single network
 * request via `trailGpxInflight`. Use `invalidateTrailGpxCache(id)` to
 * drop a stale entry after a local mutation.
 */
export async function fetchTrailGpxByIds(
  trailIds: string[],
): Promise<Map<string, unknown>> {
  const out = new Map<string, unknown>();
  if (trailIds.length === 0) return out;

  const dedupedIds = Array.from(new Set(trailIds));
  const toFetch: string[] = [];
  const awaiting: Array<Promise<void>> = [];

  for (const id of dedupedIds) {
    if (trailGpxCache.has(id)) continue;
    const inflight = trailGpxInflight.get(id);
    if (inflight) {
      awaiting.push(inflight);
    } else {
      toFetch.push(id);
    }
  }

  if (toFetch.length > 0) {
    // Snapshot the generation per id at request start so a concurrent
    // `invalidateTrailGpxCache(id)` (e.g. user re-uploads while a planner
    // hydration is on the wire) bumps the generation and causes our
    // late-arriving result to be discarded instead of repopulating the
    // cache with a stale payload.
    const startGen = new Map<string, number>();
    for (const id of toFetch) {
      startGen.set(id, trailGpxGeneration.get(id) ?? 0);
    }
    const fetchPromise = (async () => {
      const { data, error } = await supabase
        .from("trails")
        .select("id, gpx_data")
        .in("id", toFetch);
      if (error) {
        console.error("fetchTrailGpxByIds error:", error.message);
        return;
      }
      for (const row of (data as Array<{ id: string; gpx_data: unknown }>) || []) {
        const startedAt = startGen.get(row.id) ?? 0;
        const currentGen = trailGpxGeneration.get(row.id) ?? 0;
        if (startedAt === currentGen) {
          trailGpxCache.set(row.id, row.gpx_data);
        }
        // else: an invalidation raced this fetch — drop the result.
      }
    })();
    const tracked = fetchPromise.finally(() => {
      for (const id of toFetch) {
        if (trailGpxInflight.get(id) === tracked) {
          trailGpxInflight.delete(id);
        }
      }
    });
    for (const id of toFetch) {
      trailGpxInflight.set(id, tracked);
    }
    awaiting.push(tracked);
  }

  if (awaiting.length > 0) {
    await Promise.all(awaiting);
  }

  for (const id of dedupedIds) {
    if (trailGpxCache.has(id)) {
      out.set(id, trailGpxCache.get(id));
    }
  }
  return out;
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
      // Legacy synthetic 2-point AI placeholders are soft-deleted by
      // migration 0019 and a CHECK constraint blocks new ones. The API
      // server still filters them explicitly on /api/me/saved-trails
      // (it uses the service role, so RLS does not auto-hide them) —
      // this client just trusts whatever the API returns.
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
  /**
   * Group ids to share the new trail into. Only honoured when
   * `privacy === "group"`. The server creates the trail row and the
   * matching `trail_shares` rows in the same handler — if the share
   * insert fails the trail row is rolled back, so a failed share never
   * leaves an orphan private trail behind.
   */
  group_ids?: string[];
}

export interface GpxUploadTicket {
  uploadURL: string;
  storageKey: string;
  objectPath: string;
}

export type GpxUploadResult =
  | { ok: true; ticket: GpxUploadTicket }
  | { ok: false; error: string };

/**
 * Two-step upload of a raw GPX file to object storage:
 *   1) Ask the API server for a signed PUT URL.
 *   2) PUT the GPX text to that URL with `Content-Type: application/gpx+xml`.
 *
 * Returns a tagged result so callers can surface a precise, rider-readable
 * reason when something goes wrong (auth, signing, CORS, network, etc.)
 * instead of a generic "Could not upload" message that masked failures
 * on iOS standalone PWAs (see SaveTrailForm).
 */
/**
 * Wrap a fetch call with an AbortController-driven timeout. Mobile PWAs
 * occasionally see fetches hang indefinitely (e.g. when a CORS preflight
 * to a signed object-storage URL is silently dropped on a flaky cellular
 * link). Without a timeout the rider would stare at "Saving…" forever
 * with no error feedback. We also tag every abort with a distinct error
 * so the caller can show the rider where the hang happened.
 */
async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  label: string,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      const timeoutErr = new Error(
        `Timed out after ${Math.round(timeoutMs / 1000)}s while ${label}. Check your connection and try again.`,
      );
      (timeoutErr as Error & { isTimeout?: boolean }).isTimeout = true;
      throw timeoutErr;
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export async function uploadGpxToStorage(
  gpxText: string,
): Promise<GpxUploadResult> {
  // Step 1 — ask our API for a fresh signed PUT URL. requireAuth() on the
  // server side means a 401 here is the most common cause of upload
  // failures (Clerk session expired in the standalone PWA).
  let ticket: GpxUploadTicket;
  try {
    const ticketRes = await fetchWithTimeout(
      "/api/trails/gpx/upload-url",
      {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      },
      20_000,
      "preparing upload",
    );
    if (!ticketRes.ok) {
      const body = await ticketRes.text().catch(() => "");
      console.error("gpx upload-url error:", ticketRes.status, body);
      if (ticketRes.status === 401 || ticketRes.status === 403) {
        return {
          ok: false,
          error: "You need to sign in again before uploading a GPX file.",
        };
      }
      return {
        ok: false,
        error: `Couldn't prepare upload (server returned ${ticketRes.status}). Please try again.`,
      };
    }
    ticket = (await ticketRes.json()) as GpxUploadTicket;
  } catch (err) {
    console.error("gpx upload-url network error:", err);
    const msg =
      err instanceof Error && err.message
        ? err.message
        : "Network error while preparing upload. Check your connection and try again.";
    return { ok: false, error: msg };
  }

  // Step 2 — PUT the raw XML straight to the signed object-storage URL.
  // A failure here is usually CORS (preflight blocked) or a network drop;
  // surface the HTTP status so we can diagnose from the rider's report.
  try {
    const putRes = await fetchWithTimeout(
      ticket.uploadURL,
      {
        method: "PUT",
        headers: { "Content-Type": "application/gpx+xml" },
        body: gpxText,
      },
      45_000,
      "uploading GPX to storage",
    );
    if (!putRes.ok) {
      console.error("gpx PUT to storage failed:", putRes.status);
      return {
        ok: false,
        error: `Storage upload failed (HTTP ${putRes.status}). Please try again.`,
      };
    }
    return { ok: true, ticket };
  } catch (err) {
    console.error("gpx PUT network error:", err);
    const msg =
      err instanceof Error && err.message
        ? err.message
        : "Storage upload was blocked by your browser or network. Please try again, or use a different network.";
    return { ok: false, error: msg };
  }
}

export async function addTrail(
  input: CreateTrailInput,
): Promise<Trail | null> {
  try {
    // 60s ceiling — large GPX over a slow cellular link can legitimately
    // take many seconds, but we never want the rider to stare at "Saving…"
    // forever if the connection drops mid-POST.
    const res = await fetchWithTimeout("/api/trails", {
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
        // Server creates the trail and trail_shares rows in one handler when
        // privacy=group; if the shares fail the trail row is rolled back.
        ...(input.privacy === "group" && input.group_ids
          ? { group_ids: input.group_ids }
          : {}),
      }),
    }, 60_000, "saving trail");
    if (!res.ok) {
      if (res.status === 401) {
        console.warn("Sign in required to record a trail.");
        return null;
      }
      const body = await res.text();
      console.error("Add trail error:", res.status, body);
      // Re-throw so the caller (SaveTrailForm) can surface a real message
      // instead of a silent "Could not save trail" — riders need to know
      // if they just hit a 413 (file too large) versus a 500.
      throw new Error(
        res.status === 413
          ? "GPX file is too large for upload."
          : `Server returned ${res.status}`,
      );
    }
    return (await res.json()) as Trail;
  } catch (err) {
    console.error("Add trail error:", err);
    throw err;
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
  /**
   * Replacement set of group ids the trail should be shared into. The
   * server diffs against the current `trail_shares`, applies the changes
   * BEFORE updating metadata, and returns 500 on failure (leaving the
   * trail untouched) so visibility can never go out of sync with privacy.
   * When privacy is changed to "private" or "public" any leftover shares
   * are cleared regardless of this field.
   */
  group_ids?: string[];
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
    // Metadata edits don't change `gpx_data`, but the trail row itself has
    // changed locally — drop the cached GPX so the next planner / detail
    // open reads through to the latest server state.
    invalidateTrailGpxCache(trailId);
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
    if (res.ok) invalidateTrailGpxCache(trailId);
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
    const res = await fetchWithTimeout(
      `/api/trails/${trailId}/gpx`,
      {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      },
      60_000,
      "replacing GPX",
    );
    if (!res.ok) {
      const body = await res.text();
      console.error("replaceOwnedTrailGpx error:", res.status, body);
      throw new Error(
        res.status === 413
          ? "GPX file is too large for upload."
          : `Server returned ${res.status}`,
      );
    }
    // The GPX has just been replaced — any cached copy is now stale.
    invalidateTrailGpxCache(trailId);
    return (await res.json()) as Trail;
  } catch (err) {
    console.error("replaceOwnedTrailGpx error:", err);
    throw err;
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
