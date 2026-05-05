/**
 * Expo push registration. Returns the device's ExponentPushToken[…]
 * string, or null if the user denied permissions / the device isn't
 * capable of receiving push (e.g. simulators without a paired Apple ID).
 *
 * The token is then POSTed to the backend's `/me/push/subscribe` route
 * via the additive `kind: "expo"` body shape introduced in T002.
 */
import Constants from "expo-constants";
import * as Device from "expo-device";
import * as Notifications from "expo-notifications";
import { Platform } from "react-native";

import { subscribeExpoPushToken } from "@/lib/api";

// Foreground notification handler — show the alert, play sound, do not
// auto-bump the badge count (we manage that ourselves from the inbox).
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

export interface PushRegistrationResult {
  token: string | null;
  reason?: "denied" | "not-device" | "no-project" | "error";
}

export async function registerForPushAndSubscribe(): Promise<PushRegistrationResult> {
  if (!Device.isDevice) {
    // Push tokens are only issued to real devices; the simulator can still
    // receive local notifications, just not remote ones.
    return { token: null, reason: "not-device" };
  }

  // Android 13+ requires explicit POST_NOTIFICATIONS at runtime.
  if (Platform.OS === "android") {
    await Notifications.setNotificationChannelAsync("default", {
      name: "default",
      importance: Notifications.AndroidImportance.DEFAULT,
      lightColor: "#f0a832",
    });
  }

  const existing = await Notifications.getPermissionsAsync();
  let status = existing.status;
  if (status !== "granted") {
    const requested = await Notifications.requestPermissionsAsync();
    status = requested.status;
  }
  if (status !== "granted") {
    return { token: null, reason: "denied" };
  }

  // EAS-provisioned `projectId` is required for production push tokens —
  // Expo Go can fall back to its own dev project, but standalone EAS
  // builds need an explicit value. Look it up from app.json's
  // `extra.eas.projectId` (or the legacy `easConfig.projectId`).
  const easProjectId =
    (Constants.expoConfig?.extra as { eas?: { projectId?: string } } | undefined)
      ?.eas?.projectId ??
    (Constants as unknown as { easConfig?: { projectId?: string } })
      .easConfig?.projectId;

  try {
    // In Expo Go we can call without `projectId` and Expo's dev project
    // handles token issuance. For standalone / EAS builds we MUST pass
    // the project's UUID, otherwise `getExpoPushTokenAsync` throws and
    // the user silently never receives push.
    const tokenResp = await Notifications.getExpoPushTokenAsync(
      easProjectId ? { projectId: easProjectId } : undefined,
    );
    const token = tokenResp.data;
    if (!token) return { token: null, reason: easProjectId ? "error" : "no-project" };
    try {
      await subscribeExpoPushToken(token);
    } catch {
      // Don't fail the whole registration if the round-trip to the
      // backend hits a transient error — the next launch will retry.
    }
    return { token };
  } catch {
    return { token: null, reason: "error" };
  }
}
