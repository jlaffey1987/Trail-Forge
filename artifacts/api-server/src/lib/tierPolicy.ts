import type { getSupabaseAdmin } from "./supabaseAdmin";
import { isMissingColumnError } from "./dbErrors";

type Supa = ReturnType<typeof getSupabaseAdmin>;

export const PREMIUM_TRAIL_VISIBILITY_ERROR =
  "Private and group trails require Premium. Free accounts publish to the community map.";

export const PREMIUM_PUBLISH_ROUTE_ERROR =
  "Publishing routes to the community requires Premium.";

/** Load premium flag from users table; defaults to false if unknown. */
export async function getUserIsPremium(
  supa: Supa,
  userId: string,
): Promise<boolean> {
  const { data, error } = await supa
    .from("users")
    .select("is_premium")
    .eq("id", userId)
    .maybeSingle();
  if (error && isMissingColumnError(error)) return false;
  if (error || !data) return false;
  return (data as { is_premium?: boolean | null }).is_premium === true;
}

/** Free tier may only create public community trails. */
export function freeUserTrailCreateBlocked(input: {
  privacy?: "private" | "public" | "group";
  groupIds: string[];
}): boolean {
  if (input.privacy === "private" || input.privacy === "group") return true;
  return input.groupIds.length > 0;
}

/** Free tier may not change trail to private or group visibility. */
export function freeUserTrailUpdateBlocked(input: {
  privacy?: "private" | "public" | "group";
  isPublic?: boolean;
  groupIds?: string[] | null;
}): boolean {
  if (input.privacy === "private" || input.privacy === "group") return true;
  if (input.isPublic === false) return true;
  if (input.groupIds != null && input.groupIds.length > 0) return true;
  return false;
}
