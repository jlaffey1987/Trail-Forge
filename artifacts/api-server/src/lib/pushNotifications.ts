/**
 * Web-Push (VAPID) helpers for fanning OS-level notifications out to riders'
 * phones whenever a new row lands in `trail_shares` or `group_members`.
 *
 * Design notes:
 *   * Send is fire-and-forget — callers should *not* await the returned
 *     promise on the request hot path. We log failures via the request
 *     logger and never throw out of `sendPushToUsers` so a flaky push
 *     provider can never poison a successful share / join.
 *   * Subscriptions that come back with HTTP 404/410 are stale (the user
 *     uninstalled the PWA, revoked permission, etc.) — we delete them from
 *     `push_subscriptions` so we stop wasting requests on them.
 *   * If VAPID env vars aren't configured the helpers all become no-ops.
 *     This keeps local dev / tests working without secrets, and lets the
 *     server boot even before the operator generates keys.
 */

import webpush, { type PushSubscription, type WebPushError } from "web-push";
import { getSupabaseAdmin } from "./supabaseAdmin";

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
  return tryConfigureVapid();
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
  if (!tryConfigureVapid()) return;
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

  await Promise.all(
    subs.map(async (sub) => {
      const target: PushSubscription = {
        endpoint: sub.endpoint,
        keys: { p256dh: sub.p256dh, auth: sub.auth },
      };
      try {
        await webpush.sendNotification(target, body, { TTL: 60 * 60 * 24 });
      } catch (err) {
        const wpErr = err as WebPushError;
        if (wpErr && (wpErr.statusCode === 404 || wpErr.statusCode === 410)) {
          // Stale endpoint — push provider says the user has unsubscribed.
          staleIds.push(sub.id);
        } else {
          log.warn(
            { err, endpoint: sub.endpoint, status: wpErr?.statusCode },
            "push: send failed",
          );
        }
      }
    }),
  );

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
