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
  // The API exposes completions; we hydrate trail details client-side
  // via the bbox/id-filter trail search endpoint so the user sees real
  // names and stats (not raw trail ids). Falls back to an empty list
  // when the completions table isn't yet provisioned (404).
  let completionRows: Array<{ trailId: string; completedAt: string }>;
  try {
    const res = await listCompletions();
    completionRows = res.completions;
  } catch {
    return { trails: [] };
  }
  if (completionRows.length === 0) return { trails: [] };

  // Hydrate metadata in one batch via the existing ids-filter on
  // /api/trails/search. If hydration fails, surface stubs so the user
  // still sees their ride history.
  let nameById = new Map<
    string,
    { name: string; difficulty: string | null; distance_km: number | null }
  >();
  try {
    const ids = completionRows.map((c) => c.trailId).join(",");
    const hydrated = await searchTrailsByBbox({
      ids,
      limit: completionRows.length,
    });
    for (const t of hydrated.trails) {
      nameById.set(t.id, {
        name: t.name,
        difficulty: t.difficulty,
        distance_km: t.distance_km ?? null,
      });
    }
  } catch {
    nameById = new Map();
  }

  return {
    trails: completionRows.map((c) => {
      const meta = nameById.get(c.trailId);
      return {
        id: c.trailId,
        name: meta?.name ?? "Trail",
        difficulty: meta?.difficulty ?? null,
        distance_km: meta?.distance_km ?? null,
        completedAt: c.completedAt,
      };
    }),
  };
}

// ---------------------------------------------------------------------------
// AI tab
// ---------------------------------------------------------------------------

export interface AiChatResponse {
  reply: string;
  citations?: Array<{ trailId: string; name: string }>;
}

export interface AiChatTurn {
  role: "user" | "assistant";
  content: string;
}

/**
 * Grounded chat. The server's `/api/ai/chat` route accepts the full
 * `messages` history + an optional viewport bbox so the AI can ground
 * replies on trails the user is currently looking at. We use a typed
 * direct-fetch helper here because the AI route is intentionally NOT
 * in the OpenAPI spec (the server treats it as a private surface — see
 * `routes/ai.ts`).
 */
export async function askAi(
  messages: AiChatTurn[],
  context: {
    bbox?: {
      minLat: number;
      minLng: number;
      maxLat: number;
      maxLng: number;
    } | null;
  } = {},
): Promise<AiChatResponse> {
  const body: Record<string, unknown> = { messages };
  if (context.bbox) body.bbox = context.bbox;
  const raw = await apiJson<{
    reply?: string;
    message?: string;
    citations?: AiChatResponse["citations"];
  }>("/api/ai/chat", { method: "POST", body: JSON.stringify(body) });
  // The server has shipped under both `reply` and `message` keys at
  // various points — accept either so a transient API contract drift
  // doesn't blank out the AI tab.
  return {
    reply: raw.reply ?? raw.message ?? "",
    citations: raw.citations,
  };
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

// Admin: AI-discovered trail review queue.
export interface DiscoveredTrail {
  id: string;
  name: string | null;
  region: string | null;
  difficulty: string | null;
  source_url: string | null;
  status: "pending" | "approved" | "rejected";
  created_at: string;
}

export function listDiscoveredTrails(
  status: "pending" | "approved" | "rejected" = "pending",
): Promise<{ items: DiscoveredTrail[]; note?: string }> {
  return apiJson(
    `/api/admin/discovered-trails?status=${encodeURIComponent(status)}`,
  );
}

export function approveDiscoveredTrail(id: string): Promise<unknown> {
  return apiJson(
    `/api/admin/discovered-trails/${encodeURIComponent(id)}/approve`,
    { method: "POST", body: JSON.stringify({}) },
  );
}

export function rejectDiscoveredTrail(
  id: string,
  reason?: string,
): Promise<unknown> {
  return apiJson(
    `/api/admin/discovered-trails/${encodeURIComponent(id)}/reject`,
    {
      method: "POST",
      body: JSON.stringify(reason ? { reason } : {}),
    },
  );
}

// ---------------------------------------------------------------------------
// Groups
// ---------------------------------------------------------------------------

export interface Group {
  id: string;
  name: string;
  description?: string | null;
  member_count: number;
  is_owner: boolean;
  visibility?: "public" | "private";
  role?: "owner" | "admin" | "member";
}

export interface DiscoverableGroup {
  id: string;
  name: string;
  description?: string | null;
  member_count: number;
  visibility: "public" | "private";
  is_member?: boolean;
  has_pending_request?: boolean;
}

export interface GroupMember {
  user_id: string;
  display_name?: string | null;
  email?: string | null;
  role: "owner" | "admin" | "member";
  joined_at: string;
}

export interface GroupJoinRequest {
  id: string;
  user_id: string;
  display_name?: string | null;
  message?: string | null;
  created_at: string;
}

export async function listMyGroups(): Promise<{ groups: Group[] }> {
  // Server returns `{ items: [...], invitesPending: N }`. Normalise to the
  // shape the mobile UI expects.
  const raw = await apiJson<{ items: unknown[] }>("/api/groups");
  const groups: Group[] = (raw.items ?? []).map((g) => {
    const r = g as Record<string, unknown>;
    return {
      id: String(r.id ?? ""),
      name: String(r.name ?? "Group"),
      description: (r.description as string | null) ?? null,
      member_count: Number(r.member_count ?? 0),
      is_owner: r.role === "owner",
      visibility: (r.visibility as "public" | "private") ?? "private",
      role: r.role as Group["role"],
    };
  });
  return { groups };
}

export function createGroup(
  name: string,
  description?: string,
): Promise<{ group: Group }> {
  return apiJson("/api/groups", {
    method: "POST",
    body: JSON.stringify(description ? { name, description } : { name }),
  });
}

export function listDiscoverableGroups(
  q?: string,
): Promise<{ items: DiscoverableGroup[] }> {
  const suffix = q && q.trim() ? `?q=${encodeURIComponent(q.trim())}` : "";
  return apiJson(`/api/groups/discoverable${suffix}`);
}

export function requestGroupJoin(
  groupId: string,
  message?: string,
): Promise<unknown> {
  return apiJson(`/api/groups/${encodeURIComponent(groupId)}/join-requests`, {
    method: "POST",
    body: JSON.stringify(message ? { message } : {}),
  });
}

export function leaveGroup(groupId: string): Promise<void> {
  return apiJson(`/api/groups/${encodeURIComponent(groupId)}/leave`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export function listGroupJoinRequests(
  groupId: string,
): Promise<{ items: GroupJoinRequest[] }> {
  return apiJson(`/api/groups/${encodeURIComponent(groupId)}/join-requests`);
}

export function approveGroupJoinRequest(
  groupId: string,
  requestId: string,
): Promise<unknown> {
  return apiJson(
    `/api/groups/${encodeURIComponent(groupId)}/join-requests/${encodeURIComponent(requestId)}/approve`,
    { method: "POST", body: JSON.stringify({}) },
  );
}

export function declineGroupJoinRequest(
  groupId: string,
  requestId: string,
): Promise<unknown> {
  return apiJson(
    `/api/groups/${encodeURIComponent(groupId)}/join-requests/${encodeURIComponent(requestId)}/decline`,
    { method: "POST", body: JSON.stringify({}) },
  );
}

// ---------------------------------------------------------------------------
// Chat extensions: archive, mark-unread, DM-by-user, unread badge
// ---------------------------------------------------------------------------

export function archiveRoom(roomId: string): Promise<void> {
  return apiJson(`/api/chat/rooms/${encodeURIComponent(roomId)}/archive`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export function unarchiveRoom(roomId: string): Promise<void> {
  return apiJson(`/api/chat/rooms/${encodeURIComponent(roomId)}/archive`, {
    method: "DELETE",
  });
}

export function openDmWith(
  userId: string,
): Promise<{ room: { id: string } }> {
  return apiJson(`/api/chat/dm/${encodeURIComponent(userId)}/open`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export function getUnreadCount(): Promise<{ unread: number }> {
  return apiJson("/api/chat/unread-count");
}

// ---------------------------------------------------------------------------
// Trail create from a recorded ride (used by the record screen's
// "save as private trail" flow).
// ---------------------------------------------------------------------------

export interface CreateTrailFromRideInput {
  name: string;
  /** GeoJSON-style [lon, lat] samples taken during the ride. */
  path: Array<[number, number]>;
  altitudes?: number[];
  visibility?: "private" | "public" | "group";
  groupId?: string;
  region?: string | null;
  difficulty?: string | null;
}

export async function createTrailFromRide(
  input: CreateTrailFromRideInput,
): Promise<{ id: string }> {
  return apiJson<{ id: string }>("/api/trails", {
    method: "POST",
    body: JSON.stringify({
      name: input.name,
      visibility: input.visibility ?? "private",
      group_id: input.groupId ?? null,
      region: input.region ?? null,
      difficulty: input.difficulty ?? null,
      path: input.path,
      altitudes: input.altitudes ?? [],
      source: "mobile-recording",
    }),
  });
}

// ---------------------------------------------------------------------------
// GPX export — reusable helper for planner saved routes & recorded rides.
// Builds a minimal GPX 1.1 doc from an ordered list of [lat, lon] points.
// ---------------------------------------------------------------------------

export function buildGpx(
  name: string,
  points: Array<{ lat: number; lon: number; ele?: number; time?: string }>,
): string {
  const trkpts = points
    .map((p) => {
      const eleTag =
        typeof p.ele === "number" ? `<ele>${p.ele.toFixed(1)}</ele>` : "";
      const timeTag = p.time ? `<time>${p.time}</time>` : "";
      return `      <trkpt lat="${p.lat.toFixed(6)}" lon="${p.lon.toFixed(6)}">${eleTag}${timeTag}</trkpt>`;
    })
    .join("\n");
  const safeName = name.replace(/[<>&"']/g, "");
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="TrailForge Mobile" xmlns="http://www.topografix.com/GPX/1/1">
  <trk>
    <name>${safeName}</name>
    <trkseg>
${trkpts}
    </trkseg>
  </trk>
</gpx>
`;
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
  /** UK access taxonomy: "BOAT", "Green Lane", "UCR", etc. Drives the
   *  Discover BOATs/Green Lanes filter chips. */
  legal_status?: string | null;
  is_public?: boolean | null;
  centroid_lat?: number | null;
  centroid_lon?: number | null;
  created_at?: string | null;
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
  // Surface real errors. Previously this swallowed every failure and
  // returned `[]`, which masked auth / 5xx issues from the user. The
  // planner UI now shows an explicit error state instead.
  return apiJson<{ suggestions: PlannerSuggestion[] }>(
    "/api/me/planner/suggestions",
    { method: "POST", body: JSON.stringify(req) },
  );
}

// ---------------------------------------------------------------------------
// Admin: system-admin grant/revoke + recent activity
// ---------------------------------------------------------------------------

export interface AdminUser {
  user_id: string;
  email: string | null;
  display_name: string | null;
  granted_at: string;
  granted_by: string | null;
  note: string | null;
}

export function listAdmins(): Promise<{
  items: AdminUser[];
  envAdmins?: string[];
  note?: string;
}> {
  return apiJson("/api/admin/admins");
}

export function grantAdmin(
  userId: string,
  note?: string,
): Promise<unknown> {
  return apiJson("/api/admin/admins", {
    method: "POST",
    body: JSON.stringify(note ? { userId, note } : { userId }),
  });
}

export function revokeAdmin(userId: string): Promise<unknown> {
  return apiJson(`/api/admin/admins/${encodeURIComponent(userId)}`, {
    method: "DELETE",
  });
}

// ---------------------------------------------------------------------------
// Community trails feed (Discover) + trail content (notes / amendments) +
// share-to-group action. The web's Discover lists *trails* with a
// BOATs/Green Lanes/Featured/Nearby filter ribbon; the mobile Discover
// now mirrors that. None of these endpoints are in the OpenAPI spec yet,
// so we hit them via apiJson directly.
// ---------------------------------------------------------------------------

export async function fetchCommunityTrails(): Promise<{ trails: MapTrail[] }> {
  // The bbox-search route returns rows ordered by name when no bbox is
  // given. Limit hard so the JSON is tractable on 4G.
  return apiJson<{ trails: MapTrail[] }>("/api/trails/search?limit=120");
}

export interface TrailNote {
  id: string;
  body: string;
  author_user_id: string | null;
  created_at: string;
  author?: { display_name?: string | null; avatar_url?: string | null } | null;
}

export function listTrailNotes(
  trailId: string,
): Promise<{ items: TrailNote[] }> {
  return apiJson<{ items: TrailNote[] }>(
    `/api/trails/${encodeURIComponent(trailId)}/notes`,
  );
}

export interface TrailAmendment {
  id: string;
  trail_id: string;
  reason: string | null;
  reason_category: string | null;
  status: string;
  created_at: string;
  decided_at: string | null;
}

export function listTrailAmendments(
  trailId: string,
): Promise<{ items: TrailAmendment[] }> {
  return apiJson<{ items: TrailAmendment[] }>(
    `/api/trails/${encodeURIComponent(trailId)}/amendments`,
  );
}

export interface TrailShare {
  group_id: string;
  shared_at: string;
  name: string | null;
}

/** List the groups a trail is currently shared into. Owner-only on the
 *  server; the share modal calls this on open so the user sees their
 *  current selection pre-populated. */
export function listTrailShares(
  trailId: string,
): Promise<{ items: TrailShare[] }> {
  return apiJson<{ items: TrailShare[] }>(
    `/api/trails/${encodeURIComponent(trailId)}/shares`,
  );
}

/** Replace the set of groups a trail is shared into. Owner-only on the
 *  server; the UI should only show this for trails the caller owns. */
export function shareTrailToGroups(
  trailId: string,
  groupIds: string[],
): Promise<unknown> {
  return apiJson(`/api/trails/${encodeURIComponent(trailId)}/shares`, {
    method: "PUT",
    body: JSON.stringify({ group_ids: groupIds }),
  });
}
