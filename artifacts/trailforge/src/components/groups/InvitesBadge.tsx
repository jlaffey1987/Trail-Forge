import { useCallback, useEffect, useState } from "react";
import { useUser } from "@clerk/react";
import { listMyInvites } from "@/lib/groups";
import InvitesInbox from "./InvitesInbox";

export default function InvitesBadge() {
  const { isSignedIn, isLoaded } = useUser();
  const [pending, setPending] = useState(0);
  const [open, setOpen] = useState(false);

  const refresh = useCallback(async () => {
    if (!isSignedIn) {
      setPending(0);
      return;
    }
    const invites = await listMyInvites();
    setPending(invites.length);
  }, [isSignedIn]);

  useEffect(() => {
    if (!isLoaded || !isSignedIn) {
      setPending(0);
      return;
    }
    void refresh();
    const id = window.setInterval(() => void refresh(), 60_000);
    return () => window.clearInterval(id);
  }, [isLoaded, isSignedIn, refresh]);

  if (!isSignedIn || pending === 0) return null;

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="flex items-center gap-1 bg-amber-500/20 hover:bg-amber-500/30 border border-amber-500/50 rounded-full px-2 py-1 transition-colors"
        title={`${pending} pending group invite${pending === 1 ? "" : "s"}`}
        data-testid="invites-badge"
      >
        <svg
          viewBox="0 0 24 24"
          className="w-3 h-3 text-amber-300"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
        >
          <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z" />
          <polyline points="22,6 12,13 2,6" />
        </svg>
        <span className="text-[10px] font-bold text-amber-300">{pending}</span>
      </button>
      {open && (
        <InvitesInbox
          onClose={() => {
            setOpen(false);
            void refresh();
          }}
          onChanged={() => void refresh()}
        />
      )}
    </>
  );
}
