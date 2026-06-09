/**
 * Maps Expo notification taps to in-app navigation. No-op in Expo Go
 * (remote push not supported in SDK 53+).
 */
import Constants from "expo-constants";
import { router } from "expo-router";

type NotificationData = {
  url?: unknown;
  tag?: unknown;
};

type NotificationResponse = {
  notification: {
    request: { content: { data: unknown } };
  };
};

function isExpoGo(): boolean {
  return Constants.appOwnership === "expo";
}

function extractUrl(data: unknown): string | null {
  if (!data || typeof data !== "object") return null;
  const url = (data as NotificationData).url;
  if (typeof url !== "string" || !url.startsWith("/")) return null;
  return url;
}

export function handleNotificationResponse(response: NotificationResponse): void {
  const url = extractUrl(response.notification.request.content.data);
  if (!url) return;
  try {
    router.push(url as never);
  } catch {
    router.push("/" as never);
  }
}

export function subscribeToNotificationTaps(): () => void {
  if (isExpoGo()) {
    return () => undefined;
  }

  let sub: { remove: () => void } | null = null;
  let cancelled = false;

  void import("expo-notifications").then((Notifications) => {
    if (cancelled) return;
    sub = Notifications.addNotificationResponseReceivedListener(
      handleNotificationResponse,
    );
    void Notifications.getLastNotificationResponseAsync()
      .then((last) => {
        if (last) handleNotificationResponse(last);
      })
      .catch(() => undefined);
  }).catch(() => undefined);

  return () => {
    cancelled = true;
    sub?.remove();
  };
}
