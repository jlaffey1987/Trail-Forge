import { useEffect, useState } from "react";
import { useUser } from "@clerk/react";
import { useLocation } from "wouter";
import {
  type InviteLookupResponse,
  acceptInvite,
  lookupInvite,
} from "@/lib/groups";

const basePath = (import.meta.env.BASE_URL ?? "/").replace(/\/$/, "");

interface Props {
  token: string;
}

export default function InviteAcceptPage({ token }: Props) {
  const { isLoaded, isSignedIn } = useUser();
  const [, setLocation] = useLocation();
  const [lookup, setLookup] = useState<InviteLookupResponse | null>(null);
  const [loadingLookup, setLoadingLookup] = useState(true);
  const [accepting, setAccepting] = useState(false);
  const [result, setResult] = useState<{ ok: true; group_id: string } | { error: string } | null>(null);

  useEffect(() => {
    setLoadingLookup(true);
    lookupInvite(token).then((d) => {
      setLookup(d);
      setLoadingLookup(false);
    });
  }, [token]);

  const handleAccept = async () => {
    setAccepting(true);
    const r = await acceptInvite(token);
    setAccepting(false);
    if (!r) {
      setResult({ error: "Network error" });
      return;
    }
    if ("ok" in r) {
      setResult(r);
    } else {
      setResult({ error: r.error });
    }
  };

  return (
    <div className="flex min-h-[100dvh] items-center justify-center bg-[hsl(22,15%,8%)] px-4">
      <div className="w-full max-w-sm bg-[hsl(22,15%,11%)] border border-amber-500/30 rounded-2xl p-6 shadow-2xl" data-testid="invite-accept-page">
        <div className="flex items-center gap-2 mb-3">
          <div
            className="w-8 h-8 rounded-lg flex items-center justify-center"
            style={{ background: "linear-gradient(135deg, #d4870c, #f0a832)" }}
          >
            <svg viewBox="0 0 24 24" className="w-4 h-4 text-stone-900" fill="currentColor">
              <path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7z" />
            </svg>
          </div>
          <h1 className="text-base font-black tracking-widest uppercase text-stone-100" style={{ letterSpacing: "0.18em" }}>
            TrailForge
          </h1>
        </div>

        {loadingLookup ? (
          <p className="text-xs text-stone-400 py-6 text-center">Looking up invite…</p>
        ) : !lookup ? (
          <div>
            <h2 className="text-base font-bold text-red-400 uppercase tracking-wider mb-2">Invite not found</h2>
            <p className="text-xs text-stone-400 mb-4">The link is invalid, was revoked, or has been removed.</p>
            <button
              onClick={() => setLocation("/")}
              className="w-full py-2.5 rounded-lg text-xs font-bold uppercase tracking-wider text-stone-900"
              style={{ background: "linear-gradient(135deg, #d4870c, #f0a832)" }}
              data-testid="invite-go-home"
            >
              Open TrailForge
            </button>
          </div>
        ) : lookup.expired ? (
          <div>
            <h2 className="text-base font-bold text-red-400 uppercase tracking-wider mb-2">Invite expired</h2>
            <p className="text-xs text-stone-400 mb-4">Ask the group owner to send you a new invite link.</p>
            <button
              onClick={() => setLocation("/")}
              className="w-full py-2.5 rounded-lg text-xs font-bold uppercase tracking-wider text-stone-900"
              style={{ background: "linear-gradient(135deg, #d4870c, #f0a832)" }}
            >
              Open TrailForge
            </button>
          </div>
        ) : lookup.accepted ? (
          <div>
            <h2 className="text-base font-bold text-amber-400 uppercase tracking-wider mb-2">Already used</h2>
            <p className="text-xs text-stone-400 mb-4">This invite link has already been used.</p>
            <button
              onClick={() => setLocation("/")}
              className="w-full py-2.5 rounded-lg text-xs font-bold uppercase tracking-wider text-stone-900"
              style={{ background: "linear-gradient(135deg, #d4870c, #f0a832)" }}
            >
              Open TrailForge
            </button>
          </div>
        ) : result && "ok" in result ? (
          <div>
            <h2 className="text-base font-bold text-green-400 uppercase tracking-wider mb-2">You're in!</h2>
            <p className="text-xs text-stone-400 mb-4">
              You've joined <span className="text-amber-300 font-bold">{lookup.group?.name ?? "the group"}</span>.
            </p>
            <button
              onClick={() => setLocation("/")}
              className="w-full py-2.5 rounded-lg text-xs font-bold uppercase tracking-wider text-stone-900"
              style={{ background: "linear-gradient(135deg, #d4870c, #f0a832)" }}
              data-testid="invite-success-continue"
            >
              Continue
            </button>
          </div>
        ) : (
          <div>
            <h2 className="text-base font-bold text-amber-400 uppercase tracking-wider mb-2">Group invite</h2>
            <p className="text-sm text-stone-200 mb-1">
              You've been invited to join <span className="text-amber-300 font-bold">{lookup.group?.name ?? "a group"}</span>.
            </p>
            {lookup.group?.description && (
              <p className="text-xs text-stone-400 mb-3 line-clamp-3">{lookup.group.description}</p>
            )}
            {result && "error" in result && (
              <p className="text-xs text-red-300 mb-3" data-testid="invite-accept-error">{result.error}</p>
            )}
            {!isLoaded ? (
              <p className="text-xs text-stone-400 py-3 text-center">…</p>
            ) : !isSignedIn ? (
              <div className="space-y-2">
                <p className="text-xs text-stone-400 mb-1">Sign in or create an account to accept this invite.</p>
                <button
                  onClick={() => {
                    const next = encodeURIComponent(`${basePath}/invite/${encodeURIComponent(token)}`);
                    setLocation(`/sign-in?redirect_url=${next}`);
                  }}
                  className="w-full py-2.5 rounded-lg text-xs font-bold uppercase tracking-wider text-stone-900"
                  style={{ background: "linear-gradient(135deg, #d4870c, #f0a832)" }}
                  data-testid="invite-sign-in"
                >
                  Sign in to accept
                </button>
                <button
                  onClick={() => {
                    const next = encodeURIComponent(`${basePath}/invite/${encodeURIComponent(token)}`);
                    setLocation(`/sign-up?redirect_url=${next}`);
                  }}
                  className="w-full py-2 rounded-lg text-[11px] font-bold uppercase tracking-wider text-stone-300 border border-stone-700"
                  data-testid="invite-sign-up"
                >
                  Create account
                </button>
              </div>
            ) : (
              <button
                onClick={() => void handleAccept()}
                disabled={accepting}
                className="w-full py-3 rounded-lg text-xs font-bold uppercase tracking-wider text-stone-900 disabled:opacity-50"
                style={{ background: "linear-gradient(135deg, #d4870c, #f0a832)" }}
                data-testid="invite-accept-btn"
              >
                {accepting ? "Joining…" : "Accept invite"}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
