import type { Trail } from "@/lib/supabase";

export interface Group {
  id: string;
  name: string;
  description: string | null;
  cover_photo_key: string | null;
  owner_user_id: string;
  created_at: string;
  discoverable?: boolean;
  role?: "owner" | "admin" | "member";
  joined_at?: string;
}

/**
 * A pending join request for a group, surfaced to owners/admins so they can
 * Approve / Decline from the GroupDetailDialog.
 */
export interface GroupJoinRequest {
  id: string;
  user_id: string;
  status: "pending" | "approved" | "declined";
  message: string | null;
  created_at: string;
  display_name: string | null;
  email: string | null;
  avatar_url: string | null;
}

/**
 * Row returned from `GET /api/groups/discoverable` — a group anybody can ask
 * to join, plus a hint about whether the caller already has a pending or
 * declined request so the UI can adjust its CTA accordingly.
 */
export interface DiscoverableGroup {
  id: string;
  name: string;
  description: string | null;
  cover_photo_key: string | null;
  created_at: string;
  member_count: number;
  owner: {
    user_id: string;
    display_name: string | null;
    avatar_url: string | null;
  };
  my_status: "pending" | "declined" | "none";
}

export interface GroupMember {
  user_id: string;
  role: "owner" | "admin" | "member";
  joined_at: string;
  display_name: string | null;
  email: string | null;
  avatar_url: string | null;
}

export interface GroupInvite {
  id: string;
  token: string;
  email: string | null;
  target_user_id?: string | null;
  expires_at: string;
  accepted_at: string | null;
  created_at: string;
  created_by_user_id: string;
}

export interface MyInvite {
  id: string;
  group_id: string;
  email: string | null;
  target_user_id: string | null;
  expires_at: string;
  created_at: string;
  group: { name: string; description: string | null } | null;
}

export interface GroupDetail {
  group: Group;
  callerRole: "owner" | "admin" | "member";
  members: GroupMember[];
  invites: GroupInvite[];
  /** Pending join requests — only populated for owners and admins. */
  joinRequests: GroupJoinRequest[];
  sharedTrailCount: number;
}

export interface GroupListResponse {
  items: Group[];
  invitesPending: number;
}

export interface InviteLookupResponse {
  id: string;
  group_id: string;
  email: string | null;
  expires_at: string;
  accepted: boolean;
  expired: boolean;
  group: { name: string; description: string | null } | null;
}

export interface GroupShare {
  group_id: string;
  shared_at: string;
  name: string | null;
}

export interface SharedTrail extends Trail {
  shared_groups?: Array<{ id: string; name: string }>;
}

/** A single entry in the in-app group activity feed. */
export type GroupNotification =
  | {
      type: "trail_shared";
      id: string;
      occurred_at: string;
      group: { id: string; name: string };
      trail: { id: string; name: string };
      actor: NotificationActor;
      unread: boolean;
    }
  | {
      type: "member_joined";
      id: string;
      occurred_at: string;
      group: { id: string; name: string };
      actor: NotificationActor;
      unread: boolean;
    }
  | {
      type: "member_left";
      id: string;
      occurred_at: string;
      group: { id: string; name: string };
      // Actor = the person who triggered the event. For voluntary leaves
      // this is the same user as `subject`; for admin removals it's the
      // owner/admin who did the kick.
      actor: NotificationActor;
      // Subject = the member that left or was removed. `id` may be null
      // if the underlying user has been hard-deleted.
      subject: NotificationActor & { id: string | null };
      // True when actor !== subject (an owner/admin removed someone).
      removed_by_admin: boolean;
      unread: boolean;
    }
  | {
      type: "trail_unshared";
      id: string;
      occurred_at: string;
      group: { id: string; name: string };
      // `trail.id` may be null if the underlying trail has been hard- or
      // soft-deleted; the UI should suppress the trail link in that case
      // and just render the snapshot name.
      trail: { id: string | null; name: string };
      actor: NotificationActor;
      unread: boolean;
    }
  | {
      type: "photo_shared";
      id: string;
      occurred_at: string;
      group: { id: string; name: string };
      actor: NotificationActor;
      unread: boolean;
    }
  | {
      type: "invite_declined";
      id: string;
      occurred_at: string;
      group: { id: string; name: string };
      actor: NotificationActor;
      decliner_label: string;
      unread: boolean;
    };

export interface NotificationActor {
  id: string;
  display_name: string | null;
  email: string | null;
  avatar_url: string | null;
}

export interface NotificationsResponse {
  items: GroupNotification[];
  unreadCount: number;
  lastReadAt: string | null;
  nextBefore: string | null;
}

async function jsonFetch<T>(url: string, init?: RequestInit): Promise<T | null> {
  try {
    const res = await fetch(url, {
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      ...init,
    });
    if (!res.ok) {
      if (res.status !== 401 && res.status !== 404 && res.status !== 403) {
        console.error(`[groups] ${url} → ${res.status}`, await res.text().catch(() => ""));
      }
      return null;
    }
    return (await res.json()) as T;
  } catch (err) {
    console.error(`[groups] ${url} fetch error`, err);
    return null;
  }
}

export async function listMyGroups(): Promise<GroupListResponse> {
  const data = await jsonFetch<GroupListResponse>("/api/groups");
  return data ?? { items: [], invitesPending: 0 };
}

export async function createGroup(input: {
  name: string;
  description?: string | null;
}): Promise<Group | null> {
  return jsonFetch<Group>("/api/groups", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function fetchGroupDetail(groupId: string): Promise<GroupDetail | null> {
  return jsonFetch<GroupDetail>(`/api/groups/${groupId}`);
}

export async function updateGroup(
  groupId: string,
  patch: {
    name?: string;
    description?: string | null;
    discoverable?: boolean;
  },
): Promise<Group | null> {
  return jsonFetch<Group>(`/api/groups/${groupId}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}

// ---------------------------------------------------------------------------
// Discoverable groups & join requests
// ---------------------------------------------------------------------------

/** List groups the caller can ask to join (excludes their own memberships). */
export async function listDiscoverableGroups(): Promise<DiscoverableGroup[]> {
  const res = await jsonFetch<{ items: DiscoverableGroup[] }>(
    "/api/groups/discoverable",
  );
  return res?.items ?? [];
}

/**
 * Create (or fetch the existing) pending join request for the caller. Returns
 * `{ ok: true }` when accepted by the server, otherwise an `error` string.
 */
export async function requestToJoinGroup(
  groupId: string,
  message?: string | null,
): Promise<{ ok: true } | { error: string; status?: number }> {
  try {
    const res = await fetch(`/api/groups/${groupId}/join-requests`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(message ? { message } : {}),
    });
    if (!res.ok) {
      let msg = "";
      try {
        const j = (await res.json()) as { error?: string };
        msg = j.error ?? "";
      } catch {
        // ignore
      }
      return { error: msg || `HTTP ${res.status}`, status: res.status };
    }
    return { ok: true };
  } catch (err) {
    console.error("requestToJoinGroup error", err);
    return { error: "network" };
  }
}

/** Owner/admin: approve a pending join request, adding the user to the group. */
export async function approveJoinRequest(
  groupId: string,
  requestId: string,
): Promise<boolean> {
  const res = await jsonFetch<{ ok: boolean }>(
    `/api/groups/${groupId}/join-requests/${requestId}/approve`,
    { method: "POST" },
  );
  if (res?.ok) emitMembershipChanged();
  return !!res?.ok;
}

/** Owner/admin: decline a pending join request. */
export async function declineJoinRequest(
  groupId: string,
  requestId: string,
): Promise<boolean> {
  const res = await jsonFetch<{ ok: boolean }>(
    `/api/groups/${groupId}/join-requests/${requestId}/decline`,
    { method: "POST" },
  );
  return !!res?.ok;
}

// ---------------------------------------------------------------------------
// Cover photo
// ---------------------------------------------------------------------------

export interface GroupCoverUploadTicket {
  uploadURL: string;
  storageKey: string;
  objectPath: string;
}

export async function requestGroupCoverUploadUrl(
  groupId: string,
): Promise<GroupCoverUploadTicket | null> {
  return jsonFetch<GroupCoverUploadTicket>(
    `/api/groups/${groupId}/cover/upload-url`,
    { method: "POST", body: JSON.stringify({}) },
  );
}

export async function finalizeGroupCover(
  groupId: string,
  storageKey: string,
): Promise<Group | null> {
  return jsonFetch<Group>(`/api/groups/${groupId}/cover`, {
    method: "POST",
    body: JSON.stringify({ storageKey }),
  });
}

export async function removeGroupCover(groupId: string): Promise<Group | null> {
  return jsonFetch<Group>(`/api/groups/${groupId}/cover`, { method: "DELETE" });
}

/** URL the browser should hit to render a group cover photo. */
export function groupCoverPhotoUrl(coverKey: string | null | undefined): string | null {
  if (!coverKey) return null;
  return `/api/storage/objects/${coverKey}`;
}

// ---------------------------------------------------------------------------
// Group photo gallery (shared per-group photos posted by members)
// ---------------------------------------------------------------------------

export interface GroupPhotoUploader {
  id: string;
  display_name: string | null;
  avatar_url: string | null;
}

export interface GroupPhoto {
  id: string;
  group_id: string;
  uploader_user_id: string;
  storage_key: string;
  width: number | null;
  height: number | null;
  caption: string | null;
  created_at: string;
  hidden_at: string | null;
  users: GroupPhotoUploader | null;
}

export interface GroupPhotoUploadTicket {
  uploadURL: string;
  storageKey: string;
  objectPath: string;
}

export async function fetchGroupPhotos(groupId: string): Promise<GroupPhoto[]> {
  const res = await jsonFetch<{ items: GroupPhoto[] }>(
    `/api/groups/${groupId}/photos`,
  );
  return res?.items ?? [];
}

export async function requestGroupPhotoUploadUrl(
  groupId: string,
): Promise<GroupPhotoUploadTicket | null> {
  return jsonFetch<GroupPhotoUploadTicket>(
    `/api/groups/${groupId}/photos/upload-url`,
    { method: "POST", body: JSON.stringify({}) },
  );
}

export async function createGroupPhoto(
  groupId: string,
  input: {
    storageKey: string;
    width?: number;
    height?: number;
    caption?: string;
  },
): Promise<GroupPhoto | null> {
  return jsonFetch<GroupPhoto>(`/api/groups/${groupId}/photos`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function updateGroupPhoto(
  groupId: string,
  photoId: string,
  patch: { caption: string | null },
): Promise<GroupPhoto | null> {
  return jsonFetch<GroupPhoto>(
    `/api/groups/${groupId}/photos/${photoId}`,
    { method: "PATCH", body: JSON.stringify(patch) },
  );
}

export async function deleteGroupPhoto(
  groupId: string,
  photoId: string,
): Promise<boolean> {
  const res = await jsonFetch<{ ok: boolean }>(
    `/api/groups/${groupId}/photos/${photoId}`,
    { method: "DELETE" },
  );
  return !!res?.ok;
}

/** URL the browser should hit to render a group gallery photo. */
export function groupPhotoUrl(photo: Pick<GroupPhoto, "storage_key">): string {
  return `/api/storage/objects/${photo.storage_key}`;
}

/**
 * Custom event fired whenever group membership changes (member added/removed,
 * a group is deleted, ownership is transferred, an invite is accepted/declined,
 * or trail-share assignments change). Surfaces a deterministic refetch trigger
 * so any active client view (Map, Discover, Groups list) can invalidate its
 * cache immediately rather than waiting for the next manual fetch.
 */
export const GROUPS_MEMBERSHIP_CHANGED_EVENT = "trailforge:groups-membership-changed";

export function emitMembershipChanged(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(GROUPS_MEMBERSHIP_CHANGED_EVENT));
}

export async function deleteGroup(groupId: string): Promise<boolean> {
  const res = await jsonFetch<{ ok: boolean }>(`/api/groups/${groupId}`, { method: "DELETE" });
  if (res?.ok) emitMembershipChanged();
  return !!res?.ok;
}

export async function leaveGroup(groupId: string): Promise<boolean> {
  const res = await jsonFetch<{ ok: boolean }>(`/api/groups/${groupId}/leave`, { method: "POST" });
  if (res?.ok) emitMembershipChanged();
  return !!res?.ok;
}

export async function removeMember(groupId: string, userId: string): Promise<boolean> {
  const res = await jsonFetch<{ ok: boolean }>(
    `/api/groups/${groupId}/members/${encodeURIComponent(userId)}`,
    { method: "DELETE" },
  );
  if (res?.ok) emitMembershipChanged();
  return !!res?.ok;
}

export interface CreateInviteResult {
  invite: GroupInvite | null;
  error?: string;
  status?: number;
}

export async function createInvite(
  groupId: string,
  opts?: { email?: string | null; username?: string | null } | string | null,
): Promise<CreateInviteResult> {
  // Backwards-compatible signature: a string is treated as an email.
  let body: Record<string, string> = {};
  if (typeof opts === "string") {
    if (opts) body = { email: opts };
  } else if (opts) {
    if (opts.email) body = { email: opts.email };
    else if (opts.username) body = { username: opts.username };
  }
  try {
    const res = await fetch(`/api/groups/${groupId}/invites`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      let msg = "";
      try {
        const j = (await res.json()) as { error?: string };
        msg = j.error ?? "";
      } catch {
        // ignore
      }
      return { invite: null, error: msg || `HTTP ${res.status}`, status: res.status };
    }
    return { invite: (await res.json()) as GroupInvite };
  } catch (err) {
    console.error("createInvite error", err);
    return { invite: null, error: "network" };
  }
}

export async function revokeInvite(groupId: string, inviteId: string): Promise<boolean> {
  const res = await jsonFetch<{ ok: boolean }>(
    `/api/groups/${groupId}/invites/${inviteId}`,
    { method: "DELETE" },
  );
  return !!res?.ok;
}

export async function lookupInvite(token: string): Promise<InviteLookupResponse | null> {
  return jsonFetch<InviteLookupResponse>(`/api/invites/${encodeURIComponent(token)}`);
}

export async function acceptInvite(
  token: string,
): Promise<{ ok: true; group_id: string } | { error: string; status?: number } | null> {
  try {
    const res = await fetch(`/api/invites/${encodeURIComponent(token)}/accept`, {
      method: "POST",
      credentials: "include",
    });
    if (!res.ok) {
      let msg = "";
      try {
        const j = (await res.json()) as { error?: string };
        msg = j.error ?? "";
      } catch {
        // ignore
      }
      return { error: msg || `HTTP ${res.status}`, status: res.status };
    }
    const json = (await res.json()) as { ok: true; group_id: string };
    emitMembershipChanged();
    return json;
  } catch (err) {
    console.error("acceptInvite error", err);
    return { error: "network" };
  }
}

export async function autoAcceptEmailInvites(): Promise<number> {
  const res = await jsonFetch<{ accepted: number }>("/api/me/invites/auto-accept", {
    method: "POST",
  });
  const n = res?.accepted ?? 0;
  if (n > 0) emitMembershipChanged();
  return n;
}

export async function listMyInvites(): Promise<MyInvite[]> {
  const res = await jsonFetch<{ items: MyInvite[] }>("/api/me/invites");
  return res?.items ?? [];
}

export async function declineMyInvite(inviteId: string): Promise<boolean> {
  const res = await jsonFetch<{ ok: boolean }>(
    `/api/me/invites/${inviteId}/decline`,
    { method: "POST" },
  );
  if (res?.ok) emitMembershipChanged();
  return !!res?.ok;
}

export async function acceptMyInvite(
  inviteId: string,
): Promise<{ ok: true; group_id: string } | { error: string; status?: number }> {
  try {
    const res = await fetch(`/api/me/invites/${inviteId}/accept`, {
      method: "POST",
      credentials: "include",
    });
    if (!res.ok) {
      let msg = "";
      try {
        const j = (await res.json()) as { error?: string };
        msg = j.error ?? "";
      } catch {
        // ignore
      }
      return { error: msg || `HTTP ${res.status}`, status: res.status };
    }
    const json = (await res.json()) as { ok: true; group_id: string };
    emitMembershipChanged();
    return json;
  } catch (err) {
    console.error("acceptMyInvite error", err);
    return { error: "network" };
  }
}

export async function transferGroupOwnership(
  groupId: string,
  toUserId: string,
): Promise<{ ok: true } | { error: string; status?: number }> {
  try {
    const res = await fetch(`/api/groups/${groupId}/transfer`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ to_user_id: toUserId }),
    });
    if (!res.ok) {
      let msg = "";
      try {
        const j = (await res.json()) as { error?: string };
        msg = j.error ?? "";
      } catch {
        // ignore
      }
      return { error: msg || `HTTP ${res.status}`, status: res.status };
    }
    emitMembershipChanged();
    return { ok: true };
  } catch (err) {
    console.error("transferGroupOwnership error", err);
    return { error: "network" };
  }
}

export async function getTrailShares(trailId: string): Promise<GroupShare[]> {
  const res = await jsonFetch<{ items: GroupShare[] }>(`/api/trails/${trailId}/shares`);
  return res?.items ?? [];
}

export async function setTrailShares(
  trailId: string,
  group_ids: string[],
): Promise<boolean> {
  const res = await jsonFetch<{ ok: boolean }>(`/api/trails/${trailId}/shares`, {
    method: "PUT",
    body: JSON.stringify({ group_ids }),
  });
  if (res?.ok) emitMembershipChanged();
  return !!res?.ok;
}

export interface GroupTrailsBbox {
  minLat: number;
  maxLat: number;
  minLng: number;
  maxLng: number;
}

export async function fetchGroupTrails(
  bbox?: GroupTrailsBbox,
): Promise<SharedTrail[]> {
  try {
    const url = new URL("/api/me/group-trails", window.location.origin);
    if (bbox) {
      url.searchParams.set(
        "bbox",
        `${bbox.minLat},${bbox.minLng},${bbox.maxLat},${bbox.maxLng}`,
      );
    }
    const res = await fetch(url.toString(), { credentials: "include" });
    if (!res.ok) {
      if (res.status !== 401) {
        console.error("fetchGroupTrails error", res.status);
      }
      return [];
    }
    const json = (await res.json()) as { items: SharedTrail[] };
    return json.items ?? [];
  } catch (err) {
    console.error("fetchGroupTrails error", err);
    return [];
  }
}

export async function fetchGroupNotifications(opts?: {
  limit?: number;
  before?: string | null;
}): Promise<NotificationsResponse> {
  const params = new URLSearchParams();
  if (opts?.limit) params.set("limit", String(opts.limit));
  if (opts?.before) params.set("before", opts.before);
  const qs = params.toString();
  const data = await jsonFetch<NotificationsResponse>(
    `/api/me/notifications${qs ? `?${qs}` : ""}`,
  );
  return (
    data ?? {
      items: [],
      unreadCount: 0,
      lastReadAt: null,
      nextBefore: null,
    }
  );
}

export async function markAllNotificationsRead(): Promise<string | null> {
  const res = await jsonFetch<{ ok: boolean; last_read_at: string }>(
    "/api/me/notifications/read",
    { method: "POST" },
  );
  return res?.last_read_at ?? null;
}

export function buildInviteUrl(token: string): string {
  const basePath = (import.meta.env.BASE_URL ?? "/").replace(/\/$/, "");
  return `${window.location.origin}${basePath}/invite/${encodeURIComponent(token)}`;
}

export function formatExpiry(iso: string): string {
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return "expired";
  const days = Math.floor(ms / (1000 * 60 * 60 * 24));
  const hours = Math.floor((ms % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
  if (days > 0) return `${days}d ${hours}h left`;
  return `${hours}h left`;
}
