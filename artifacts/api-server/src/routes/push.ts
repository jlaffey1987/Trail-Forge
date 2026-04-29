/**
 * Push notification subscription + preferences endpoints for TrailForge.
 *
 *   GET    /api/me/push/public-key    — VAPID public key for pushManager.subscribe
 *   POST   /api/me/push/subscribe     — register / refresh a PushSubscription
 *   DELETE /api/me/push/subscribe     — unregister by endpoint
 *   GET    /api/me/push/preferences   — { enabled: boolean }
 *   PUT    /api/me/push/preferences   — toggle the per-user opt-out
 *
 * The actual push fan-out lives next to the source-of-truth writes (see
 * `lib/pushNotifications.ts` + the share / join handlers in `groups.ts` and
 * `trails.ts`) so we keep this file focused on subscription lifecycle.
 */

import {
  Router,
  type IRouter,
  type Request,
  type Response,
  type NextFunction,
} from "express";
import { getAuth } from "@clerk/express";
import { z } from "zod";
import { getSupabaseAdmin } from "../lib/supabaseAdmin";
import { getVapidPublicKey, isPushConfigured } from "../lib/pushNotifications";

const router: IRouter = Router();

interface AuthedHandler {
  (req: Request, res: Response, userId: string): Promise<void>;
}

function requireAuth(handler: AuthedHandler) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const auth = getAuth(req);
    if (!auth.userId) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    try {
      await handler(req, res, auth.userId);
    } catch (err) {
      next(err);
    }
  };
}

function isMissingTableError(err: { code?: string; message?: string } | null): boolean {
  if (!err) return false;
  return (
    err.code === "42P01" ||
    err.code === "PGRST205" ||
    /relation .* does not exist/i.test(err.message ?? "") ||
    /Could not find the table/i.test(err.message ?? "")
  );
}

function isMissingColumnError(err: { code?: string; message?: string } | null): boolean {
  if (!err) return false;
  return err.code === "42703" || /column .* does not exist/i.test(err.message ?? "");
}

// Known push-provider hostnames. Web Push endpoints are issued by the
// browser's push service (FCM for Chromium, Mozilla autopush for Firefox,
// Apple/WindowsPush for Safari/Edge). Restricting subscriptions to these
// hosts prevents an attacker from registering an arbitrary URL and
// turning our `web-push` fan-out into an SSRF / outbound-request gadget.
const ALLOWED_PUSH_HOSTS = [
  /\.googleapis\.com$/i, // FCM (fcm.googleapis.com)
  /\.push\.services\.mozilla\.com$/i, // Mozilla autopush
  /\.push\.apple\.com$/i, // APNs (Web Push on Safari)
  /\.notify\.windows\.com$/i, // WNS
  /\.notify\.live\.net$/i, // WNS legacy
];

function isAllowedPushEndpoint(rawUrl: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:") return false;
  const host = parsed.hostname.toLowerCase();
  return ALLOWED_PUSH_HOSTS.some((re) => re.test(host));
}

const SubscribeBody = z
  .object({
    endpoint: z
      .string()
      .url()
      .max(2048)
      .refine(isAllowedPushEndpoint, {
        message: "Endpoint host is not a recognised push provider",
      }),
    keys: z.object({
      p256dh: z.string().min(1).max(512),
      auth: z.string().min(1).max(512),
    }),
  });

const UnsubscribeBody = z.object({
  endpoint: z.string().url().max(2048),
});

const PreferencesBody = z.object({
  enabled: z.boolean(),
});

// ---------------------------------------------------------------------------
// Public VAPID key — the browser needs it before it can call
// `pushManager.subscribe({ applicationServerKey })`. Returns 503 when the
// server hasn't been configured with a key yet so the UI can show a clear
// "push notifications aren't set up on this server" message instead of
// silently failing during subscription.
// ---------------------------------------------------------------------------

router.get("/me/push/public-key", (_req, res) => {
  const key = getVapidPublicKey();
  if (!key) {
    res.status(503).json({
      error: "Push notifications are not configured on this server",
      configured: false,
    });
    return;
  }
  res.json({ publicKey: key, configured: isPushConfigured() });
});

// ---------------------------------------------------------------------------
// Persist a PushSubscription. We key on (endpoint) so re-subscribing from the
// same browser cleanly upserts. Each row is also bound to a user_id so the
// fan-out helper can look subscriptions up by user.
// ---------------------------------------------------------------------------

router.post(
  "/me/push/subscribe",
  requireAuth(async (req, res, userId) => {
    const parsed = SubscribeBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid subscription payload" });
      return;
    }
    const ua =
      typeof req.headers["user-agent"] === "string"
        ? req.headers["user-agent"].slice(0, 512)
        : null;
    const supa = getSupabaseAdmin();
    const nowIso = new Date().toISOString();
    const row = {
      user_id: userId,
      endpoint: parsed.data.endpoint,
      p256dh: parsed.data.keys.p256dh,
      auth: parsed.data.keys.auth,
      user_agent: ua,
      last_seen_at: nowIso,
    };
    const { error } = await supa
      .from("push_subscriptions")
      .upsert(row, { onConflict: "endpoint" });
    if (error) {
      if (isMissingTableError(error)) {
        res.status(503).json({
          error:
            "Push notifications not yet provisioned — apply migration 0014_push_subscriptions.sql",
        });
        return;
      }
      req.log.error({ err: error }, "push subscribe upsert failed");
      res.status(500).json({ error: "Failed to register subscription" });
      return;
    }
    res.json({ ok: true });
  }),
);

// ---------------------------------------------------------------------------
// Forget a single subscription (the device's own endpoint). Idempotent — the
// caller can fire this even if the row no longer exists.
// ---------------------------------------------------------------------------

router.delete(
  "/me/push/subscribe",
  requireAuth(async (req, res, userId) => {
    const parsed = UnsubscribeBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid endpoint" });
      return;
    }
    const supa = getSupabaseAdmin();
    const { error } = await supa
      .from("push_subscriptions")
      .delete()
      .eq("user_id", userId)
      .eq("endpoint", parsed.data.endpoint);
    if (error && !isMissingTableError(error)) {
      req.log.error({ err: error }, "push unsubscribe failed");
      res.status(500).json({ error: "Failed to unregister subscription" });
      return;
    }
    res.json({ ok: true });
  }),
);

// ---------------------------------------------------------------------------
// Read the per-user push opt-out flag. Defaults to true so a user without
// the column set yet still has the bell in its "willing to receive" state.
// ---------------------------------------------------------------------------

router.get(
  "/me/push/preferences",
  requireAuth(async (req, res, userId) => {
    const supa = getSupabaseAdmin();
    const { data, error } = await supa
      .from("users")
      .select("push_notifications_enabled")
      .eq("id", userId)
      .maybeSingle();
    if (error) {
      if (isMissingColumnError(error) || isMissingTableError(error)) {
        res.json({ enabled: true });
        return;
      }
      req.log.error({ err: error }, "push preferences load failed");
      res.status(500).json({ error: "Failed to load preferences" });
      return;
    }
    const v = (data as { push_notifications_enabled?: boolean | null } | null)
      ?.push_notifications_enabled;
    res.json({ enabled: v !== false });
  }),
);

// ---------------------------------------------------------------------------
// Update the per-user push opt-out flag. Returning the new value gives the
// client a deterministic confirmation it can render straight back into the
// settings toggle without re-fetching.
// ---------------------------------------------------------------------------

router.put(
  "/me/push/preferences",
  requireAuth(async (req, res, userId) => {
    const parsed = PreferencesBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid preferences payload" });
      return;
    }
    const supa = getSupabaseAdmin();
    const { error } = await supa
      .from("users")
      .update({ push_notifications_enabled: parsed.data.enabled })
      .eq("id", userId);
    if (error) {
      if (isMissingColumnError(error) || isMissingTableError(error)) {
        res.status(503).json({
          error:
            "Push notifications not yet provisioned — apply migration 0014_push_subscriptions.sql",
        });
        return;
      }
      req.log.error({ err: error }, "push preferences update failed");
      res.status(500).json({ error: "Failed to update preferences" });
      return;
    }
    res.json({ enabled: parsed.data.enabled });
  }),
);

export default router;
