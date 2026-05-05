/**
 * Direct-fetch helpers for API endpoints not yet covered by the
 * generated `@workspace/api-client-react` hooks (chat, AI, groups, admin,
 * push subscribe, recently-ridden, completions). Every helper:
 *   1. Uses the absolute API base built from EXPO_PUBLIC_DOMAIN.
 *   2. Attaches the Clerk bearer token from the auth-token getter the
 *      app installs in `_layout.tsx` via `setAuthTokenGetter`. We mirror
 *      that getter into a module-level cache here so non-react-query call
 *      sites (notification handlers, background tasks) can authenticate
 *      without going through React.
 */

let _bearerGetter: (() => Promise<string | null> | string | null) | null = null;

export function setSharedBearerGetter(
  getter: (() => Promise<string | null> | string | null) | null,
): void {
  _bearerGetter = getter;
}

export function apiBaseUrl(): string {
  const domain = process.env.EXPO_PUBLIC_DOMAIN;
  if (!domain) {
    throw new Error(
      "EXPO_PUBLIC_DOMAIN is not set. Mobile app cannot reach the API.",
    );
  }
  return `https://${domain}`;
}

export interface ApiFetchOptions extends RequestInit {
  /** When true, send even without a bearer token (rare). */
  allowAnonymous?: boolean;
}

export async function apiFetch(
  path: string,
  opts: ApiFetchOptions = {},
): Promise<Response> {
  const url = path.startsWith("http") ? path : `${apiBaseUrl()}${path}`;
  const headers = new Headers(opts.headers);
  if (!headers.has("accept")) headers.set("accept", "application/json");
  if (
    opts.body &&
    typeof opts.body === "string" &&
    !headers.has("content-type")
  ) {
    headers.set("content-type", "application/json");
  }
  if (!headers.has("authorization") && _bearerGetter) {
    const token = await _bearerGetter();
    if (token) {
      headers.set("authorization", `Bearer ${token}`);
    } else if (!opts.allowAnonymous) {
      // Don't fire a request that's guaranteed to 401 — surface the
      // problem early so the UI can prompt for sign-in.
      throw new Error("Not signed in");
    }
  }
  return fetch(url, { ...opts, headers });
}

export async function apiJson<T>(
  path: string,
  opts: ApiFetchOptions = {},
): Promise<T> {
  const res = await apiFetch(path, opts);
  if (!res.ok) {
    let detail = "";
    try {
      detail = (await res.text()).slice(0, 200);
    } catch {
      // ignore
    }
    throw new Error(`HTTP ${res.status} ${res.statusText}: ${detail}`);
  }
  if (res.status === 204) return null as unknown as T;
  return (await res.json()) as T;
}

// ---------------------------------------------------------------------------
// Push subscribe (additive Expo branch — backend handles either body shape)
// ---------------------------------------------------------------------------

export async function subscribeExpoPushToken(
  expoPushToken: string,
): Promise<void> {
  await apiJson("/api/me/push/subscribe", {
    method: "POST",
    body: JSON.stringify({ kind: "expo", expoPushToken }),
  });
}

// ---------------------------------------------------------------------------
// Chat (not in OpenAPI yet)
// ---------------------------------------------------------------------------

export interface ChatRoom {
  id: string;
  kind: "dm" | "group";
  title: string | null;
  unread_count: number;
  last_message_at: string | null;
  last_message_preview: string | null;
}

export interface ChatMessage {
  id: string;
  room_id: string;
  author_id: string;
  body: string;
  created_at: string;
  edited_at: string | null;
}

export function listChatRooms(): Promise<{ rooms: ChatRoom[] }> {
  return apiJson("/api/chat/rooms");
}

export function listChatMessages(
  roomId: string,
  opts: { limit?: number; before?: string } = {},
): Promise<{ messages: ChatMessage[] }> {
  const qs = new URLSearchParams();
  if (opts.limit) qs.set("limit", String(opts.limit));
  if (opts.before) qs.set("before", opts.before);
  const suffix = qs.toString() ? `?${qs.toString()}` : "";
  return apiJson(
    `/api/chat/rooms/${encodeURIComponent(roomId)}/messages${suffix}`,
  );
}

export function sendChatMessage(
  roomId: string,
  body: string,
): Promise<{ message: ChatMessage }> {
  return apiJson(`/api/chat/rooms/${encodeURIComponent(roomId)}/messages`, {
    method: "POST",
    body: JSON.stringify({ body }),
  });
}

export function markRoomRead(roomId: string): Promise<void> {
  return apiJson(`/api/chat/rooms/${encodeURIComponent(roomId)}/read`, {
    method: "POST",
  });
}

// ---------------------------------------------------------------------------
// Completions (mark trail as ridden) — direct fetch
// ---------------------------------------------------------------------------

export function markTrailRidden(
  trailId: string,
  completedAt?: string,
): Promise<void> {
  return apiJson("/api/me/completions", {
    method: "POST",
    body: JSON.stringify(completedAt ? { trailId, completedAt } : { trailId }),
  });
}

export function unmarkTrailRidden(trailId: string): Promise<void> {
  return apiJson(`/api/me/completions/${encodeURIComponent(trailId)}`, {
    method: "DELETE",
  });
}

export function listCompletions(): Promise<{
  completions: Array<{ trailId: string; completedAt: string }>;
}> {
  return apiJson("/api/me/completions");
}

// ---------------------------------------------------------------------------
// Recently-ridden trails (for My Trails tab)
// ---------------------------------------------------------------------------

export interface RecentlyRiddenTrail {
  id: string;
  name: string;
  difficulty: string | null;
  distance_km: number | null;
  completedAt: string;
}

export async function listRecentlyRidden(): Promise<{
  trails: RecentlyRiddenTrail[];
}> {
  // The API exposes completions; we hydrate trail details client-side via
  // the search endpoint. Falls back to an empty list if the server returns
  // a 404 (table not yet provisioned in this environment).
  try {
    const { completions } = await listCompletions();
    if (completions.length === 0) return { trails: [] };
    // Server doesn't currently have a batch-get-by-id endpoint; the lighter
    // path is just to return the completion stubs and let the UI label
    // them. Production task #220 will add a proper hydrate-by-id call.
    return {
      trails: completions.map((c) => ({
        id: c.trailId,
        name: c.trailId,
        difficulty: null,
        distance_km: null,
        completedAt: c.completedAt,
      })),
    };
  } catch {
    return { trails: [] };
  }
}

// ---------------------------------------------------------------------------
// AI tab
// ---------------------------------------------------------------------------

export interface AiChatResponse {
  reply: string;
  citations?: Array<{ trailId: string; name: string }>;
}

export function askAi(
  prompt: string,
  context: { visibleTrailIds?: string[] } = {},
): Promise<AiChatResponse> {
  return apiJson("/api/ai/chat", {
    method: "POST",
    body: JSON.stringify({ prompt, ...context }),
  });
}

// ---------------------------------------------------------------------------
// Admin
// ---------------------------------------------------------------------------

export function adminWhoami(): Promise<{
  isModerator: boolean;
  email: string | null;
}> {
  return apiJson("/api/admin/whoami");
}

// ---------------------------------------------------------------------------
// Groups
// ---------------------------------------------------------------------------

export interface Group {
  id: string;
  name: string;
  member_count: number;
  is_owner: boolean;
}

export function listMyGroups(): Promise<{ groups: Group[] }> {
  return apiJson("/api/groups");
}

export function createGroup(name: string): Promise<{ group: Group }> {
  return apiJson("/api/groups", {
    method: "POST",
    body: JSON.stringify({ name }),
  });
}

// ---------------------------------------------------------------------------
// Planner suggestions (Task #214 not yet merged — direct fetch fallback)
// ---------------------------------------------------------------------------

export interface PlannerSuggestion {
  trailId: string;
  name: string;
  distance_km: number | null;
  difficulty: string | null;
  detourMeters: number;
}

export interface MapTrail {
  id: string;
  name: string;
  difficulty: string | null;
  ai_difficulty?: string | null;
  terrain?: string | null;
  distance_km?: number | null;
  elevation_gain_m?: number | null;
  /** GPX path samples — array of [lon, lat] pairs (GeoJSON convention). */
  path?: unknown;
  altitudes?: number[];
  photo_urls?: string[];
}

export interface TrailSearchResponseBbox {
  trails: MapTrail[];
}

/**
 * Bbox + id-filter trail search. The server's `/api/trails/search` route
 * accepts `bbox` and `ids` params that the OpenAPI spec doesn't yet
 * advertise, so we call it directly instead of through the generated
 * `useSearchTrails` hook (which would require the spec to grow those
 * fields and a regen step).
 */
export async function searchTrailsByBbox(params: {
  bbox?: string;
  ids?: string;
  limit?: number;
}): Promise<TrailSearchResponseBbox> {
  const qs = new URLSearchParams();
  if (params.bbox) qs.set("bbox", params.bbox);
  if (params.ids) qs.set("ids", params.ids);
  if (typeof params.limit === "number") qs.set("limit", String(params.limit));
  return apiJson<TrailSearchResponseBbox>(
    `/api/trails/search?${qs.toString()}`,
  );
}

export async function getPlannerSuggestions(req: {
  fromLat: number;
  fromLon: number;
  toLat: number;
  toLon: number;
  corridorKm?: number;
}): Promise<{ suggestions: PlannerSuggestion[] }> {
  try {
    return await apiJson<{ suggestions: PlannerSuggestion[] }>(
      "/api/me/planner/suggestions",
      { method: "POST", body: JSON.stringify(req) },
    );
  } catch {
    // Endpoint is task #214 — until that ships, gracefully degrade so the
    // planner UI still loads with an empty suggestions list.
    return { suggestions: [] };
  }
}
