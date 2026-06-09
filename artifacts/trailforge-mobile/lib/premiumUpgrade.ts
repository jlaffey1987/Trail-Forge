import * as Linking from "expo-linking";
import { Alert } from "react-native";

import { PREMIUM_UPGRADE_URL } from "@/lib/appConfig";

/** Open Premium checkout or show a fallback message when billing is not wired yet. */
export async function openPremiumUpgrade(featureName?: string): Promise<void> {
  const apiBase = process.env.EXPO_PUBLIC_API_BASE_URL?.replace(/\/$/, "");
  const url = PREMIUM_UPGRADE_URL ?? (apiBase ? `${apiBase}/premium` : null);

  if (url) {
    const can = await Linking.canOpenURL(url);
    if (can) {
      await Linking.openURL(url);
      return;
    }
  }

  Alert.alert(
    "TrailForge Premium",
    featureName
      ? `${featureName} is included with Premium. Subscription checkout is being set up — check back soon or contact support for early access.`
      : "Premium unlocks turn-by-turn navigation, map filters, and GPX export. Checkout is being set up — check back soon.",
  );
}
