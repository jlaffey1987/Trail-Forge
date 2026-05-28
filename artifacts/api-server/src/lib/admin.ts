import { getSupabaseAdmin } from "./supabaseAdmin";
import { isMissingTableError } from "./dbErrors";

/**
 * Admin gating has three "not-admin" states we deliberately surface to the
 * caller so the UI can show a useful explainer instead of an empty page or
 * a silent 403:
 *
 *   migration-missing  The `system_admins` table doesn't exist yet
 *                      (database migration 0007 wasn't applied) AND the
 *                      `SYSTEM_ADMIN_USER_IDS` env bootstrap isn't set
 *                      either. Nobody can be an admin — ops needs to act.
 *   no-admins          The table exists but is empty and `SYSTEM_ADMIN_USER_IDS`
 *                      is unset. Same effect (nobody is admin) but the fix
 *                      is to seed a row, not run a migration.
 *   not-admin          Admins exist but this user isn't one of them.
 *   admin              Caller is an admin (via env or table row).
 *
 * Both gating ("can this request continue?") and discovery ("why am I not
 * seeing admin features?") use the same helper so the messages stay in sync.
 */
export type AdminAccessState =
  | { kind: "admin"; via: "env" | "table" }
  | { kind: "not-admin" }
  | { kind: "no-admins" }
  | { kind: "migration-missing" };

export type AdminAccessCode =
  | "ADMIN_OK"
  | "ADMIN_FORBIDDEN"
  | "ADMIN_NOT_BOOTSTRAPPED"
  | "ADMIN_MIGRATION_MISSING";

export interface AdminAccessExplainer {
  status: 200 | 403 | 503;
  code: AdminAccessCode;
  message: string;
}

export const ADMIN_BOOTSTRAP_HINT =
  "Set SYSTEM_ADMIN_USER_IDS on the API server, or insert your Clerk user id into the system_admins table, to unlock admin features.";

export function explainAdminAccess(state: AdminAccessState): AdminAccessExplainer {
  switch (state.kind) {
    case "admin":
      return { status: 200, code: "ADMIN_OK", message: "Admin access granted." };
    case "migration-missing":
      return {
        status: 503,
        code: "ADMIN_MIGRATION_MISSING",
        message:
          "Admin features are waiting to be turned on — the system_admins table is missing. Apply database migration 0007 (or set SYSTEM_ADMIN_USER_IDS on the API server) to unlock them.",
      };
    case "no-admins":
      return {
        status: 503,
        code: "ADMIN_NOT_BOOTSTRAPPED",
        message: `Admin features are waiting to be turned on — no admins are configured yet. ${ADMIN_BOOTSTRAP_HINT}`,
      };
    case "not-admin":
    default:
      return {
        status: 403,
        code: "ADMIN_FORBIDDEN",
        message: "Admin access required.",
      };
  }
}

export function readEnvAdminList(): string[] {
  return (process.env.SYSTEM_ADMIN_USER_IDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Inspect both the env bootstrap and the `system_admins` table to figure out
 * the caller's effective admin state. See `AdminAccessState` for the four
 * shapes returned. Failures querying Supabase (other than "missing table")
 * fall back to "not-admin" so a flaky check doesn't silently grant access.
 */
export async function getAdminAccessState(
  userId: string | null | undefined,
): Promise<AdminAccessState> {
  const envList = readEnvAdminList();
  if (userId && envList.includes(userId)) {
    return { kind: "admin", via: "env" };
  }

  const supa = getSupabaseAdmin();
  const probe = await supa.from("system_admins").select("user_id").limit(1);
  if (probe.error) {
    if (isMissingTableError(probe.error)) {
      // Migration 0007 not applied. If the env list has entries, this user
      // simply isn't on it (admins exist via env); otherwise nobody is
      // configured at all and ops needs to apply the migration.
      return envList.length > 0 ? { kind: "not-admin" } : { kind: "migration-missing" };
    }
    return { kind: "not-admin" };
  }

  const rows = (probe.data as Array<unknown> | null) ?? [];
  if (rows.length === 0 && envList.length === 0) {
    return { kind: "no-admins" };
  }
  if (!userId) return { kind: "not-admin" };

  const { data } = await supa
    .from("system_admins")
    .select("user_id")
    .eq("user_id", userId)
    .maybeSingle();
  if (data) return { kind: "admin", via: "table" };
  return { kind: "not-admin" };
}

/**
 * Returns true if the given Clerk user_id is an admin. Thin wrapper around
 * `getAdminAccessState` for callers that only care about the boolean answer.
 */
export async function isSystemAdmin(userId: string): Promise<boolean> {
  if (!userId) return false;
  const state = await getAdminAccessState(userId);
  return state.kind === "admin";
}
