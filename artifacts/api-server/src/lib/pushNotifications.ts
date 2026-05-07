// Web Push (VAPID) + Expo Push fan-out. Stale subscriptions (HTTP 404/410
// or DeviceNotRegistered) are pruned. Fire-and-forget; never throws.

import webpush, { type PushSubscription, type WebPushError } from "web-push";
import { getSupabaseAdmin } from "./supabaseAdmin";

const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";
const EXPO_PUSH_TOKEN_RE = /^Exp(?:o|onent)PushToken\[[A-Za-z0-9_\-]+\]$/;

function isExpoEndpoint(endpoint: string): boolean {
  return EXPO_PUSH_TOKEN_RE.test(endpoint);
}

interface ExpoPushTicket {
  status: "ok" | "error";
  id?: string;
  message?: string;
  details?: { error?: string };
}

interface ExpoPushResponse {
  data?: ExpoPushTicket | ExpoPushTicket[];
  errors?: Array<{ code?: string; message?: string }>;
}

// Expo caps each request at 100 messages.
const EXPO_PUSH_CHUNK = 100;

type ExpoTicketOrNull = ExpoPushTicket | null;

function padTickets(
  arr: ExpoTicketOrNull[],
  length: number,
): ExpoTicketOrNull[] {
  while (arr.length < length) arr.push(null);
  return arr;
}

async function sendExpoPushChunk(
  tokens: string[],
  payload: PushPayload,
  log: MinimalLogger,
): Promise<ExpoTicketOrNull[]> {
  if (tokens.length === 0) return [];
  const messages = tokens.map((to) => ({
    to,
    title: payload.title,
    body: payload.body,
    sound: "default" as const,
    data: { url: payload.url, tag: payload.tag ?? null },
  }));
  let res: Response;
  try {
    res = await fetch(EXPO_PUSH_URL, {
      method: "POST",
      headers: {
        accept: "application/json",
        "accept-encoding": "gzip, deflate",
        "content-type": "application/json",
      },
      body: JSON.stringify(messages),
    });
  } catch (err) {
    log.warn({ err, count: tokens.length }, "push: expo fetch failed");
    return padTickets([], tokens.length);
  }
  if (!res.ok) {
    log.warn(
      { status: res.status, count: tokens.length },
      "push: expo non-2xx",
    );
    return padTickets([], tokens.length);
  }
  let parsed: ExpoPushResponse;
  try {
    parsed = (await res.json()) as ExpoPushResponse;
  } catch (err) {
    log.warn({ err }, "push: expo body parse failed");
    return padTickets([], tokens.length);
  }
  if (parsed.errors && parsed.errors.length > 0) {
    log.warn({ errors: parsed.errors }, "push: expo top-level errors");
  }
  const data = parsed.data;
  if (!data) return padTickets([], tokens.length);
  const arr: ExpoTicketOrNull[] = Array.isArray(data) ? [...data] : [data];
  return padTickets(arr, tokens.length);
}

async function sendExpoPushBatch(
  tokens: string[],
  payload: PushPayload,
  log: MinimalLogger,
): Promise<ExpoTicketOrNull[]> {
  if (tokens.length === 0) return [];
  const out: ExpoTicketOrNull[] = [];
  for (let i = 0; i < tokens.length; i += EXPO_PUSH_CHUNK) {
    const chunk = tokens.slice(i, i + EXPO_PUSH_CHUNK);
    const tickets = await sendExpoPushChunk(chunk, payload, log);
    out.push(...tickets);
  }
  return out;
}

export interface PushPayload {
  title: string;
  body: string;
  /** Path the SW should focus / open when the user taps the notification. */
  url: string;
  /** Optional discriminator the SW can use for grouping / replacing. */
  tag?: string;
}

interface SubscriptionRow {
  id: string;
  user_id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
}

interface MinimalLogger {
  warn: (obj: unknown, msg?: string) => void;
  error: (obj: unknown, msg?: string) => void;
}

let vapidConfigured: boolean | null = null;

function tryConfigureVapid(): boolean {
  if (vapidConfigured !== null) return vapidConfigured;
  const publicKey = process.env.VAPID_PUBLIC_KEY ?? "";
  const privateKey = process.env.VAPID_PRIVATE_KEY ?? "";
  const subject = process.env.VAPID_SUBJECT ?? "mailto:notifications@trailforge.app";
  if (!publicKey || !privateKey) {
    vapidConfigured = false;
    return false;
  }
  try {
    webpush.setVapidDetails(subject, publicKey, privateKey);
    vapidConfigured = true;
    return true;
  } catch {
    vapidConfigured = false;
    return false;
  }
}

export function getVapidPublicKey(): string | null {
  const k = process.env.VAPID_PUBLIC_KEY;
  return k && k.length > 0 ? k : null;
}

export function isPushConfigured(): boolean {
  // Expo Push needs no server keys, so at least one transport is always available.
  return true;
}

/**
 * Fan a push notification out to every active subscription belonging to any
 * of the given user ids, skipping users who have opted out via
 * `users.push_notifications_enabled = false`. Stale subscriptions are
 * pruned from the DB on the way through. Never throws.
 */
export async function sendPushToUsers(
  userIds: string[],
  payload: PushPayload,
  log: MinimalLogger,
): Promise<void> {
  if (userIds.length === 0) return;
  // We can deliver via Expo even when VAPID isn't configured, so don't
  // short-circuit on tryConfigureVapid() here — the Web Push branch below
  // checks it again before sending to web rows.
  const vapidReady = tryConfigureVapid();
  const supa = getSupabaseAdmin();

  // Filter out opted-out users first so we don't even read their tokens.
  let allowedIds: string[] = userIds;
  try {
    const { data: optRows, error: optErr } = await supa
      .from("users")
      .select("id, push_notifications_enabled")
      .in("id", userIds);
    if (!optErr && optRows) {
      const enabled = new Set(
        (optRows as Array<{ id: string; push_notifications_enabled: boolean | null }>)
          // Default to true so existing users without the column set still receive.
          .filter((r) => r.push_notifications_enabled !== false)
          .map((r) => r.id),
      );
      allowedIds = userIds.filter((id) => enabled.has(id));
    }
  } catch (err) {
    log.warn({ err }, "push: opt-out lookup failed, falling back to send-all");
  }
  if (allowedIds.length === 0) return;

  let subs: SubscriptionRow[] = [];
  try {
    const { data, error } = await supa
      .from("push_subscriptions")
      .select("id, user_id, endpoint, p256dh, auth")
      .in("user_id", allowedIds);
    if (error) {
      log.warn({ err: error }, "push: load subscriptions failed");
      return;
    }
    subs = (data ?? []) as SubscriptionRow[];
  } catch (err) {
    log.warn({ err }, "push: load subscriptions threw");
    return;
  }
  if (subs.length === 0) return;

  const body = JSON.stringify(payload);
  const staleIds: string[] = [];

  // Split by transport so we can fan out web rows via VAPID and expo rows
  // via Expo's HTTP/2 endpoint in parallel.
  const expoSubs = subs.filter((s) => isExpoEndpoint(s.endpoint));
  const webSubs = subs.filter((s) => !isExpoEndpoint(s.endpoint));

  await Promise.all([
    // --- Web Push (VAPID) ---
    vapidReady
      ? Promise.all(
          webSubs.map(async (sub) => {
            const target: PushSubscription = {
              endpoint: sub.endpoint,
              keys: { p256dh: sub.p256dh, auth: sub.auth },
            };
            try {
              await webpush.sendNotification(target, body, {
                TTL: 60 * 60 * 24,
              });
            } catch (err) {
              const wpErr = err as WebPushError;
              if (
                wpErr &&
                (wpErr.statusCode === 404 || wpErr.statusCode === 410)
              ) {
                staleIds.push(sub.id);
              } else {
                log.warn(
                  { err, endpoint: sub.endpoint, status: wpErr?.statusCode },
                  "push: send failed",
                );
              }
            }
          }),
        )
      : Promise.resolve(),
    // --- Expo Push ---
    (async () => {
      if (expoSubs.length === 0) return;
      const tickets = await sendExpoPushBatch(
        expoSubs.map((s) => s.endpoint),
        payload,
        log,
      );
      // Positional match; DeviceNotRegistered means prune.
      for (let i = 0; i < tickets.length; i++) {
        const ticket = tickets[i];
        const sub = expoSubs[i];
        if (!ticket || !sub) continue;
        if (ticket.status === "error") {
          const code = ticket.details?.error;
          if (code === "DeviceNotRegistered") {
            staleIds.push(sub.id);
          } else {
            log.warn(
              { code, message: ticket.message, endpoint: sub.endpoint },
              "push: expo ticket error",
            );
          }
        }
      }
    })(),
  ]);

  if (staleIds.length > 0) {
    try {
      await supa.from("push_subscriptions").delete().in("id", staleIds);
    } catch (err) {
      log.warn({ err, count: staleIds.length }, "push: prune stale subs failed");
    }
  }
}

/** Look up every member of the given group, excluding the actor. */
export async function membersOfGroupExceptActor(
  groupId: string,
  actorUserId: string,
): Promise<string[]> {
  const supa = getSupabaseAdmin();
  const { data, error } = await supa
    .from("group_members")
    .select("user_id")
    .eq("group_id", groupId)
    .neq("user_id", actorUserId);
  if (error) return [];
  return ((data ?? []) as Array<{ user_id: string }>).map((r) => r.user_id);
}

/**
 * Look up every member of the given group who has NOT opted out of push
 * for that group, excluding the actor. Falls back to the full member list
 * if the `push_enabled` column doesn't exist yet (migration not applied).
 */
export async function pushEnabledMembersOfGroup(
  groupId: string,
  actorUserId: string,
  log: MinimalLogger,
): Promise<string[]> {
  const supa = getSupabaseAdmin();
  const { data, error } = await supa
    .from("group_members")
    .select("user_id, push_enabled")
    .eq("group_id", groupId)
    .neq("user_id", actorUserId);
  if (error) {
    if (
      error.code === "42703" ||
      /column .* does not exist/i.test(error.message ?? "")
    ) {
      log.warn(
        { err: error },
        "push: push_enabled column missing, falling back to all members",
      );
      return membersOfGroupExceptActor(groupId, actorUserId);
    }
    return [];
  }
  return (
    (data ?? []) as Array<{ user_id: string; push_enabled: boolean | null }>
  )
    .filter((r) => r.push_enabled !== false)
    .map((r) => r.user_id);
}

interface ActorLookup {
  display_name: string | null;
  email: string | null;
}

async function lookupActorLabel(userId: string): Promise<string> {
  try {
    const supa = getSupabaseAdmin();
    const { data } = await supa
      .from("users")
      .select("display_name, email")
      .eq("id", userId)
      .maybeSingle();
    const u = data as ActorLookup | null;
    if (u?.display_name && u.display_name.trim()) return u.display_name;
    if (u?.email) return u.email.split("@")[0] ?? "A rider";
  } catch {
    // ignore — fall through to default
  }
  return "A rider";
}

/**
 * Notify every member of the given groups (except the actor) that a trail
 * was just shared into their group. Resolves the trail name and group names
 * in one round trip each so the push body reads naturally. Fire-and-forget
 * — never throws.
 */
export async function notifyTrailShared(
  trailId: string,
  groupIds: string[],
  actorUserId: string,
  log: MinimalLogger,
): Promise<void> {
  if (groupIds.length === 0) return;
  if (!isPushConfigured()) return;
  try {
    const supa = getSupabaseAdmin();
    const [trailRes, groupsRes, actorLabel] = await Promise.all([
      supa.from("trails").select("id, name").eq("id", trailId).maybeSingle(),
      supa.from("groups").select("id, name").in("id", groupIds),
      lookupActorLabel(actorUserId),
    ]);
    const trailName =
      ((trailRes.data as { name?: string | null } | null)?.name ?? "a trail").toString();
    const groupNames = new Map<string, string>();
    for (const g of (groupsRes.data ?? []) as Array<{ id: string; name: string }>) {
      groupNames.set(g.id, g.name);
    }
    // Each group fans out independently so the push body can name the group.
    await Promise.all(
      groupIds.map(async (gid) => {
        const recipients = await pushEnabledMembersOfGroup(gid, actorUserId, log);
        if (recipients.length === 0) return;
        const groupName = groupNames.get(gid) ?? "your group";
        await sendPushToUsers(
          recipients,
          {
            title: `New trail in ${groupName}`,
            body: `${actorLabel} shared “${trailName}”`,
            url: `/?trail=${encodeURIComponent(trailId)}`,
            tag: `trail-shared:${trailId}:${gid}`,
          },
          log,
        );
      }),
    );
  } catch (err) {
    log.warn({ err, trailId }, "push: notifyTrailShared failed");
  }
}

/**
 * Notify every existing member of the group (except the joiner) that someone
 * just joined. Fire-and-forget — never throws.
 */
export async function notifyMemberJoined(
  groupId: string,
  joinerUserId: string,
  log: MinimalLogger,
): Promise<void> {
  if (!isPushConfigured()) return;
  try {
    const supa = getSupabaseAdmin();
    const [groupRes, joinerLabel, recipients] = await Promise.all([
      supa.from("groups").select("name").eq("id", groupId).maybeSingle(),
      lookupActorLabel(joinerUserId),
      pushEnabledMembersOfGroup(groupId, joinerUserId, log),
    ]);
    if (recipients.length === 0) return;
    const groupName =
      ((groupRes.data as { name?: string | null } | null)?.name ?? "your group").toString();
    await sendPushToUsers(
      recipients,
      {
        title: `${joinerLabel} joined ${groupName}`,
        body: "Tap to see the group",
        url: `/?group=${encodeURIComponent(groupId)}`,
        tag: `member-joined:${groupId}:${joinerUserId}`,
      },
      log,
    );
  } catch (err) {
    log.warn({ err, groupId }, "push: notifyMemberJoined failed");
  }
}

async function pushEnabledAdminsOfGroup(
  groupId: string,
  actorUserId: string,
  log: MinimalLogger,
): Promise<string[]> {
  const supa = getSupabaseAdmin();
  const { data, error } = await supa
    .from("group_members")
    .select("user_id, push_enabled")
    .eq("group_id", groupId)
    .neq("user_id", actorUserId)
    .in("role", ["owner", "admin"]);
  if (error) {
    if (
      error.code === "42703" ||
      /column .* does not exist/i.test(error.message ?? "")
    ) {
      log.warn(
        { err: error },
        "push: push_enabled column missing, falling back to all admins",
      );
      const retry = await supa
        .from("group_members")
        .select("user_id")
        .eq("group_id", groupId)
        .neq("user_id", actorUserId)
        .in("role", ["owner", "admin"]);
      if (retry.error) return [];
      return ((retry.data ?? []) as Array<{ user_id: string }>).map(
        (r) => r.user_id,
      );
    }
    return [];
  }
  return (
    (data ?? []) as Array<{ user_id: string; push_enabled: boolean | null }>
  )
    .filter((r) => r.push_enabled !== false)
    .map((r) => r.user_id);
}

/**
 * Notify every remaining member of the group (except the actor) that
 * someone left or was removed. When `actorUserId === subjectUserId` the
 * member left voluntarily; when they differ an admin removed them.
 * Fire-and-forget — never throws.
 */
export async function notifyMemberLeft(
  groupId: string,
  actorUserId: string,
  subjectUserId: string,
  log: MinimalLogger,
): Promise<void> {
  if (!isPushConfigured()) return;
  try {
    const supa = getSupabaseAdmin();
    const removedByAdmin = actorUserId !== subjectUserId;
    const [groupRes, subjectLabel, recipients] = await Promise.all([
      supa.from("groups").select("name").eq("id", groupId).maybeSingle(),
      lookupActorLabel(subjectUserId),
      pushEnabledMembersOfGroup(groupId, actorUserId, log),
    ]);
    if (recipients.length === 0) return;
    const groupName =
      ((groupRes.data as { name?: string | null } | null)?.name ?? "your group").toString();
    const title = removedByAdmin
      ? `${subjectLabel} was removed from ${groupName}`
      : `${subjectLabel} left ${groupName}`;
    await sendPushToUsers(
      recipients,
      {
        title,
        body: "Tap to see the group",
        url: `/?group=${encodeURIComponent(groupId)}`,
        tag: `member-left:${groupId}:${subjectUserId}`,
      },
      log,
    );
  } catch (err) {
    log.warn({ err, groupId }, "push: notifyMemberLeft failed");
  }
}

/**
 * Notify every member of the affected groups (except the actor) that a
 * trail was unshared. Mirrors `notifyTrailShared` but with an "unshared"
 * body. Fire-and-forget — never throws.
 */
export async function notifyTrailUnshared(
  trailId: string,
  groupIds: string[],
  actorUserId: string,
  log: MinimalLogger,
): Promise<void> {
  if (groupIds.length === 0) return;
  if (!isPushConfigured()) return;
  try {
    const supa = getSupabaseAdmin();
    const [trailRes, groupsRes, actorLabel] = await Promise.all([
      supa.from("trails").select("id, name").eq("id", trailId).maybeSingle(),
      supa.from("groups").select("id, name").in("id", groupIds),
      lookupActorLabel(actorUserId),
    ]);
    const trailName =
      ((trailRes.data as { name?: string | null } | null)?.name ?? "a trail").toString();
    const groupNames = new Map<string, string>();
    for (const g of (groupsRes.data ?? []) as Array<{
      id: string;
      name: string;
    }>) {
      groupNames.set(g.id, g.name);
    }
    await Promise.all(
      groupIds.map(async (gid) => {
        const recipients = await pushEnabledMembersOfGroup(
          gid,
          actorUserId,
          log,
        );
        if (recipients.length === 0) return;
        const groupName = groupNames.get(gid) ?? "your group";
        await sendPushToUsers(
          recipients,
          {
            title: `Trail removed from ${groupName}`,
            body: `${actorLabel} stopped sharing "${trailName}"`,
            url: `/?group=${encodeURIComponent(gid)}`,
            tag: `trail-unshared:${trailId}:${gid}`,
          },
          log,
        );
      }),
    );
  } catch (err) {
    log.warn({ err, trailId }, "push: notifyTrailUnshared failed");
  }
}

/**
 * Notify every member of the group (except the uploader) that a new photo
 * was shared in the gallery. Fire-and-forget — never throws.
 */
export async function notifyPhotoShared(
  groupId: string,
  uploaderUserId: string,
  log: MinimalLogger,
): Promise<void> {
  if (!isPushConfigured()) return;
  try {
    const supa = getSupabaseAdmin();
    const [groupRes, uploaderLabel, recipients] = await Promise.all([
      supa.from("groups").select("name").eq("id", groupId).maybeSingle(),
      lookupActorLabel(uploaderUserId),
      pushEnabledMembersOfGroup(groupId, uploaderUserId, log),
    ]);
    if (recipients.length === 0) return;
    const groupName =
      ((groupRes.data as { name?: string | null } | null)?.name ?? "your group").toString();
    await sendPushToUsers(
      recipients,
      {
        title: `New photo in ${groupName}`,
        body: `${uploaderLabel} shared a new photo`,
        url: `/?group=${encodeURIComponent(groupId)}`,
        tag: `photo-shared:${groupId}:${uploaderUserId}`,
      },
      log,
    );
  } catch (err) {
    log.warn({ err, groupId }, "push: notifyPhotoShared failed");
  }
}

/**
 * Notify owners/admins of the group (not the decliner) that an invite was
 * declined. Regular members do not see this — it's an administrative
 * signal only. Fire-and-forget — never throws.
 */
export async function notifyInviteDeclined(
  groupId: string,
  declinerUserId: string,
  log: MinimalLogger,
): Promise<void> {
  if (!isPushConfigured()) return;
  try {
    const supa = getSupabaseAdmin();
    const [groupRes, declinerLabel, recipients] = await Promise.all([
      supa.from("groups").select("name").eq("id", groupId).maybeSingle(),
      lookupActorLabel(declinerUserId),
      pushEnabledAdminsOfGroup(groupId, declinerUserId, log),
    ]);
    if (recipients.length === 0) return;
    const groupName =
      ((groupRes.data as { name?: string | null } | null)?.name ?? "your group").toString();
    await sendPushToUsers(
      recipients,
      {
        title: "Invite declined",
        body: `${declinerLabel} declined the invitation to ${groupName}`,
        url: `/?group=${encodeURIComponent(groupId)}`,
        tag: `invite-declined:${groupId}:${declinerUserId}`,
      },
      log,
    );
  } catch (err) {
    log.warn({ err, groupId }, "push: notifyInviteDeclined failed");
  }
}
