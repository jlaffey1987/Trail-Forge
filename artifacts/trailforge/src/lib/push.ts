/**
 * Browser-side helpers for the OS-level push notifications feature.
 *
 * The flow:
 *   1. UI calls `getPushSupport()` to know whether the browser even allows
 *      Web Push (Notification + ServiceWorker + PushManager all present).
 *   2. UI calls `loadPushPreferences()` to read the per-user opt-out flag
 *      (stored on `users.push_notifications_enabled`) plus the live
 *      `Notification.permission` and current SW subscription state.
 *   3. When the user flips the toggle ON, `enablePushOnThisDevice()`:
 *        a) Asks the SW for its registration (registered by App.tsx on boot).
 *        b) Fetches the VAPID public key from the API.
 *        c) Calls `pushManager.subscribe()` (prompting the user for OS
 *           permission if needed).
 *        d) POSTs the resulting endpoint + keys to `/api/me/push/subscribe`.
 *        e) Persists `enabled=true` server-side.
 *   4. When the user flips the toggle OFF, `disablePushOnThisDevice()`
 *      unsubscribes the SW and DELETEs the endpoint server-side, then
 *      persists `enabled=false`.
 *
 * Errors are surfaced as a `PushError` with a `code` field so the UI can
 * render a precise message ("permission denied", "not supported here",
 * "server not configured").
 */

export type PushSupportLevel = "supported" | "permission-needed" | "denied" | "unsupported";

export interface PushPreferences {
  /** Server-side opt-out flag (persisted on the user row). */
  enabled: boolean;
  /** OS / browser permission state for Notification API. */
  permission: NotificationPermission | "default";
  /** True when this device has an active subscription registered. */
  subscribedOnThisDevice: boolean;
  /** True when the browser can do Web Push at all. */
  supported: boolean;
}

export class PushError extends Error {
  code:
    | "unsupported"
    | "permission-denied"
    | "server-unconfigured"
    | "subscribe-failed"
    | "network";

  constructor(
    code: PushError["code"],
    message: string,
  ) {
    super(message);
    this.code = code;
    this.name = "PushError";
  }
}

export function getPushSupportLevel(): PushSupportLevel {
  if (typeof window === "undefined") return "unsupported";
  if (!("serviceWorker" in navigator)) return "unsupported";
  if (!("PushManager" in window)) return "unsupported";
  if (!("Notification" in window)) return "unsupported";
  if (Notification.permission === "denied") return "denied";
  if (Notification.permission === "default") return "permission-needed";
  return "supported";
}

async function getRegistration(): Promise<ServiceWorkerRegistration | null> {
  if (!("serviceWorker" in navigator)) return null;
  try {
    // `ready` resolves once the SW reaches "activated" — this is the
    // strongest signal that pushManager.subscribe() will succeed.
    return await navigator.serviceWorker.ready;
  } catch {
    return null;
  }
}

/** Load the bell-style `{enabled, permission, subscribedOnThisDevice}` snapshot. */
export async function loadPushPreferences(): Promise<PushPreferences> {
  const supported = getPushSupportLevel() !== "unsupported";
  let enabled = true;
  try {
    const res = await fetch("/api/me/push/preferences", {
      credentials: "include",
    });
    if (res.ok) {
      const json = (await res.json()) as { enabled?: boolean };
      enabled = json.enabled !== false;
    }
  } catch {
    // ignore — fall back to the default-true server state
  }
  let subscribed = false;
  if (supported) {
    const reg = await getRegistration();
    if (reg) {
      const sub = await reg.pushManager.getSubscription().catch(() => null);
      subscribed = !!sub;
    }
  }
  return {
    enabled,
    permission:
      typeof Notification !== "undefined"
        ? Notification.permission
        : "default",
    subscribedOnThisDevice: subscribed,
    supported,
  };
}

/**
 * Ask the OS for permission, fetch the VAPID public key, and register a
 * PushSubscription with the server. Persists `enabled=true` on success.
 */
export async function enablePushOnThisDevice(): Promise<void> {
  if (getPushSupportLevel() === "unsupported") {
    throw new PushError(
      "unsupported",
      "This browser doesn't support push notifications",
    );
  }
  if (Notification.permission === "denied") {
    throw new PushError(
      "permission-denied",
      "Push notifications are blocked. Allow notifications in your browser settings to turn them on.",
    );
  }
  if (Notification.permission === "default") {
    const result = await Notification.requestPermission();
    if (result !== "granted") {
      throw new PushError(
        "permission-denied",
        "Permission was not granted",
      );
    }
  }

  // Fetch the VAPID public key from the API. We bail out with a clear
  // server-unconfigured error if the server hasn't been wired up yet.
  let publicKey: string | null = null;
  try {
    const res = await fetch("/api/me/push/public-key", {
      credentials: "include",
    });
    if (res.status === 503) {
      throw new PushError(
        "server-unconfigured",
        "Push notifications aren't configured on the server yet",
      );
    }
    if (!res.ok) {
      throw new PushError("network", "Couldn't reach the push server");
    }
    const j = (await res.json()) as { publicKey?: string };
    publicKey = j.publicKey ?? null;
  } catch (err) {
    if (err instanceof PushError) throw err;
    throw new PushError("network", "Couldn't reach the push server");
  }
  if (!publicKey) {
    throw new PushError(
      "server-unconfigured",
      "Push notifications aren't configured on the server yet",
    );
  }

  const reg = await getRegistration();
  if (!reg) {
    throw new PushError(
      "unsupported",
      "Service worker isn't ready — try reloading the page",
    );
  }
  let subscription: PushSubscription;
  try {
    // Reuse an existing subscription if present (idempotent), otherwise
    // create a fresh one. The applicationServerKey must be a Uint8Array.
    const existing = await reg.pushManager.getSubscription();
    subscription =
      existing ??
      (await reg.pushManager.subscribe({
        userVisibleOnly: true,
        // The DOM lib's PushSubscriptionOptions types `applicationServerKey`
        // as BufferSource backed by an ArrayBuffer, but our helper returns a
        // generic Uint8Array (its underlying buffer is ArrayBufferLike). The
        // runtime accepts either — cast through BufferSource to satisfy the
        // strict TS lib types.
        applicationServerKey:
          urlBase64ToUint8Array(publicKey) as unknown as BufferSource,
      }));
  } catch (err) {
    throw new PushError(
      "subscribe-failed",
      err instanceof Error
        ? err.message
        : "Couldn't subscribe to push notifications",
    );
  }
  const j = subscription.toJSON();
  const subRes = await fetch("/api/me/push/subscribe", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      endpoint: j.endpoint,
      keys: j.keys,
    }),
  });
  if (!subRes.ok) {
    // Roll back the browser-side subscription so we don't end up with a
    // device that thinks it's wired up while the server has no row to
    // dispatch pushes to.
    try {
      await subscription.unsubscribe();
    } catch {
      /* ignore — the server simply has no row anyway */
    }
    throw new PushError(
      subRes.status === 503 ? "server-unconfigured" : "subscribe-failed",
      subRes.status === 503
        ? "Push notifications aren't configured on the server yet"
        : "Server rejected the push subscription",
    );
  }
  // Flip the server-side opt-out back to true in case it was off.
  const prefRes = await fetch("/api/me/push/preferences", {
    method: "PUT",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ enabled: true }),
  });
  if (!prefRes.ok) {
    throw new PushError(
      "subscribe-failed",
      "Couldn't update your notification preference",
    );
  }
}

/** Unsubscribe this device and persist `enabled=false` server-side. */
export async function disablePushOnThisDevice(): Promise<void> {
  const reg = await getRegistration();
  if (reg) {
    const sub = await reg.pushManager.getSubscription().catch(() => null);
    if (sub) {
      const { endpoint } = sub;
      try {
        await sub.unsubscribe();
      } catch {
        // ignore — we still want to clear the server-side row
      }
      try {
        // The DELETE endpoint is idempotent on the server side; we only
        // surface a hard error if the network call fails outright. A 4xx /
        // 5xx response on the cleanup path shouldn't block the user from
        // disabling pushes — we still want the preference flag flipped.
        await fetch("/api/me/push/subscribe", {
          method: "DELETE",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ endpoint }),
        });
      } catch {
        // non-fatal
      }
    }
  }
  const prefRes = await fetch("/api/me/push/preferences", {
    method: "PUT",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ enabled: false }),
  });
  if (!prefRes.ok) {
    throw new PushError(
      "network",
      "Couldn't save your preference — try again",
    );
  }
}

/**
 * Convert a URL-safe base64 VAPID public key (as returned by the server)
 * into the Uint8Array shape that `pushManager.subscribe` requires.
 */
function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = window.atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
  return out;
}
