import { useEffect, useState } from "react";
import { useUser } from "@clerk/react";
import { syncCurrentUser, type AppUser } from "@/lib/users";

interface CurrentUserState {
  isLoaded: boolean;
  isSignedIn: boolean;
  user: AppUser | null;
  /** The raw Clerk user id when signed-in, otherwise null. */
  userId: string | null;
  /**
   * True when the synced Supabase row carries `is_moderator = true`.
   * Mirrors the server-side flag so UI affordances (e.g. the "Hide"
   * button on route comments) can show without an extra round-trip.
   * Authoritative checks still happen server-side.
   */
  isModerator: boolean;
}

/**
 * Returns the current Clerk-authenticated user merged with the Supabase row
 * we keep in sync via `upsertAppUser`. If the user is signed-out, `user` is
 * `null` and `userId` is `null` — features that need an account should gate
 * on `isSignedIn`.
 *
 * The Supabase upsert runs once per Clerk user id change so other tabs / pages
 * can rely on the row being present.
 */
export function useCurrentUser(): CurrentUserState {
  const { user: clerkUser, isLoaded, isSignedIn } = useUser();
  const [appUser, setAppUser] = useState<AppUser | null>(null);

  useEffect(() => {
    if (!isLoaded) return;
    if (!isSignedIn || !clerkUser) {
      setAppUser(null);
      return;
    }

    const email =
      clerkUser.primaryEmailAddress?.emailAddress ??
      clerkUser.emailAddresses[0]?.emailAddress ??
      null;
    const displayName =
      clerkUser.fullName ||
      [clerkUser.firstName, clerkUser.lastName].filter(Boolean).join(" ") ||
      clerkUser.username ||
      email ||
      "Rider";
    const avatar = clerkUser.imageUrl || null;

    let cancelled = false;
    syncCurrentUser().then((row) => {
      if (cancelled) return;
      setAppUser(
        row ?? {
          id: clerkUser.id,
          email,
          display_name: displayName,
          avatar_url: avatar,
          created_at: new Date().toISOString(),
        },
      );
    });

    return () => {
      cancelled = true;
    };
  }, [isLoaded, isSignedIn, clerkUser]);

  return {
    isLoaded,
    isSignedIn: !!isSignedIn,
    user: appUser,
    userId: isSignedIn && clerkUser ? clerkUser.id : null,
    isModerator: !!appUser?.is_moderator,
  };
}
