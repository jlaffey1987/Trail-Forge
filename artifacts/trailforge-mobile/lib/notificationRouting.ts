/**
 * Maps Expo notification taps to in-app navigation. The push payload's
 * `data.url` is a path string like `/trail/abc` or `/messages/room-1`
 * which we hand straight to expo-router. Falls back to `/` for unknown
 * payloads so a malformed push never wedges the app on a blank screen.
 */
import * as Notifications from "expo-notifications";
import { router } from "expo-router";

type NotificationData = {
  url?: unknown;
  tag?: unknown;
};

function extractUrl(data: unknown): string | null {
  if (!data || typeof data !== "object") return null;
  const url = (data as NotificationData).url;
  if (typeof url !== "string" || !url.startsWith("/")) return null;
  return url;
}

export function handleNotificationResponse(
  response: Notifications.NotificationResponse,
): void {
  const url = extractUrl(response.notification.request.content.data);
  if (!url) return;
  try {
    router.push(url as never);
  } catch {
    // Bad route — fall back to home.
    router.push("/" as never);
  }
}

/**
 * Subscribes to notification taps. Returns an unsubscribe fn for the
 * caller to wire into a useEffect cleanup. Also drains any cold-start
 * notification (the tap that launched the app) so the deep link still
 * fires even when the listener registers after the OS delivers it.
 */
export function subscribeToNotificationTaps(): () => void {
  const sub = Notifications.addNotificationResponseReceivedListener(
    handleNotificationResponse,
  );

  // Cold-start: if the app was launched by tapping a push, replay it.
  Notifications.getLastNotificationResponseAsync()
    .then((last) => {
      if (last) handleNotificationResponse(last);
    })
    .catch(() => {
      /* ignore */
    });

  return () => sub.remove();
}
