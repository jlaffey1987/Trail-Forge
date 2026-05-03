import { useCallback, useState, useEffect } from "react";
import { useLocation, useSearch } from "wouter";
import { fetchCommunityTrails, type Trail } from "@/lib/supabase";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import {
  fetchTrailActivityCounts,
  type TrailActivityCounts,
} from "@/lib/trailContent";
import {
  GROUPS_MEMBERSHIP_CHANGED_EVENT,
  fetchGroupTrails,
  groupCoverPhotoUrl,
  listDiscoverableGroups,
  requestToJoinGroup,
  type DiscoverableGroup,
  type SharedTrail,
} from "@/lib/groups";
import TrailDetailSheet from "@/components/TrailDetailSheet";
import LoadingBackdrop from "@/components/LoadingBackdrop";

const DIFFICULTY_COLORS: Record<number, string> = {
  1: "#4ade80", 2: "#86efac", 3: "#a3e635", 4: "#bef264", 5: "#fbbf24",
  6: "#fb923c", 7: "#f97316", 8: "#ef4444", 9: "#dc2626", 10: "#7f1d1d",
};

const PREVIEW_GRADIENTS = [
  "bg-gradient-to-br from-stone-800 to-stone-900",
  "bg-gradient-to-br from-green-900 to-stone-900",
  "bg-gradient-to-br from-slate-800 to-stone-900",
  "bg-gradient-to-br from-emerald-900 to-stone-900",
  "bg-gradient-to-br from-amber-900 to-stone-900",
  "bg-gradient-to-br from-zinc-800 to-stone-900",
];

const AUTHOR_NAMES = ["DirtBiker_UK","GreenLaner_Pro","TrailMaster_99","OffRoad_Wales","SomsetRider","NorthRider"];
const FILTERS = ["All", "Featured", "BOATs", "Green Lanes", "Nearby"];

function formatDistance(km: number | null) {
  return km != null ? `${km.toFixed(1)} km` : "—";
}

function formatElevation(terrain: string | null) {
  return terrain || "Mixed";
}

function formatElevationGain(m: number | null | undefined): string | null {
  if (m == null || !Number.isFinite(m)) return null;
  return `${Math.round(m).toLocaleString()} m`;
}

function getPostedTime(created_at: string) {
  const diff = Date.now() - new Date(created_at).getTime();
  const h = Math.floor(diff / 3600000);
  if (h < 1) return "Just now";
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

export default function DiscoverTab() {
  const { isSignedIn } = useCurrentUser();
  const [, setLocation] = useLocation();
  const queryString = useSearch();
  const [activeFilter, setActiveFilter] = useState("All");
  const [liked, setLiked] = useState<Set<string>>(new Set());
  const [trails, setTrails] = useState<SharedTrail[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [activityCounts, setActivityCounts] = useState<Record<string, TrailActivityCounts>>({});
  const [selectedTrail, setSelectedTrail] = useState<Trail | null>(null);
  const [discoverableGroups, setDiscoverableGroups] = useState<
    DiscoverableGroup[]
  >([]);
  // Tracks which group's "Request to join" button is mid-flight so we can
  // disable just that row (and not the whole list) while waiting for the
  // server response.
  const [joiningGroupId, setJoiningGroupId] = useState<string | null>(null);
  const [joinError, setJoinError] = useState<string | null>(null);
  // Keep the "Groups to Join" section compact so it doesn't push the trail
  // feed off-screen. We show the first 2 by default and let the user expand
  // the rest with a single tap.
  const [showAllGroups, setShowAllGroups] = useState(false);

  const refreshDiscoverableGroups = useCallback(async () => {
    if (!isSignedIn) {
      setDiscoverableGroups([]);
      return;
    }
    const items = await listDiscoverableGroups();
    setDiscoverableGroups(items);
  }, [isSignedIn]);

  const handleRequestJoin = async (group: DiscoverableGroup) => {
    setJoinError(null);
    setJoiningGroupId(group.id);
    const res = await requestToJoinGroup(group.id);
    setJoiningGroupId(null);
    if ("error" in res) {
      setJoinError(res.error || "Could not send request");
      return;
    }
    // Optimistically mark this group as pending so the CTA flips immediately,
    // then refetch so the (potentially server-corrected) state wins.
    setDiscoverableGroups((cur) =>
      cur.map((g) =>
        g.id === group.id ? { ...g, my_status: "pending" as const } : g,
      ),
    );
    void refreshDiscoverableGroups();
  };

  const refresh = useCallback(() => {
    setLoading(true);
    void refreshDiscoverableGroups();
    void Promise.all([fetchCommunityTrails(), fetchGroupTrails()]).then(
      ([community, groupTrails]) => {
        // Merge: group-shared trails go first so the user sees private picks
        // from their groups at the top of the feed alongside the public list.
        const seen = new Set<string>();
        const merged: SharedTrail[] = [];
        for (const t of groupTrails) {
          if (seen.has(t.id)) continue;
          seen.add(t.id);
          merged.push(t);
        }
        for (const t of community) {
          if (seen.has(t.id)) continue;
          seen.add(t.id);
          merged.push(t);
        }
        setTrails(merged);
        setLoading(false);
        if (merged.length > 0) {
          void fetchTrailActivityCounts(merged.map((t) => t.id)).then(
            setActivityCounts,
          );
        }
      },
    );
  }, [refreshDiscoverableGroups]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Invalidate the discover feed when group membership changes so removed
  // members no longer see private trails from a group they just left.
  useEffect(() => {
    const handler = () => refresh();
    window.addEventListener(GROUPS_MEMBERSHIP_CHANGED_EVENT, handler);
    return () =>
      window.removeEventListener(GROUPS_MEMBERSHIP_CHANGED_EVENT, handler);
  }, [refresh]);

  // Open a TrailDetailSheet when the URL carries `?trail=<id>`. The
  // notifications bell (and push-notification deep links) set this and
  // navigate to /discover via wouter; depending on the wouter search string
  // means this effect re-fires for both fresh mounts and in-tab updates.
  // Once the sheet is opened we strip the param so navigating away and back
  // doesn't re-open the sheet.
  useEffect(() => {
    if (loading) return;
    const params = new URLSearchParams(queryString);
    const wantId = params.get("trail");
    if (!wantId) return;
    const match = trails.find((t) => t.id === wantId);
    if (match) {
      setSelectedTrail(match);
      params.delete("trail");
      const qs = params.toString();
      setLocation(`/discover${qs ? `?${qs}` : ""}`, { replace: true });
    }
  }, [trails, loading, queryString, setLocation]);

  const toggleLike = (id: string) => {
    setLiked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const filtered = trails.filter((t) => {
    if (search && !t.name.toLowerCase().includes(search.toLowerCase())) return false;
    if (activeFilter === "BOATs") return t.legal_status === "BOAT";
    if (activeFilter === "Green Lanes") return t.legal_status === "Green Lane";
    return true;
  });

  return (
    <div className="flex flex-col h-full tf-scroll">
      {/* Title + search + filter ribbon are all part of the same sticky
          block so the ribbon never appears to "flash then disappear" as
          the trail feed loads and the page starts scrolling. The whole
          header stays pinned to the top of the scroll area with a
          subtle border that makes the pin intentional-looking. */}
      <div
        className="sticky top-0 z-20 bg-[hsl(22,15%,8%)]/95 backdrop-blur supports-[backdrop-filter]:bg-[hsl(22,15%,8%)]/85 pt-3 pb-2 mb-1 border-b border-[hsl(30,12%,14%)]/60"
        data-testid="discover-sticky-controls"
      >
        <div className="px-4 pb-2">
          <h1 className="text-lg font-bold tracking-wide text-amber-400 uppercase" style={{ letterSpacing: "0.12em" }}>
            Discover
          </h1>
          <p className="text-xs text-stone-400 mt-0.5">
            {loading ? "Loading live trails..." : `${trails.length} community trails`}
          </p>
        </div>
        <div className="px-4 mb-2">
          <div className="relative">
            <svg viewBox="0 0 24 24" className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-stone-500" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="11" cy="11" r="8" />
              <path d="m21 21-4.35-4.35" />
            </svg>
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search community trails..."
              className="w-full bg-[hsl(22,15%,11%)] border border-[hsl(30,12%,20%)] rounded-lg pl-9 pr-4 py-2.5 text-sm text-stone-200 placeholder:text-stone-500 focus:outline-none focus:border-amber-500/60 transition-colors"
            />
          </div>
        </div>

        <div
          className="px-4 flex gap-2 overflow-x-auto pb-1"
          style={{ scrollbarWidth: "none" }}
          data-testid="discover-filter-ribbon"
        >
          {FILTERS.map((f) => (
            <button
              key={f}
              onClick={() => setActiveFilter(f)}
              className={`shrink-0 px-3 py-1.5 rounded-full text-xs font-semibold transition-all ${
                activeFilter === f
                  ? "bg-amber-500 text-stone-900"
                  : "bg-[hsl(22,15%,14%)] text-stone-400 border border-[hsl(30,12%,20%)]"
              }`}
              data-testid={`discover-filter-${f.replace(/\s+/g, "-").toLowerCase()}`}
            >
              {f}
            </button>
          ))}
        </div>
      </div>

      {/* Discoverable groups — show signed-in users any group they could ask
          to join. Sits above the trail feed but stays compact (max 2 rows by
          default) so it never blocks the trail cards on small phones.
          Hidden when there's nothing to join. */}
      {isSignedIn && discoverableGroups.length > 0 && (
        <div className="px-4 mb-3" data-testid="discoverable-groups-section">
          <div className="flex items-baseline justify-between mb-1.5">
            <h2
              className="text-[11px] font-bold uppercase tracking-widest text-amber-400"
              style={{ letterSpacing: "0.12em" }}
            >
              Groups to Join
            </h2>
            <span className="text-[10px] text-stone-500">
              {discoverableGroups.length} open
            </span>
          </div>
          {joinError && (
            <p
              className="text-[11px] text-red-300 mb-2"
              data-testid="discoverable-groups-error"
            >
              {joinError}
            </p>
          )}
          <div className="space-y-1.5">
            {(showAllGroups
              ? discoverableGroups
              : discoverableGroups.slice(0, 2)
            ).map((g) => {
              const cover = groupCoverPhotoUrl(g.cover_photo_key);
              const isPending = g.my_status === "pending";
              const isBusy = joiningGroupId === g.id;
              return (
                <div
                  key={g.id}
                  className="bg-[hsl(22,15%,11%)] border border-[hsl(30,12%,20%)] rounded-lg flex items-center gap-2.5 p-2"
                  data-testid={`discoverable-group-${g.id}`}
                >
                  {cover ? (
                    <img
                      src={cover}
                      alt=""
                      className="w-9 h-9 rounded-md object-cover shrink-0"
                    />
                  ) : (
                    <div className="w-9 h-9 rounded-md bg-gradient-to-br from-amber-900/40 to-stone-900 flex items-center justify-center shrink-0">
                      <span className="text-amber-400 text-xs font-bold">
                        {g.name.slice(0, 1).toUpperCase()}
                      </span>
                    </div>
                  )}
                  <div className="flex-1 min-w-0">
                    <h3 className="text-[13px] font-bold text-stone-100 truncate leading-tight">
                      {g.name}
                    </h3>
                    <p className="text-[10px] text-stone-500 truncate leading-tight">
                      {g.member_count} member
                      {g.member_count === 1 ? "" : "s"}
                    </p>
                  </div>
                  <button
                    type="button"
                    disabled={isBusy || isPending}
                    onClick={() => void handleRequestJoin(g)}
                    className={
                      "shrink-0 px-2.5 py-1.5 rounded-md text-[10px] font-bold uppercase tracking-wider transition-colors disabled:cursor-not-allowed " +
                      (isPending
                        ? "bg-stone-800 text-stone-400 border border-stone-700"
                        : "text-stone-900 disabled:opacity-50")
                    }
                    style={
                      isPending
                        ? undefined
                        : {
                            background:
                              "linear-gradient(135deg, #d4870c, #f0a832)",
                          }
                    }
                    data-testid={`discoverable-group-join-${g.id}`}
                  >
                    {isPending ? "Pending" : isBusy ? "…" : "Join"}
                  </button>
                </div>
              );
            })}
          </div>
          {discoverableGroups.length > 2 && (
            <button
              type="button"
              onClick={() => setShowAllGroups((v) => !v)}
              className="mt-1.5 w-full py-1.5 rounded-md text-[11px] font-semibold text-amber-400 hover:text-amber-300 border border-[hsl(30,12%,20%)] bg-[hsl(22,15%,9%)]"
              data-testid="discoverable-groups-toggle"
            >
              {showAllGroups
                ? "Show less"
                : `Show ${discoverableGroups.length - 2} more`}
            </button>
          )}
        </div>
      )}

      {/* Loading */}
      {loading && (
        <div className="flex-1 min-h-[260px] mx-4 mb-4 rounded-xl overflow-hidden">
          <LoadingBackdrop
            variant="ride"
            label="Loading live community trails…"
            testId="discover-loading-backdrop"
          />
        </div>
      )}

      {/* Trail Cards */}
      {!loading && (
        <div className="px-4 pb-6 space-y-3">
          {filtered.length === 0 ? (
            <div className="text-center py-12">
              <p className="text-stone-500 text-sm">No trails found.</p>
            </div>
          ) : (
            filtered.map((trail, idx) => {
              const diff = trail.difficulty ?? 5;
              const authorName = AUTHOR_NAMES[idx % AUTHOR_NAMES.length];
              const authorInitials = authorName.slice(0, 2).toUpperCase();
              const preview = PREVIEW_GRADIENTS[idx % PREVIEW_GRADIENTS.length];
              const isLiked = liked.has(trail.id);
              const likesBase = 100 + (idx * 73 + diff * 37) % 800;

              const canOpenDetail = isSignedIn;
              const openDetail = () => {
                if (canOpenDetail) setSelectedTrail(trail);
              };
              return (
                <div
                  key={trail.id}
                  onClick={canOpenDetail ? openDetail : undefined}
                  role={canOpenDetail ? "button" : undefined}
                  tabIndex={canOpenDetail ? 0 : undefined}
                  onKeyDown={
                    canOpenDetail
                      ? (e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            openDetail();
                          }
                        }
                      : undefined
                  }
                  data-testid={`discover-card-${trail.id}`}
                  className={`bg-[hsl(22,15%,11%)] border border-[hsl(30,12%,20%)] rounded-xl overflow-hidden transition-colors ${
                    canOpenDetail
                      ? "cursor-pointer hover:border-amber-500/40 focus:outline-none focus:border-amber-500/60"
                      : "hover:border-amber-500/20"
                  }`}
                >
                  {/* Map Preview Strip */}
                  <div className={`h-20 ${preview} relative flex items-end p-2`}>
                    <div className="flex items-center gap-1.5">
                      <div
                        className="w-5 h-5 rounded flex items-center justify-center text-[10px] font-bold text-black shrink-0"
                        style={{ backgroundColor: DIFFICULTY_COLORS[diff] ?? "#fbbf24" }}
                      >
                        {diff}
                      </div>
                      <span className="text-xs font-bold text-white/90">{formatElevation(trail.terrain)}</span>
                    </div>
                    <div className="absolute top-2 right-2">
                      <span className={`text-[10px] px-2 py-0.5 rounded-full font-medium ${
                        trail.legal_status === "BOAT"
                          ? "text-amber-300 bg-amber-900/60"
                          : "text-green-300 bg-green-900/60"
                      }`}>
                        {trail.legal_status || trail.type || "Trail"}
                      </span>
                    </div>
                  </div>

                  <div className="p-3">
                    <div className="flex items-start justify-between mb-1">
                      <h3 className="text-sm font-bold text-stone-100">{trail.name}</h3>
                      <span className="text-[10px] text-stone-500 ml-2 shrink-0">{getPostedTime(trail.created_at)}</span>
                    </div>

                    <div className="flex items-center gap-2 mb-2">
                      <div className="w-5 h-5 rounded-full bg-gradient-to-br from-amber-600 to-amber-800 flex items-center justify-center text-[9px] font-bold text-white">
                        {authorInitials}
                      </div>
                      <span className="text-xs text-stone-400">{authorName}</span>
                    </div>

                    <div className="flex items-center gap-2 mb-2 flex-wrap">
                      <span className="text-xs text-stone-400 bg-stone-800/80 px-2 py-0.5 rounded">
                        {formatDistance(trail.distance_km)}
                      </span>
                      {(() => {
                        const gain = formatElevationGain(trail.elevation_gain_m);
                        return gain ? (
                          <span
                            className="text-xs text-emerald-300 bg-emerald-900/30 px-2 py-0.5 rounded"
                            title="Total ascent"
                            data-testid={`discover-card-elevation-gain-${trail.id}`}
                          >
                            ↑ {gain}
                          </span>
                        ) : null;
                      })()}
                      {(() => {
                        const loss = formatElevationGain(trail.elevation_loss_m);
                        return loss ? (
                          <span
                            className="text-xs text-sky-300 bg-sky-900/30 px-2 py-0.5 rounded"
                            title="Total descent"
                            data-testid={`discover-card-elevation-loss-${trail.id}`}
                          >
                            ↓ {loss}
                          </span>
                        ) : null;
                      })()}
                      <span className="text-xs text-stone-500 bg-stone-800/40 px-2 py-0.5 rounded">
                        {trail.terrain || "Mixed"}
                      </span>
                      {trail.shared_groups && trail.shared_groups.length > 0 && (
                        <span
                          className="text-[10px] font-bold uppercase tracking-wider text-amber-300 bg-amber-900/40 border border-amber-500/30 px-2 py-0.5 rounded-full"
                          title={`Shared via ${trail.shared_groups.map((g) => g.name).join(", ")}`}
                          data-testid={`discover-card-group-${trail.id}`}
                        >
                          Group · {trail.shared_groups[0]!.name}
                          {trail.shared_groups.length > 1 ? ` +${trail.shared_groups.length - 1}` : ""}
                        </span>
                      )}
                    </div>

                    <div
                      className="text-[10px] text-stone-500 mb-2"
                      data-testid={`trail-card-counts-${trail.id}`}
                    >
                      {(activityCounts[trail.id]?.notes ?? 0)} notes ·{" "}
                      {(activityCounts[trail.id]?.photos ?? 0)} photos ·{" "}
                      {(activityCounts[trail.id]?.pending ?? 0)} pending
                    </div>

                    <div className="flex items-center justify-between pt-2 border-t border-[hsl(30,12%,16%)]">
                      <div className="flex items-center gap-3">
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            toggleLike(trail.id);
                          }}
                          className="flex items-center gap-1 transition-colors"
                        >
                          <svg viewBox="0 0 24 24" className={`w-4 h-4 ${isLiked ? "fill-red-500 stroke-red-500" : "stroke-stone-500"}`} fill="none" strokeWidth="2">
                            <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" />
                          </svg>
                          <span className={`text-xs ${isLiked ? "text-red-400" : "text-stone-500"}`}>
                            {likesBase + (isLiked ? 1 : 0)}
                          </span>
                        </button>
                        <div className="flex items-center gap-1">
                          <svg viewBox="0 0 24 24" className="w-4 h-4 stroke-stone-500" fill="none" strokeWidth="2">
                            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                          </svg>
                          <span className="text-xs text-stone-500">{Math.floor(likesBase * 0.13)}</span>
                        </div>
                      </div>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          if (canOpenDetail) openDetail();
                        }}
                        disabled={!canOpenDetail}
                        className="text-xs text-amber-400 font-semibold hover:text-amber-300 transition-colors disabled:text-stone-500 disabled:cursor-not-allowed"
                        title={canOpenDetail ? undefined : "Sign in to view trail details"}
                        data-testid={`discover-card-view-${trail.id}`}
                      >
                        View Trail
                      </button>
                    </div>
                  </div>
                </div>
              );
            })
          )}
        </div>
      )}

      {selectedTrail && (() => {
        // Compute prev/next from the discover feed so the rider can
        // jump between trails without backing out to the list.
        const idx = trails.findIndex((t) => t.id === selectedTrail.id);
        const prevTrail = idx > 0 ? trails[idx - 1] : null;
        const nextTrail = idx >= 0 && idx < trails.length - 1 ? trails[idx + 1] : null;
        return (
          <TrailDetailSheet
            trail={selectedTrail}
            onClose={() => setSelectedTrail(null)}
            prevTrail={prevTrail}
            nextTrail={nextTrail}
            onNavigate={setSelectedTrail}
            onCountsChanged={(trailId, counts) =>
              setActivityCounts((prev) => {
                const cur = prev[trailId];
                if (
                  cur &&
                  cur.notes === counts.notes &&
                  cur.photos === counts.photos &&
                  cur.pending === counts.pending
                ) {
                  return prev;
                }
                return { ...prev, [trailId]: counts };
              })
            }
          />
        );
      })()}
    </div>
  );
}
