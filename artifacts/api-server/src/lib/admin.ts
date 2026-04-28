import { getSupabaseAdmin } from "./supabaseAdmin";

/**
 * Returns true if the given Clerk user_id has been granted the global
 * `system_admins` role. Used to gate the admin-only AI grading, harvest,
 * forum-scan and review-queue endpoints.
 *
 * If the `system_admins` table is missing (migration 0007 not yet applied)
 * we fall back to honouring the optional `SYSTEM_ADMIN_USER_IDS` env var
 * (comma-separated Clerk user ids) so a freshly-deployed environment can
 * still bootstrap the first admin without a SQL round-trip.
 */
export async function isSystemAdmin(userId: string): Promise<boolean> {
  if (!userId) return false;
  const envList = (process.env.SYSTEM_ADMIN_USER_IDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (envList.includes(userId)) return true;

  const supa = getSupabaseAdmin();
  const { data, error } = await supa
    .from("system_admins")
    .select("user_id")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) {
    // Missing table or column => fall back to env-only.
    return false;
  }
  return data != null;
}
