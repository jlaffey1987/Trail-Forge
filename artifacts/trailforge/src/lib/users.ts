export interface AppUser {
  id: string;
  email: string | null;
  display_name: string | null;
  avatar_url: string | null;
  created_at: string;
}

/**
 * Sync the current Clerk user into the Supabase `users` table.
 *
 * Goes through `POST /api/me/sync` so the API server (with the Supabase
 * service role key) does the upsert — the anon-key client cannot, by
 * RLS policy, write to `users`. The server reads the caller's identity
 * from the Clerk session token; no client-supplied identity is trusted.
 */
export async function syncCurrentUser(): Promise<AppUser | null> {
  try {
    const res = await fetch("/api/me/sync", {
      method: "POST",
      credentials: "include",
    });
    if (!res.ok) {
      if (res.status !== 401) {
        console.error("syncCurrentUser failed:", res.status);
      }
      return null;
    }
    return (await res.json()) as AppUser;
  } catch (err) {
    console.error("syncCurrentUser failed:", err);
    return null;
  }
}

/**
 * Move any session-based saved_trails rows for the given session_id over
 * to the calling Clerk user. Returns the number of rows migrated.
 */
export async function migrateSessionSavedTrails(
  sessionId: string,
): Promise<number | null> {
  try {
    const res = await fetch("/api/me/saved-trails/migrate", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId }),
    });
    if (!res.ok) {
      console.error("migrateSessionSavedTrails failed:", res.status);
      return null;
    }
    const json = (await res.json()) as { migrated: number };
    return json.migrated ?? 0;
  } catch (err) {
    console.error("migrateSessionSavedTrails failed:", err);
    return null;
  }
}

/**
 * Count guest-session saved_trails rows on the device — for the
 * "we found N saved trails on this device" merge prompt.
 */
export async function countSessionSavedTrails(
  sessionId: string,
): Promise<number> {
  try {
    const url = new URL("/api/me/saved-trails/count", window.location.origin);
    url.searchParams.set("sessionId", sessionId);
    const res = await fetch(url.toString(), { credentials: "include" });
    if (!res.ok) return 0;
    const json = (await res.json()) as { count: number };
    return json.count ?? 0;
  } catch {
    return 0;
  }
}
