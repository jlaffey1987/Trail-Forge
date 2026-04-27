import { useEffect, useRef, useState } from "react";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { getSessionId, clearSessionId } from "@/lib/supabase";
import { countSessionSavedTrails, migrateSessionSavedTrails } from "@/lib/users";

const PROMPT_DISMISSED_KEY = "trailforge_merge_prompt_dismissed";

/**
 * One-time prompt shown after first sign-in if the device has session-bound
 * saved_trails rows. Offers to merge them into the freshly signed-in account.
 *
 * State machine:
 *   idle → checking → (none) idle
 *   checking → prompt → migrating → done
 *   prompt → dismissed (skip) → done
 */
export default function SavedTrailsMergePrompt() {
  const { isLoaded, isSignedIn, userId } = useCurrentUser();
  const [count, setCount] = useState<number | null>(null);
  const [phase, setPhase] = useState<"idle" | "prompt" | "migrating" | "done">("idle");
  const [migratedCount, setMigratedCount] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const checkedForUserRef = useRef<string | null>(null);

  useEffect(() => {
    if (!isLoaded || !isSignedIn || !userId) return;
    if (checkedForUserRef.current === userId) return;
    checkedForUserRef.current = userId;

    // Already merged / dismissed for this user on this device?
    const dismissedFor = localStorage.getItem(PROMPT_DISMISSED_KEY);
    if (dismissedFor === userId) return;

    const sessionId = localStorage.getItem("trailforge_session_id");
    if (!sessionId) return;

    countSessionSavedTrails(sessionId).then((n) => {
      if (n > 0) {
        setCount(n);
        setPhase("prompt");
      } else {
        // Nothing to merge — silently dismiss for this user.
        localStorage.setItem(PROMPT_DISMISSED_KEY, userId);
      }
    });
  }, [isLoaded, isSignedIn, userId]);

  if (phase === "idle" || phase === "done") return null;
  if (!userId) return null;

  const sessionId = getSessionId();

  const handleMerge = async () => {
    setPhase("migrating");
    setError(null);
    const migrated = await migrateSessionSavedTrails(sessionId);
    if (migrated == null) {
      setError("Could not migrate your saved trails. Please try again.");
      setPhase("prompt");
      return;
    }
    setMigratedCount(migrated);
    localStorage.setItem(PROMPT_DISMISSED_KEY, userId);
    clearSessionId();
    setPhase("done");
  };

  const handleSkip = () => {
    localStorage.setItem(PROMPT_DISMISSED_KEY, userId);
    setPhase("done");
  };

  return (
    <div
      className="fixed inset-0 z-[3000] flex items-center justify-center px-4"
      style={{ background: "rgba(0,0,0,0.7)", backdropFilter: "blur(4px)" }}
      data-testid="merge-prompt-overlay"
    >
      <div className="w-full max-w-sm bg-[hsl(22,15%,11%)] border border-amber-500/30 rounded-2xl overflow-hidden shadow-2xl">
        <div className="p-5">
          <div className="flex items-center gap-2.5 mb-3">
            <div className="w-9 h-9 rounded-lg bg-amber-500/20 border border-amber-500/40 flex items-center justify-center">
              <svg viewBox="0 0 24 24" className="w-5 h-5 text-amber-400" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
              </svg>
            </div>
            <h2 className="text-base font-bold text-stone-100">Link your saved trails?</h2>
          </div>
          <p className="text-sm text-stone-300 leading-relaxed">
            We found{" "}
            <span className="font-bold text-amber-400">
              {count} saved trail{count === 1 ? "" : "s"}
            </span>{" "}
            on this device. Link them to your account so you can access them from anywhere.
          </p>
          {error && (
            <p className="mt-3 text-xs text-red-400 bg-red-900/30 border border-red-800/40 rounded p-2">
              {error}
            </p>
          )}
          <div className="mt-5 flex gap-2">
            <button
              onClick={handleSkip}
              disabled={phase === "migrating"}
              className="flex-1 py-2.5 rounded-lg text-xs font-semibold text-stone-300 border border-stone-700 hover:bg-stone-800/60 transition-colors disabled:opacity-50"
              data-testid="merge-prompt-skip"
            >
              Not now
            </button>
            <button
              onClick={handleMerge}
              disabled={phase === "migrating"}
              className="flex-1 py-2.5 rounded-lg text-xs font-bold uppercase tracking-wider text-stone-900 transition-colors disabled:opacity-60 flex items-center justify-center gap-2"
              style={{ background: "linear-gradient(135deg, #d4870c, #f0a832)" }}
              data-testid="merge-prompt-confirm"
            >
              {phase === "migrating" ? (
                <>
                  <span className="w-3 h-3 border-2 border-stone-900/40 border-t-stone-900 rounded-full animate-spin"></span>
                  Linking...
                </>
              ) : (
                "Link to my account"
              )}
            </button>
          </div>
          <p className="mt-3 text-[10px] text-stone-500 text-center">
            You can always view your trails on the My Trails tab.
          </p>
        </div>
      </div>
    </div>
  );
}
