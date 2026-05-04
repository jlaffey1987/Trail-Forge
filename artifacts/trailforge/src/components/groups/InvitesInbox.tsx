import { useCallback, useEffect, useState } from "react";
import { useUser } from "@clerk/react";
import { useLocation } from "wouter";
import {
  type MyInvite,
  acceptMyInvite,
  declineMyInvite,
  formatExpiry,
  listMyInvites,
} from "@/lib/groups";

interface Props {
  onClose: () => void;
  onChanged?: () => void;
}

export default function InvitesInbox({ onClose, onChanged }: Props) {
  const { isSignedIn } = useUser();
  const [, setLocation] = useLocation();
  const [items, setItems] = useState<MyInvite[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    const list = await listMyInvites();
    setItems(list);
    setLoading(false);
  }, []);

  useEffect(() => {
    if (!isSignedIn) {
      setItems([]);
      setLoading(false);
      return;
    }
    void refresh();
  }, [isSignedIn, refresh]);

  if (!isSignedIn) return null;

  const handleAccept = async (inv: MyInvite) => {
    setError(null);
    setBusyId(inv.id);
    const res = await acceptMyInvite(inv.id);
    setBusyId(null);
    if ("error" in res) {
      setError(res.error || "Could not accept invite");
      return;
    }
    onChanged?.();
    onClose();
    setLocation(`/trails?group=${res.group_id}`);
  };

  const handleDecline = async (inv: MyInvite) => {
    setError(null);
    setBusyId(inv.id);
    const ok = await declineMyInvite(inv.id);
    setBusyId(null);
    if (!ok) {
      setError("Could not decline invite");
      return;
    }
    onChanged?.();
    setItems((cur) => cur.filter((x) => x.id !== inv.id));
  };

  return (
    <div
      className="fixed inset-0 z-[3060] flex flex-col"
      style={{ background: "rgba(0,0,0,0.85)", backdropFilter: "blur(3px)" }}
      role="dialog"
      aria-modal="true"
      data-testid="invites-inbox"
    >
      <div
        className="mt-auto rounded-t-2xl overflow-hidden flex flex-col"
        style={{ background: "hsl(22,15%,9%)", maxHeight: "80vh" }}
      >
        <div className="flex justify-center pt-3 pb-1 shrink-0">
          <div className="w-10 h-1 rounded-full bg-stone-700"></div>
        </div>
        <div className="flex items-center justify-between px-4 py-3 border-b border-[hsl(30,12%,16%)] shrink-0">
          <div>
            <h2 className="text-base font-bold text-amber-400 uppercase tracking-widest">
              Invites
            </h2>
            <p className="text-[11px] text-stone-500 mt-0.5">
              {items.length === 0
                ? "Nothing pending"
                : `${items.length} pending invite${items.length === 1 ? "" : "s"}`}
            </p>
          </div>
          <button
            onClick={onClose}
            className="text-xs text-stone-500 hover:text-red-400"
            data-testid="invites-inbox-close"
          >
            Close
          </button>
        </div>

        <div className="overflow-y-auto px-4 py-4 space-y-2">
          {loading && (
            <div className="text-xs text-stone-500 py-4 text-center">Loading…</div>
          )}
          {!loading && items.length === 0 && (
            <div className="text-xs text-stone-500 py-6 text-center">
              You're all caught up.
            </div>
          )}
          {error && (
            <div className="bg-red-900/40 border border-red-500/40 rounded-lg px-3 py-2">
              <p className="text-xs text-red-300" data-testid="invites-inbox-error">
                {error}
              </p>
            </div>
          )}
          {items.map((inv) => (
            <div
              key={inv.id}
              className="bg-[hsl(22,15%,12%)] border border-[hsl(30,12%,20%)] rounded-lg px-3 py-3 space-y-2"
              data-testid={`invite-inbox-row-${inv.id}`}
            >
              <div>
                <div className="text-sm font-bold text-stone-100">
                  {inv.group?.name ?? "Group"}
                </div>
                {inv.group?.description && (
                  <div className="text-[11px] text-stone-400 line-clamp-2">
                    {inv.group.description}
                  </div>
                )}
                <div className="text-[10px] text-stone-500 mt-1">
                  {formatExpiry(inv.expires_at)}
                  {inv.email ? ` · sent to ${inv.email}` : ""}
                </div>
              </div>
              <div className="flex gap-2">
                <button
                  disabled={busyId === inv.id}
                  onClick={() => void handleDecline(inv)}
                  className="flex-1 py-2 rounded-lg text-xs font-bold uppercase tracking-wider text-stone-300 border border-stone-700 disabled:opacity-50"
                  data-testid={`invite-decline-${inv.id}`}
                >
                  Decline
                </button>
                <button
                  disabled={busyId === inv.id}
                  onClick={() => void handleAccept(inv)}
                  className="flex-1 py-2 rounded-lg text-xs font-bold uppercase tracking-wider text-stone-900 disabled:opacity-50"
                  style={{ background: "linear-gradient(135deg, #d4870c, #f0a832)" }}
                  data-testid={`invite-accept-${inv.id}`}
                >
                  {busyId === inv.id ? "…" : "Accept"}
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
