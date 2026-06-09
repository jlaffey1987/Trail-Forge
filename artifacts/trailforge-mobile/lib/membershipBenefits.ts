/**
 * Free vs Premium copy — keep in sync with lib/tierPolicy.ts gates.
 */

export interface MembershipBullet {
  icon: "check" | "lock";
  text: string;
}

export const FREE_TIER_HEADLINE =
  "Everything you need to explore, plan, and contribute";

export const FREE_TIER_ITEMS: MembershipBullet[] = [
  { icon: "check", text: "Browse the map and see legal trails near you" },
  { icon: "check", text: "Plan a full day's ride — link trails on the map" },
  { icon: "check", text: "Save routes as drafts on your phone" },
  { icon: "check", text: "Browse community routes in Discover" },
  { icon: "check", text: "Add trails to the map for other riders" },
  { icon: "check", text: "Log trails as ridden — ranks, badges, and mileage" },
  { icon: "check", text: "Export GPX of trails you've drawn or recorded" },
];

export const PREMIUM_TIER_HEADLINE =
  "What you need when you're ready to ride for real";

export const PREMIUM_TIER_ITEMS: MembershipBullet[] = [
  { icon: "lock", text: "Turn-by-turn navigation on roads and trails" },
  { icon: "lock", text: "Voice prompts and off-route warnings" },
  { icon: "lock", text: "Filter the map by difficulty (1–10) and bike type" },
  { icon: "lock", text: "Publish saved routes to Discover" },
  { icon: "lock", text: "Keep trails and routes private, or share with groups" },
  { icon: "lock", text: "Download full route GPX and save routes offline" },
];

export const PREMIUM_WHY_PARAGRAPH =
  "Free is great for scouting and planning. Premium is for the day you're actually riding — when you need clear directions on unfamiliar trails, filters matched to your bike and skill, and the option to keep local spots private.";

export const PREMIUM_HOW_STEPS = [
  "Tap Get Premium below — checkout opens in your browser.",
  "Sign in with the same TrailForge account you use in the app.",
  "Premium applies automatically. Come back to the app and start navigating.",
];

/** Short list for UpgradePrompt modal. */
export const PREMIUM_UPGRADE_BENEFITS = [
  "Turn-by-turn navigation on roads and trails",
  "Filter the map by difficulty and bike type",
  "Publish routes and keep trails private",
  "Download route GPX and save offline",
];
