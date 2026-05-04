import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useUser } from "@clerk/react";
import { useLocation } from "wouter";
import {
  GROUPS_MEMBERSHIP_CHANGED_EVENT,
  type GroupNotification,
  type NotificationsResponse,
  fetchGroupNotifications,
  markAllNotificationsRead,
} from "@/lib/groups";
import GroupDetailDialog from "./GroupDetailDialog";

const POLL_MS = 60_000;

function relativeTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return "just now";
  const mins = Math.floor(ms / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
}

function actorLabel(actor: GroupNotification["actor"]): string {
  if (actor.display_name && actor.display_name.trim()) return actor.display_name;
  if (actor.email) return actor.email.split("@")[0];
  return "A rider";
}

function avatarInitial(actor: GroupNotification["actor"]): string {
  return (actorLabel(actor)[0] ?? "?").toUpperCase();
}

// Render the body half of an activity entry — everything that comes after
// the bold actor name. Switching on `n.type` here (instead of inline in
// the JSX) keeps the union narrowing readable and avoids a deeply nested
// ternary.
function renderNotificationBody(n: GroupNotification): ReactNode {
  const groupBadge = (
    <span className="text-stone-100 font-semibold">{n.group.name}</span>
  );
  switch (n.type) {
    case "trail_shared":
      return (
        <>
          shared <span className="text-amber-300">{n.trail.name}</span> into{" "}
          {groupBadge}
        </>
      );
    case "member_joined":
      return <>joined {groupBadge}</>;
    case "member_left":
      // For voluntary leaves the actor and subject are the same person, so
      // we render "X left Y". For admin removals the actor differs and we
      // render "X removed Y from Z".
      if (n.removed_by_admin) {
        const subjectName =
          (n.subject.display_name && n.subject.display_name.trim()) ||
          (n.subject.email ? n.subject.email.split("@")[0] : null) ||
          "a rider";
        return (
          <>
            removed{" "}
            <span className="text-stone-100 font-semibold">{subjectName}</span>{" "}
            from {groupBadge}
          </>
        );
      }
      return <>left {groupBadge}</>;
    case "trail_unshared":
      return (
        <>
          removed <span className="text-amber-300">{n.trail.name}</span> from{" "}
          {groupBadge}
        </>
      );
    case "photo_shared":
      return (
        <>
          shared a new photo in {groupBadge}
        </>
      );
    case "invite_declined":
      return (
        <>
          declined an invite to {groupBadge}
          <span className="text-stone-500"> ({n.decliner_label})</span>
        </>
      );
  }
}

export default function NotificationsBell() {
  const { isSignedIn, isLoaded } = useUser();
  const [unread, setUnread] = useState(0);
  const [open, setOpen] = useState(false);

  const refreshCount = useCallback(async () => {
    if (!isSignedIn) {
      setUnread(0);
      return;
    }
    // Tiny page just for the unreadCount — keeps the header poll lightweight.
    const data = await fetchGroupNotifications({ limit: 1 });
    setUnread(data.unreadCount);
  }, [isSignedIn]);

  useEffect(() => {
    if (!isLoaded || !isSignedIn) {
      setUnread(0);
      return;
    }
    void refreshCount();
    const id = window.setInterval(() => void refreshCount(), POLL_MS);
    return () => window.clearInterval(id);
  }, [isLoaded, isSignedIn, refreshCount]);

  // When membership changes (joined/left a group, accepted invite), the unread
  // count may change too — re-poll immediately rather than wait for the timer.
  useEffect(() => {
    if (!isSignedIn) return;
    const handler = () => void refreshCount();
    window.addEventListener(GROUPS_MEMBERSHIP_CHANGED_EVENT, handler);
    return () =>
      window.removeEventListener(GROUPS_MEMBERSHIP_CHANGED_EVENT, handler);
  }, [isSignedIn, refreshCount]);

  if (!isSignedIn) return null;

  const display = unread > 99 ? "99+" : String(unread);

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="relative flex items-center justify-center bg-[hsl(22,15%,14%)] hover:bg-[hsl(22,15%,18%)] border border-[hsl(30,12%,20%)] rounded-full w-7 h-7 transition-colors"
        title={unread > 0 ? `${unread} new group activity` : "Group activity"}
        data-testid="notifications-bell"
        aria-label="Group activity notifications"
      >
        <svg
          viewBox="0 0 24 24"
          className="w-3.5 h-3.5 text-stone-300"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
        >
          <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
          <path d="M13.73 21a2 2 0 0 1-3.46 0" />
        </svg>
        {unread > 0 && (
          <span
            className="absolute -top-1 -right-1 min-w-[16px] h-4 px-1 rounded-full bg-amber-500 text-stone-900 text-[9px] font-bold flex items-center justify-center"
            data-testid="notifications-bell-count"
          >
            {display}
          </span>
        )}
      </button>
      {open && (
        <NotificationsPanel
          onClose={() => {
            setOpen(false);
            void refreshCount();
          }}
          onUnreadChanged={(n) => setUnread(n)}
        />
      )}
    </>
  );
}

interface PanelProps {
  onClose: () => void;
  onUnreadChanged: (n: number) => void;
}

function NotificationsPanel({ onClose, onUnreadChanged }: PanelProps) {
  const [, setLocation] = useLocation();
  const [items, setItems] = useState<GroupNotification[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [nextBefore, setNextBefore] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [marking, setMarking] = useState(false);
  const [openGroupId, setOpenGroupId] = useState<string | null>(null);
  const initialFetched = useRef(false);

  const loadFirstPage = useCallback(async () => {
    setLoading(true);
    setError(null);
    const data: NotificationsResponse = await fetchGroupNotifications({
      limit: 20,
    });
    setItems(data.items);
    setUnreadCount(data.unreadCount);
    setNextBefore(data.nextBefore);
    onUnreadChanged(data.unreadCount);
    setLoading(false);
  }, [onUnreadChanged]);

  useEffect(() => {
    if (initialFetched.current) return;
    initialFetched.current = true;
    void loadFirstPage();
  }, [loadFirstPage]);

  const loadMore = async () => {
    if (!nextBefore || loadingMore) return;
    setLoadingMore(true);
    const data = await fetchGroupNotifications({
      limit: 20,
      before: nextBefore,
    });
    setItems((prev) => [...prev, ...data.items]);
    setNextBefore(data.nextBefore);
    setLoadingMore(false);
  };

  const handleMarkAllRead = async () => {
    if (marking || unreadCount === 0) return;
    setMarking(true);
    const ts = await markAllNotificationsRead();
    setMarking(false);
    if (!ts) {
      setError("Couldn't mark notifications as read");
      return;
    }
    setItems((prev) => prev.map((it) => ({ ...it, unread: false })));
    setUnreadCount(0);
    onUnreadChanged(0);
  };

  const openTrailOnDiscover = (trailId: string) => {
    // Navigate directly to the Discover tab and pass the trail id via
    // ?trail=… so DiscoverTab can open its TrailDetailSheet on the matching
    // row (whether it's mounting fresh or already on screen).
    const params = new URLSearchParams(window.location.search);
    params.set("trail", trailId);
    setLocation(`/discover?${params.toString()}`);
    onClose();
  };

  const handleEntryClick = (n: GroupNotification) => {
    if (n.type === "trail_shared") {
      openTrailOnDiscover(n.trail.id);
      return;
    }
    if (n.type === "trail_unshared" && n.trail.id) {
      // Trail still exists — let the rider revisit it. When trail.id is
      // null (deleted) we fall through and just open the group dialog.
      openTrailOnDiscover(n.trail.id);
      return;
    }
    // member_joined / member_left / trail_unshared(deleted) /
    // photo_shared / invite_declined → open the group detail dialog
    // inline so the rider lands on the relevant group.
    setOpenGroupId(n.group.id);
  };

  return (
    <>
      <div
        className="fixed inset-0 z-[3060] flex flex-col"
        style={{ background: "rgba(0,0,0,0.85)", backdropFilter: "blur(3px)" }}
        role="dialog"
        aria-modal="true"
        data-testid="notifications-panel"
      >
        <div
          className="mt-auto rounded-t-2xl overflow-hidden flex flex-col"
          style={{ background: "hsl(22,15%,9%)", maxHeight: "85vh" }}
        >
          <div className="flex justify-center pt-3 pb-1 shrink-0">
            <div className="w-10 h-1 rounded-full bg-stone-700"></div>
          </div>
          <div className="flex items-center justify-between px-4 py-3 border-b border-[hsl(30,12%,16%)] shrink-0">
            <div>
              <h2 className="text-base font-bold text-amber-400 uppercase tracking-widest">
                Activity
              </h2>
              <p className="text-[11px] text-stone-500 mt-0.5">
                {loading
                  ? "Loading..."
                  : items.length === 0
                    ? "No recent group activity"
                    : `${items.length} recent event${items.length === 1 ? "" : "s"}${unreadCount > 0 ? ` · ${unreadCount} new` : ""}`}
              </p>
            </div>
            <div className="flex items-center gap-3">
              {unreadCount > 0 && (
                <button
                  onClick={handleMarkAllRead}
                  disabled={marking}
                  className="text-[11px] font-semibold text-amber-400 hover:text-amber-300 disabled:opacity-50 uppercase tracking-wider"
                  data-testid="notifications-mark-all-read"
                >
                  {marking ? "Marking..." : "Mark all read"}
                </button>
              )}
              <button
                onClick={onClose}
                className="text-xs text-stone-500 hover:text-red-400"
                data-testid="notifications-close"
              >
                Close
              </button>
            </div>
          </div>

          <div className="overflow-y-auto px-4 py-3 flex-1">
            {error && (
              <div className="mb-3 text-xs text-red-400 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2">
                {error}
              </div>
            )}

            {loading ? (
              <div className="flex justify-center py-10">
                <div className="w-6 h-6 border-2 border-amber-500/30 border-t-amber-500 rounded-full animate-spin"></div>
              </div>
            ) : items.length === 0 ? (
              <p className="text-stone-500 text-xs text-center py-10">
                When riders share trails or join your groups you&apos;ll see it
                here.
              </p>
            ) : (
              <ul className="flex flex-col gap-2">
                {items.map((n) => (
                  <li key={n.id}>
                    <button
                      onClick={() => handleEntryClick(n)}
                      className={`w-full text-left flex items-start gap-3 rounded-xl border px-3 py-2.5 transition-colors ${
                        n.unread
                          ? "border-amber-500/40 bg-amber-500/[0.06] hover:bg-amber-500/[0.10]"
                          : "border-[hsl(30,12%,18%)] bg-[hsl(22,15%,11%)] hover:bg-[hsl(22,15%,13%)]"
                      }`}
                      data-testid={`notification-${n.type}-${n.id.replace(/[^a-z0-9]/gi, "-")}`}
                    >
                      {n.actor.avatar_url ? (
                        <img
                          src={n.actor.avatar_url}
                          alt=""
                          className="w-8 h-8 rounded-full shrink-0 object-cover bg-stone-800"
                        />
                      ) : (
                        <div className="w-8 h-8 rounded-full shrink-0 bg-amber-500/20 text-amber-300 text-xs font-bold flex items-center justify-center">
                          {avatarInitial(n.actor)}
                        </div>
                      )}
                      <div className="min-w-0 flex-1">
                        <p className="text-xs text-stone-200 leading-relaxed">
                          <span className="font-semibold">
                            {actorLabel(n.actor)}
                          </span>{" "}
                          {renderNotificationBody(n)}
                        </p>
                        <p className="text-[10px] text-stone-500 mt-0.5 uppercase tracking-wider">
                          {relativeTime(n.occurred_at)}
                        </p>
                      </div>
                      {n.unread && (
                        <span
                          className="w-2 h-2 rounded-full bg-amber-400 shrink-0 mt-1.5"
                          aria-label="unread"
                        ></span>
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            )}

            {!loading && nextBefore && (
              <button
                onClick={() => void loadMore()}
                disabled={loadingMore}
                className="mt-3 w-full text-xs text-stone-400 hover:text-amber-400 py-2 border border-[hsl(30,12%,20%)] rounded-lg disabled:opacity-50"
                data-testid="notifications-load-more"
              >
                {loadingMore ? "Loading..." : "Load older"}
              </button>
            )}
          </div>
        </div>
      </div>
      {openGroupId && (
        <GroupDetailDialog
          groupId={openGroupId}
          onClose={() => setOpenGroupId(null)}
        />
      )}
    </>
  );
}
