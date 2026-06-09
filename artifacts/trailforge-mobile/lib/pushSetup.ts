/**
 * Expo push registration. Returns the device's ExponentPushToken[…]
 * string, or null if the user denied permissions / the device isn't
 * capable of receiving push (e.g. simulators without a paired Apple ID).
 *
 * Skipped in Expo Go — remote push was removed from Expo Go in SDK 53+.
 */
import Constants from "expo-constants";
import * as Device from "expo-device";
import { Platform } from "react-native";

import { subscribeExpoPushToken } from "@/lib/api";

export interface PushRegistrationResult {
  token: string | null;
  reason?: "denied" | "not-device" | "no-project" | "error" | "expo-go";
}

function isExpoGo(): boolean {
  return Constants.appOwnership === "expo";
}

async function getNotificationsModule() {
  return import("expo-notifications");
}

export async function registerForPushAndSubscribe(): Promise<PushRegistrationResult> {
  if (isExpoGo()) {
    return { token: null, reason: "expo-go" };
  }

  if (!Device.isDevice) {
    return { token: null, reason: "not-device" };
  }

  const Notifications = await getNotificationsModule();

  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: true,
      shouldSetBadge: false,
    }),
  });

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

  const easProjectId =
    (Constants.expoConfig?.extra as { eas?: { projectId?: string } } | undefined)
      ?.eas?.projectId
    ?? (Constants as unknown as { easConfig?: { projectId?: string } })
      .easConfig?.projectId;

  try {
    const tokenResp = await Notifications.getExpoPushTokenAsync(
      easProjectId ? { projectId: easProjectId } : undefined,
    );
    const token = tokenResp.data;
    if (!token) return { token: null, reason: easProjectId ? "error" : "no-project" };
    try {
      await subscribeExpoPushToken(token);
    } catch {
      // Backend subscribe is best-effort; next launch retries.
    }
    return { token };
  } catch {
    return { token: null, reason: "error" };
  }
}
