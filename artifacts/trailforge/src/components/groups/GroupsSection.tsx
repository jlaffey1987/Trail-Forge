import { useCallback, useEffect, useState } from "react";
import { useLocation } from "wouter";
import {
  type Group,
  groupCoverPhotoUrl,
  listMyGroups,
} from "@/lib/groups";
import CreateGroupDialog from "./CreateGroupDialog";
import GroupDetailDialog from "./GroupDetailDialog";

interface Props {
  signedIn: boolean;
}

export default function GroupsSection({ signedIn }: Props) {
  const [groups, setGroups] = useState<Group[]>([]);
  const [loading, setLoading] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [openGroupId, setOpenGroupId] = useState<string | null>(null);
  const [pending, setPending] = useState(0);
  const [location, setLocation] = useLocation();

  // Deep-link consumer: when App.tsx (notification bell or push notification)
  // navigates here with `?group=<id>`, auto-open that group's detail dialog.
  // We strip the param immediately so a tab change + return doesn't re-open
  // the dialog after the user closed it.
  useEffect(() => {
    if (!signedIn) return;
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const gid = params.get("group");
    if (gid) {
      setOpenGroupId(gid);
      params.delete("group");
      const qs = params.toString();
      setLocation(`${location.split("?")[0]}${qs ? `?${qs}` : ""}`, {
        replace: true,
      });
    }
  }, [signedIn, location, setLocation]);

  const refresh = useCallback(async () => {
    if (!signedIn) {
      setGroups([]);
      setPending(0);
      return;
    }
    setLoading(true);
    const res = await listMyGroups();
    setGroups(res.items);
    setPending(res.invitesPending);
    setLoading(false);
  }, [signedIn]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (!signedIn) {
    return (
      <section className="px-4 pb-4" data-testid="groups-section-signed-out">
        <h2 className="text-[11px] font-bold uppercase tracking-widest text-stone-400 mb-2">
          Groups
        </h2>
        <div className="bg-[hsl(22,15%,11%)] border border-[hsl(30,12%,20%)] rounded-xl p-4 text-center">
          <p className="text-stone-500 text-xs">
            Sign in to create private groups and share trails with riding mates.
          </p>
        </div>
      </section>
    );
  }

  return (
    <section className="px-4 pb-4" data-testid="groups-section">
      <div className="flex items-center justify-between mb-2">
        <h2 className="text-[11px] font-bold uppercase tracking-widest text-stone-400">
          Groups ({groups.length})
        </h2>
        <button
          onClick={() => setShowCreate(true)}
          className="text-[10px] font-bold uppercase tracking-widest text-amber-400 hover:text-amber-300"
          data-testid="groups-create-btn"
        >
          + New
        </button>
      </div>

      {pending > 0 && (
        <div
          className="mb-2 px-3 py-2 rounded-lg bg-amber-900/30 border border-amber-500/30 text-[11px] text-amber-200"
          data-testid="groups-pending-banner"
        >
          {pending} pending invite{pending === 1 ? "" : "s"} for your email — open from the link your inviter shared.
        </div>
      )}

      {loading && groups.length === 0 ? (
        <div className="text-xs text-stone-500 py-3 text-center">Loading…</div>
      ) : groups.length === 0 ? (
        <div className="bg-[hsl(22,15%,11%)] border border-[hsl(30,12%,20%)] rounded-xl p-4 text-center">
          <p className="text-stone-500 text-xs">
            You're not in any groups yet. Create one to share private trails with riding mates.
          </p>
        </div>
      ) : (
        <div className="space-y-2" data-testid="groups-list">
          {groups.map((g) => {
            const coverUrl = groupCoverPhotoUrl(g.cover_photo_key);
            return (
              <button
                key={g.id}
                onClick={() => setOpenGroupId(g.id)}
                className="w-full text-left bg-[hsl(22,15%,11%)] border border-[hsl(30,12%,20%)] rounded-xl overflow-hidden hover:border-amber-500/40 transition-colors"
                data-testid={`group-card-${g.id}`}
              >
                {coverUrl && (
                  <div
                    className="relative w-full aspect-[16/6] bg-stone-800"
                    data-testid={`group-card-cover-${g.id}`}
                  >
                    <img
                      src={coverUrl}
                      alt=""
                      className="w-full h-full object-cover"
                      loading="lazy"
                    />
                  </div>
                )}
                <div className="p-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-bold text-stone-100 truncate">{g.name}</div>
                      {g.description && (
                        <div className="text-[11px] text-stone-500 line-clamp-2 mt-0.5">
                          {g.description}
                        </div>
                      )}
                    </div>
                    <span className={`text-[9px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full shrink-0 ${
                      g.role === "owner"
                        ? "bg-amber-500/20 text-amber-300"
                        : g.role === "admin"
                        ? "bg-blue-500/20 text-blue-300"
                        : "bg-stone-700/40 text-stone-400"
                    }`}>
                      {g.role}
                    </span>
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      )}

      <CreateGroupDialog
        open={showCreate}
        onClose={() => setShowCreate(false)}
        onCreated={(g) => {
          setShowCreate(false);
          void refresh();
          setOpenGroupId(g.id);
        }}
      />

      <GroupDetailDialog
        groupId={openGroupId}
        onClose={() => {
          setOpenGroupId(null);
          void refresh();
        }}
      />
    </section>
  );
}
