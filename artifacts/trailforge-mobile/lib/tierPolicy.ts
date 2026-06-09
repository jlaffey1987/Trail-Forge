/**
 * Free vs Premium capability checks — single source of truth for gating.
 */

export type RoutePrivacy = "private" | "groups" | "public";

export type TrailVisibility = "private" | "public" | "group";

/** Browse, plan on map, save route drafts. */
export function canSaveRouteDraft(): boolean {
  return true;
}

export function canNavigate(isPremium: boolean): boolean {
  return isPremium;
}

/** Multi-trail composed routes — Premium only. */
export function canExportRouteGpx(isPremium: boolean): boolean {
  return isPremium;
}

export function canDownloadRouteOffline(isPremium: boolean): boolean {
  return isPremium;
}

/** Publish saved route to Discover — Premium only. Free saves stay private drafts. */
export function canPublishRouteToCommunity(isPremium: boolean): boolean {
  return isPremium;
}

/** GPX export of a single user-drawn/recorded trail — allowed on free tier. */
export function canExportOwnTrailGpx(_isPremium: boolean): boolean {
  return true;
}

export function allowedTrailVisibilities(isPremium: boolean): TrailVisibility[] {
  if (isPremium) return ["private", "public", "group"];
  return ["public"];
}

export function defaultTrailVisibility(isPremium: boolean): TrailVisibility {
  return isPremium ? "private" : "public";
}

export function allowedRoutePrivacyOptions(isPremium: boolean): RoutePrivacy[] {
  if (isPremium) return ["private", "groups", "public"];
  return ["private"];
}

export function routePrivacyLabel(privacy: RoutePrivacy, isPremium: boolean): string {
  if (!isPremium) return "My draft";
  if (privacy === "public") return "Community";
  if (privacy === "groups") return "My groups";
  return "Just me";
}

export function savedRouteIsPublicForApi(
  privacy: RoutePrivacy,
  isPremium: boolean,
): boolean {
  return isPremium && privacy === "public";
}
