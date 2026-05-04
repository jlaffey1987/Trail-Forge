import { useEffect, useRef, useState, useCallback } from "react";
import { useLocation } from "wouter";
import { type Trail, saveTrail, fetchTrailGpxByIds, populateTrailGpxCache } from "@/lib/supabase";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { getDifficultyColor } from "@/lib/trailLayer";
import { useIsTrailOffline } from "@/hooks/useOfflineTrails";
import { getOfflineTrail, type OfflineTrail } from "@/lib/offlineStore";
import {
  addRouteTrail,
  removeRouteTrail,
  isInRoute,
  subscribeRouteTrails,
  getRouteTrails,
  PLANNER_MAX_TRAILS,
} from "@/lib/plannerRouteStore";
import {
  fetchTrailActivityCounts,
  fetchTrailPermissions,
  adoptTrail,
  type TrailActivityCounts,
  type TrailPermissions,
} from "@/lib/trailContent";
import {
  markCompleted,
  unmarkCompleted,
  useCompletionState,
} from "@/lib/completionsStore";
import TrailNotesPanel from "./trail-content/TrailNotesPanel";
import TrailPhotosPanel from "./trail-content/TrailPhotosPanel";
import TrailAmendmentsPanel from "./trail-content/TrailAmendmentsPanel";
import TrailElevationChart from "./TrailElevationChart";

const DIFFICULTY_LABELS: Record<number, string> = {
  1: "Novice", 2: "Easy", 3: "Easy+", 4: "Moderate", 5: "Medium",
  6: "Hard", 7: "Expert", 8: "Extreme", 9: "Pro", 10: "Elite",
};

type TabKey = "overview" | "notes" | "photos" | "amendments";

interface Props {
  trail: Trail;
  onClose: () => void;
  onAddedToPlanner?: (trail: Trail) => void;
  onCountsChanged?: (trailId: string, counts: TrailActivityCounts) => void;
  prevTrail?: Trail | null;
  nextTrail?: Trail | null;
  onNavigate?: (trail: Trail) => void;
  onToggleRoute?: (trail: Trail) => void;
  routeIds?: Set<string>;
}

export default function TrailDetailSheet({
  trail,
  onClose,
  onAddedToPlanner,
  onCountsChanged,
  prevTrail,
  nextTrail,
  onNavigate,
  onToggleRoute,
  routeIds,
}: Props) {
  // Hold the latest callback in a ref so refreshCounts doesn't change
  // identity each render — otherwise an inline parent callback would
  // cycle: fetch → setCounts → parent rerender → new callback → effect
  // re-runs → fetch again.
  const onCountsChangedRef = useRef(onCountsChanged);
  useEffect(() => {
    onCountsChangedRef.current = onCountsChanged;
  }, [onCountsChanged]);
  const controlled = onToggleRoute != null && routeIds != null;
  const { isSignedIn, userId } = useCurrentUser();
  const [, setLocation] = useLocation();
  const [inPlannerRoute, setInPlannerRoute] = useState(() =>
    controlled ? routeIds.has(trail.id) : isInRoute(trail.id),
  );
  const [routeTrailCount, setRouteTrailCount] = useState(() =>
    controlled ? routeIds.size : getRouteTrails().length,
  );
  const [saveStatus, setSaveStatus] = useState<"idle" | "saving" | "saved" | "error" | "needsAuth">("idle");
  const [addError, setAddError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<TabKey>("overview");
  const [counts, setCounts] = useState<TrailActivityCounts>({ notes: 0, photos: 0, pending: 0 });
  const [perms, setPerms] = useState<TrailPermissions>({ isOwner: false, isModerator: false, canModerate: false, isUnowned: false, adoptedAt: null, adopter: null });
  const [isSystemAdmin, setIsSystemAdmin] = useState(false);
  type AdminWhoamiState = "migration-missing" | "no-admins" | "not-admin" | "admin" | "signed-out";
  const [adminWhoamiState, setAdminWhoamiState] = useState<AdminWhoamiState | null>(null);
  const [adoptBusy, setAdoptBusy] = useState(false);
  // Trails coming from the slim Map-tab fetch don't carry `gpx_data`. Kick
  // off a background fetch as soon as the sheet opens so the wait between
  // "tap trail" and "Add to planner / build route" feels intentional rather
  // than laggy. The result isn't rendered directly here yet — the spinner
  // just lets the rider know data is on the way (and the fetch warms the
  // Supabase row cache for downstream flows like RouteBuilder).
  const [gpxLoading, setGpxLoading] = useState(false);

  // Keep the in-route flag and per-trail save status in sync when the rider
  // jumps to a neighbouring trail via the prev/next arrows. (The lazy
  // initialisers above only run on mount.)
  useEffect(() => {
    setInPlannerRoute(controlled ? routeIds.has(trail.id) : isInRoute(trail.id));
    setSaveStatus("idle");
    setAddError(null);
  }, [trail.id, controlled, routeIds]);

  useEffect(() => {
    if (controlled) {
      setInPlannerRoute(routeIds.has(trail.id));
      setRouteTrailCount(routeIds.size);
      return;
    }
    return subscribeRouteTrails((trails) => {
      setInPlannerRoute(isInRoute(trail.id));
      setRouteTrailCount(trails.length);
    });
  }, [trail.id]);

  const isOffline = useIsTrailOffline(trail.id);
  const [offlineData, setOfflineData] = useState<OfflineTrail | null>(null);

  useEffect(() => {
    let cancelled = false;
    getOfflineTrail(trail.id)
      .then((data) => { if (!cancelled) setOfflineData(data); })
      .catch(() => { if (!cancelled) setOfflineData(null); });
    return () => { cancelled = true; };
  }, [trail.id]);

  useEffect(() => {
    if (trail.gpx_data != null) {
      setGpxLoading(false);
      return;
    }
    let cancelled = false;
    setGpxLoading(true);

    const tryLoad = async () => {
      try {
        const offline = await getOfflineTrail(trail.id);
        if (offline?.gpxData) {
          populateTrailGpxCache(trail.id, offline.gpxData);
          if (!cancelled) setGpxLoading(false);
          return;
        }
      } catch {
        /* IndexedDB may be unavailable — fall through to network */
      }
      try {
        await fetchTrailGpxByIds([trail.id]);
      } catch {
        /* offline — ignore */
      }
      if (!cancelled) setGpxLoading(false);
    };
    void tryLoad();
    return () => {
      cancelled = true;
    };
  }, [trail.id, trail.gpx_data]);

  // Pull the system-admin flag from the API so admins can re-grade ANY
  // trail, not just their own. Owner-only re-grade was a UI regression
  // (the backend route at POST /api/trails/:id/grade-ai already permits
  // owner OR system admin). Failing closed (admin=false) on network
  // error is fine — admins can still re-grade through the AdminPage.
  useEffect(() => {
    let cancelled = false;
    if (!isSignedIn) {
      setIsSystemAdmin(false);
      setAdminWhoamiState(null);
      return;
    }
    fetch("/api/admin/whoami", { credentials: "include" })
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { isAdmin?: boolean; state?: AdminWhoamiState } | null) => {
        if (!cancelled) {
          setIsSystemAdmin(Boolean(j?.isAdmin));
          setAdminWhoamiState(j?.state ?? null);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setIsSystemAdmin(false);
          setAdminWhoamiState(null);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [isSignedIn]);

  const refreshCounts = useCallback(() => {
    fetchTrailActivityCounts([trail.id]).then((map) => {
      const c = map[trail.id];
      if (c) {
        setCounts(c);
        onCountsChangedRef.current?.(trail.id, c);
      }
    });
  }, [trail.id]);

  useEffect(() => {
    refreshCounts();
    fetchTrailPermissions(trail.id).then(setPerms);
  }, [trail.id, refreshCounts, isSignedIn]);

  const diff = trail.difficulty ?? 5;
  const diffColor = getDifficultyColor(diff);
  const diffLabel = DIFFICULTY_LABELS[diff] ?? "Medium";

  const handleAddToPlanner = () => {
    if (trail.verification_status === "ai-approximated") {
      return;
    }
    if (controlled) {
      onToggleRoute(trail);
      return;
    }
    if (inPlannerRoute) {
      removeRouteTrail(trail.id);
      setAddError(null);
      return;
    }
    const result = addRouteTrail(trail);
    if (result === "atLimit") {
      setAddError(
        `Route is full — you can plan up to ${PLANNER_MAX_TRAILS} trails per route. Remove one before adding "${trail.name}".`,
      );
      return;
    }
    setAddError(null);
    if (result === "added") onAddedToPlanner?.(trail);
  };

  const handleSave = async () => {
    if (saveStatus === "saving" || saveStatus === "saved") return;
    if (!isSignedIn || !userId) {
      setSaveStatus("needsAuth");
      return;
    }
    setSaveStatus("saving");
    const ok = await saveTrail(trail.id, { userId, sessionId: null });
    setSaveStatus(ok ? "saved" : "error");
  };

  const handleAdopt = async () => {
    if (adoptBusy) return;
    setAdoptBusy(true);
    const result = await adoptTrail(trail.id);
    setAdoptBusy(false);
    if (result) {
      setPerms((p) => ({ ...p, isOwner: true, canModerate: true, isUnowned: false, adoptedAt: result.adoptedAt, adopter: result.adopter }));
    }
  };

  const tabs: { key: TabKey; label: string; badge?: number }[] = [
    { key: "overview", label: "Overview" },
    { key: "notes", label: "Notes", badge: counts.notes },
    { key: "photos", label: "Photos", badge: counts.photos },
    { key: "amendments", label: "Edits", badge: counts.pending },
  ];

  const isExternalSource = trail.source && trail.source !== "user";
  const isApproximated = trail.verification_status === "ai-approximated";
  const isUnverified = trail.verification_status === "unverified";

  return (
    <div
      className="fixed inset-0 z-[1500] flex flex-col"
      style={{ background: "rgba(0,0,0,0.55)" }}
      onClick={onClose}
    >
      <div
        className="mt-auto rounded-t-2xl overflow-hidden shadow-2xl flex flex-col"
        style={{ background: "hsl(22,15%,9%)", maxHeight: "92vh" }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Drag handle */}
        <div className="flex justify-center pt-3 pb-1">
          <div className="w-10 h-1 rounded-full bg-stone-700"></div>
        </div>

        {/* Header */}
        <div className="px-4 pt-2 pb-2">
          <div className="flex items-start gap-3">
            <span
              className="inline-flex items-center justify-center w-10 h-10 rounded-lg text-base font-black text-stone-900 shrink-0"
              style={{ backgroundColor: diffColor }}
            >
              {diff}
            </span>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-1.5">
                {(prevTrail !== undefined || nextTrail !== undefined) && (
                  <button
                    type="button"
                    onClick={() => prevTrail && onNavigate?.(prevTrail)}
                    disabled={!prevTrail}
                    aria-label={
                      prevTrail
                        ? `Previous trail: ${prevTrail.name}`
                        : "No previous trail"
                    }
                    title={prevTrail ? `Previous: ${prevTrail.name}` : undefined}
                    data-testid="trail-detail-prev"
                    className="w-6 h-6 rounded-full flex items-center justify-center text-stone-400 hover:text-amber-400 hover:bg-stone-800/60 disabled:opacity-25 disabled:cursor-not-allowed transition-colors shrink-0"
                  >
                    <svg
                      viewBox="0 0 24 24"
                      className="w-3.5 h-3.5"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <polyline points="15 18 9 12 15 6" />
                    </svg>
                  </button>
                )}
                <h2
                  className="flex-1 min-w-0 text-base font-bold text-stone-100 leading-tight truncate"
                  data-testid="trail-detail-name"
                >
                  {trail.name}
                </h2>
                {(prevTrail !== undefined || nextTrail !== undefined) && (
                  <button
                    type="button"
                    onClick={() => nextTrail && onNavigate?.(nextTrail)}
                    disabled={!nextTrail}
                    aria-label={
                      nextTrail
                        ? `Next trail: ${nextTrail.name}`
                        : "No next trail"
                    }
                    title={nextTrail ? `Next: ${nextTrail.name}` : undefined}
                    data-testid="trail-detail-next"
                    className="w-6 h-6 rounded-full flex items-center justify-center text-stone-400 hover:text-amber-400 hover:bg-stone-800/60 disabled:opacity-25 disabled:cursor-not-allowed transition-colors shrink-0"
                  >
                    <svg
                      viewBox="0 0 24 24"
                      className="w-3.5 h-3.5"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <polyline points="9 18 15 12 9 6" />
                    </svg>
                  </button>
                )}
              </div>
              <p className="text-[11px] text-stone-400 mt-0.5">
                <span style={{ color: diffColor }}>{diffLabel}</span>
                {trail.legal_status ? <> · {trail.legal_status}</> : null}
                {trail.distance_km != null ? <> · {trail.distance_km.toFixed(1)} km</> : null}
              </p>
              <p className="text-[10px] text-stone-500 mt-0.5" data-testid="trail-detail-counts">
                {counts.notes} notes · {counts.photos} photos · {counts.pending} pending edits
              </p>
              <RiddenBadgeInline trailId={trail.id} />
              {isOffline && (
                <span
                  className="inline-flex items-center gap-1 mt-1 px-1.5 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider text-green-300 bg-green-500/15 border border-green-500/40"
                  data-testid="trail-detail-offline-badge"
                  title={offlineData?.downloadedAt ? `Downloaded ${new Date(offlineData.downloadedAt).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}` : "Available offline"}
                >
                  <svg viewBox="0 0 24 24" className="w-2.5 h-2.5" fill="none" stroke="currentColor" strokeWidth="3">
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                  Available offline
                  {offlineData?.downloadedAt && (
                    <span className="text-green-400/70 font-normal normal-case">
                      {" · "}{new Date(offlineData.downloadedAt).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}
                    </span>
                  )}
                </span>
              )}

              {gpxLoading ? (
                <div
                  className="flex items-center gap-1.5 mt-1 text-[10px] font-bold text-amber-300/90"
                  data-testid="trail-detail-gpx-loading"
                  role="status"
                  aria-live="polite"
                >
                  <span className="w-2.5 h-2.5 border-[1.5px] border-amber-500/30 border-t-amber-400 rounded-full animate-spin" />
                  Loading trail data…
                </div>
              ) : null}
              {trail.shared_groups && trail.shared_groups.length > 0 ? (
                <div
                  className="flex flex-wrap gap-1 mt-1.5"
                  data-testid="trail-detail-shared-groups"
                >
                  {trail.shared_groups.map((g) => (
                    <span
                      key={g.id}
                      className="inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider text-amber-300 bg-amber-500/15 border border-amber-500/40 rounded-full px-1.5 py-0.5"
                      title={`Shared into ${g.name}`}
                      data-testid={`trail-detail-shared-group-${g.id}`}
                    >
                      <svg
                        viewBox="0 0 24 24"
                        className="w-2.5 h-2.5"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2.5"
                      >
                        <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
                        <circle cx="9" cy="7" r="4" />
                        <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
                        <path d="M16 3.13a4 4 0 0 1 0 7.75" />
                      </svg>
                      {g.name}
                    </span>
                  ))}
                </div>
              ) : null}
            </div>
            <button
              onClick={onClose}
              className="w-8 h-8 rounded-full bg-stone-800 flex items-center justify-center text-stone-400 hover:text-stone-200 transition-colors shrink-0"
              aria-label="Close"
            >
              <svg viewBox="0 0 24 24" className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>
        </div>

        {/* Tab strip */}
        <div className="px-4 border-b border-[hsl(30,12%,16%)] flex gap-1 overflow-x-auto" style={{ scrollbarWidth: "none" }}>
          {tabs.map((t) => {
            const active = activeTab === t.key;
            return (
              <button
                key={t.key}
                onClick={() => setActiveTab(t.key)}
                className={`shrink-0 px-3 py-2 text-[11px] font-bold uppercase tracking-wider transition-colors flex items-center gap-1.5 border-b-2 ${
                  active
                    ? "text-amber-400 border-amber-500"
                    : "text-stone-500 border-transparent hover:text-stone-300"
                }`}
                data-testid={`trail-tab-${t.key}`}
              >
                {t.label}
                {t.badge != null && t.badge > 0 ? (
                  <span className="text-[9px] bg-stone-800 text-stone-300 px-1.5 py-0.5 rounded-full">
                    {t.badge}
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>

        {/* Tab content */}
        <div className="flex-1 overflow-y-auto">
          {activeTab === "overview" ? (
            <OverviewPanel
              key={trail.id}
              trail={trail}
              diff={diff}
              diffColor={diffColor}
              diffLabel={diffLabel}
              inPlannerRoute={inPlannerRoute}
              saveStatus={saveStatus}
              addError={addError}
              routeAtLimit={
                !inPlannerRoute && routeTrailCount >= PLANNER_MAX_TRAILS
              }
              handleAddToPlanner={handleAddToPlanner}
              handleSave={handleSave}
              setLocation={setLocation}
              isOwner={perms.isOwner}
              isSystemAdmin={isSystemAdmin}
              adminWhoamiState={adminWhoamiState}
              isExternalSource={Boolean(isExternalSource)}
              isApproximated={isApproximated}
              isUnverified={isUnverified}
              isUnowned={perms.isUnowned}
              adoptedAt={perms.adoptedAt}
              adopter={perms.adopter}
              adoptBusy={adoptBusy}
              onAdopt={handleAdopt}
              onProposeEdit={() => setActiveTab("amendments")}
              isSignedIn={Boolean(isSignedIn)}
              controlled={controlled}
            />
          ) : null}
          {activeTab === "notes" ? (
            <TrailNotesPanel trailId={trail.id} onCountsChanged={refreshCounts} />
          ) : null}
          {activeTab === "photos" ? (
            <TrailPhotosPanel trailId={trail.id} onCountsChanged={refreshCounts} offlinePhotos={offlineData?.photos} />
          ) : null}
          {activeTab === "amendments" ? (
            <TrailAmendmentsPanel
              trail={trail}
              onCountsChanged={refreshCounts}
              canModerate={perms.canModerate}
            />
          ) : null}
        </div>
      </div>
    </div>
  );
}

/**
 * Inline "Ridden" pill shown next to the trail title once the rider
 * has marked the trail as ridden. Subscribes to the global completions
 * store so it stays in sync across screens (mark in NavigationView →
 * see it lit up here without re-opening the sheet).
 */
function RiddenBadgeInline({ trailId }: { trailId: string }) {
  const { completed } = useCompletionState(trailId);
  if (!completed) return null;
  return (
    <span
      className="inline-flex items-center gap-1 mt-1 px-1.5 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider text-emerald-300 bg-emerald-500/15 border border-emerald-500/40"
      data-testid="trail-detail-ridden-badge"
      title="You've marked this trail as ridden"
    >
      <svg viewBox="0 0 24 24" className="w-2.5 h-2.5" fill="none" stroke="currentColor" strokeWidth="3">
        <polyline points="20 6 9 17 4 12" />
      </svg>
      Ridden
    </span>
  );
}

/**
 * Primary mark-as-ridden control on the trail detail sheet. Toggles the
 * completion via the store (optimistic; rolls back on server error).
 * Signed-out riders see the same affordance but tapping prompts them to
 * sign in — matches the "Save" button's pattern.
 */
function MarkRiddenButton({ trail }: { trail: Trail }) {
  const { isSignedIn } = useCurrentUser();
  const [, setLocation] = useLocation();
  const { completed } = useCompletionState(trail.id);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Backdating: closed by default. Opens a small inline date picker so
  // riders can log rides from before they joined / before they thought
  // to mark them. The "fast path" (today) stays one-tap.
  const [backdating, setBackdating] = useState(false);
  const todayLocal = new Date().toISOString().slice(0, 10);
  const [chosenDate, setChosenDate] = useState(todayLocal);

  const runMark = async (opts?: { completedAt?: string }) => {
    if (!isSignedIn) {
      setLocation("/sign-in");
      return;
    }
    if (busy) return;
    setBusy(true);
    setError(null);
    const ok = completed
      ? await unmarkCompleted(trail.id)
      : await markCompleted(trail, opts);
    setBusy(false);
    if (!ok) {
      setError(
        completed
          ? "Couldn't remove — try again."
          : "Couldn't mark as ridden — try again.",
      );
    } else if (!completed) {
      setBackdating(false);
    }
  };

  const handleClick = () => void runMark();

  const handleConfirmBackdate = () => {
    // Convert YYYY-MM-DD to ISO at noon-local so the date stamps as the
    // chosen day in any timezone (avoids "selected June 1, stored as
    // May 31" when UTC < local).
    const iso = new Date(`${chosenDate}T12:00:00`).toISOString();
    void runMark({ completedAt: iso });
  };

  return (
    <div>
      <button
        type="button"
        onClick={handleClick}
        disabled={busy}
        aria-pressed={completed}
        data-testid="trail-detail-mark-ridden"
        className={
          "w-full py-2.5 rounded-xl text-xs font-black uppercase tracking-wider transition-all flex items-center justify-center gap-1.5 border " +
          (completed
            ? "border-emerald-500/40 bg-emerald-500/15 text-emerald-300 hover:bg-emerald-500/25"
            : "border-stone-700 bg-stone-900/40 text-stone-300 hover:border-emerald-500/40 hover:text-emerald-300") +
          (busy ? " opacity-60 cursor-wait" : "")
        }
      >
        <svg viewBox="0 0 24 24" className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2.5">
          {completed ? (
            <polyline points="20 6 9 17 4 12" />
          ) : (
            <>
              <circle cx="12" cy="12" r="9" />
              <polyline points="9 12 11 14 15 10" />
            </>
          )}
        </svg>
        {completed ? "Ridden ✓ — tap to undo" : isSignedIn ? "Mark as ridden" : "Sign in to mark ridden"}
      </button>
      {error ? (
        <p
          className="mt-1 text-[10px] text-red-300"
          data-testid="trail-detail-mark-ridden-error"
        >
          {error}
        </p>
      ) : null}
      {!completed && isSignedIn ? (
        <div className="mt-1.5">
          {!backdating ? (
            <button
              type="button"
              onClick={() => setBackdating(true)}
              className="text-[10px] font-semibold uppercase tracking-wider text-stone-500 hover:text-emerald-300"
              data-testid="trail-detail-backdate-toggle"
            >
              Ridden on a different day? Backdate →
            </button>
          ) : (
            <div
              className="flex items-center gap-2"
              data-testid="trail-detail-backdate-form"
            >
              <input
                type="date"
                value={chosenDate}
                max={todayLocal}
                onChange={(e) => setChosenDate(e.target.value)}
                className="bg-stone-900 border border-stone-700 rounded px-2 py-1 text-xs text-stone-200"
                data-testid="trail-detail-backdate-input"
              />
              <button
                type="button"
                onClick={handleConfirmBackdate}
                disabled={busy || !chosenDate}
                className="px-2 py-1 rounded text-[10px] font-bold uppercase tracking-wider text-emerald-300 border border-emerald-500/40 hover:bg-emerald-500/15 disabled:opacity-50"
                data-testid="trail-detail-backdate-confirm"
              >
                Save
              </button>
              <button
                type="button"
                onClick={() => setBackdating(false)}
                className="px-2 py-1 rounded text-[10px] font-bold uppercase tracking-wider text-stone-400 hover:text-stone-200"
                data-testid="trail-detail-backdate-cancel"
              >
                Cancel
              </button>
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}

interface OverviewProps {
  trail: Trail;
  diff: number;
  diffColor: string;
  diffLabel: string;
  inPlannerRoute: boolean;
  saveStatus: "idle" | "saving" | "saved" | "error" | "needsAuth";
  addError: string | null;
  routeAtLimit: boolean;
  handleAddToPlanner: () => void;
  handleSave: () => void;
  setLocation: (path: string) => void;
  isOwner: boolean;
  isSystemAdmin: boolean;
  adminWhoamiState: "migration-missing" | "no-admins" | "not-admin" | "admin" | "signed-out" | null;
  isExternalSource: boolean;
  isApproximated: boolean;
  isUnverified: boolean;
  isUnowned: boolean;
  adoptedAt: string | null;
  adopter: TrailPermissions["adopter"];
  adoptBusy: boolean;
  onAdopt: () => void;
  onProposeEdit: () => void;
  isSignedIn: boolean;
  controlled: boolean;
}

function OverviewPanel({
  trail,
  diff,
  diffColor,
  diffLabel,
  inPlannerRoute,
  saveStatus,
  addError,
  routeAtLimit,
  handleAddToPlanner,
  handleSave,
  setLocation,
  isOwner,
  isSystemAdmin,
  adminWhoamiState,
  isExternalSource,
  isApproximated,
  isUnverified,
  isUnowned,
  adoptedAt,
  adopter,
  adoptBusy,
  onAdopt,
  onProposeEdit,
  isSignedIn,
  controlled,
}: OverviewProps) {
  const canRegrade = isOwner || isSystemAdmin;
  const showAdminBootstrapHint =
    isSignedIn &&
    !isOwner &&
    (adminWhoamiState === "migration-missing" || adminWhoamiState === "no-admins");
  const [regradeStatus, setRegradeStatus] = useState<"idle" | "loading" | "done" | "error">("idle");
  const [regradeError, setRegradeError] = useState<string | null>(null);
  const [regradeResult, setRegradeResult] = useState<{ grade: number; rationale: string } | null>(
    trail.ai_grade != null
      ? { grade: trail.ai_grade, rationale: trail.ai_grade_rationale ?? "" }
      : null,
  );

  const handleRegrade = async () => {
    setRegradeStatus("loading");
    setRegradeError(null);
    try {
      const res = await fetch(`/api/trails/${trail.id}/grade-ai`, {
        method: "POST",
        credentials: "include",
      });
      if (!res.ok) {
        // Surface the structured admin / migration explainer when the
        // backend returns one, so a fresh deploy or missing-table state
        // shows a useful hint instead of "Retry grading" with no detail.
        const json = (await res.json().catch(() => null)) as
          | { error?: string; message?: string; code?: string; state?: string }
          | null;
        const friendly =
          json?.error ?? json?.message ?? "Could not grade this trail right now.";
        setRegradeError(friendly);
        setRegradeStatus("error");
        return;
      }
      const json = (await res.json()) as { grade: number; rationale: string };
      setRegradeResult(json);
      setRegradeStatus("done");
    } catch {
      setRegradeError("Network error — please try again.");
      setRegradeStatus("error");
    }
  };

  return (
    <div data-testid="trail-overview-panel">
      {adoptedAt || adopter ? (
        <div className="px-4 pt-3" data-testid="trail-detail-adopted-by">
          <div className="flex items-center gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-[11px] text-emerald-300">
            <svg viewBox="0 0 24 24" className="w-3.5 h-3.5 shrink-0" fill="none" stroke="currentColor" strokeWidth="2.5">
              <polyline points="20 6 9 17 4 12" />
            </svg>
            <span className="font-bold uppercase tracking-wider">
              Adopted by {adopter?.display_name ?? "a rider"}
              {isExternalSource ? ` · Originally ${trail.source === "tet" ? "TET" : trail.source === "act" ? "ACT" : "AI-discovered"}` : ""}
            </span>
            {trail.source_url ? (
              <a
                href={trail.source_url}
                target="_blank"
                rel="noopener noreferrer"
                className="ml-auto underline text-emerald-200 hover:text-emerald-100"
                data-testid="trail-detail-source-link"
              >
                View source →
              </a>
            ) : null}
          </div>
        </div>
      ) : (isExternalSource || isApproximated || isUnverified) ? (
        <div className="px-4 pt-3">
          <div
            className={`flex flex-wrap items-center gap-2 rounded-lg border px-3 py-2 text-[11px] ${
              isApproximated
                ? "border-amber-500/40 bg-amber-500/10 text-amber-300"
                : "border-stone-700 bg-stone-900/40 text-stone-300"
            }`}
            data-testid="trail-detail-source-badge"
          >
            {isExternalSource ? (
              <span className="font-bold uppercase tracking-wider">
                {trail.source === "tet" ? "TET" : trail.source === "act" ? "ACT" : "AI-discovered"}
              </span>
            ) : null}
            {isApproximated ? (
              <span className="font-bold uppercase tracking-wider">⚠ AI-approximated route — verify before navigating</span>
            ) : isUnverified ? (
              <span className="font-bold uppercase tracking-wider">Unverified</span>
            ) : null}
            {trail.source_url ? (
              <a
                href={trail.source_url}
                target="_blank"
                rel="noopener noreferrer"
                className="ml-auto underline text-amber-300 hover:text-amber-200"
                data-testid="trail-detail-source-link"
              >
                {trail.source === "tet" || trail.source === "act"
                  ? `Get GPX from ${(trail.source ?? "source").toUpperCase()}`
                  : "View source →"}
              </a>
            ) : null}
          </div>
        </div>
      ) : null}
      {!(adoptedAt || adopter) && isUnowned && isSignedIn ? (
        <div className="px-4 pt-3">
          <button
            onClick={onAdopt}
            disabled={adoptBusy}
            className="w-full py-2.5 rounded-xl text-xs font-black uppercase tracking-wider transition-all flex items-center justify-center gap-1.5 border border-amber-500/40 bg-amber-500/15 text-amber-400 hover:bg-amber-500/25 disabled:opacity-50"
            data-testid="trail-detail-adopt"
          >
            <svg viewBox="0 0 24 24" className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2.5">
              <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" />
            </svg>
            {adoptBusy ? "Adopting…" : "Adopt this trail"}
          </button>
        </div>
      ) : null}
      <div className="px-4 pt-3 pb-3 grid grid-cols-2 gap-2">
        <div className="bg-[hsl(22,15%,12%)] border border-[hsl(30,12%,18%)] rounded-lg px-3 py-2">
          <div className="text-[9px] text-stone-500 uppercase tracking-wider">Type</div>
          <div className="text-sm font-bold text-stone-200 truncate">
            {trail.legal_status || trail.type || "Trail"}
          </div>
        </div>
        <div className="bg-[hsl(22,15%,12%)] border border-[hsl(30,12%,18%)] rounded-lg px-3 py-2">
          <div className="text-[9px] text-stone-500 uppercase tracking-wider">Distance</div>
          <div className="text-sm font-bold text-stone-200">
            {trail.distance_km != null ? `${trail.distance_km.toFixed(1)} km` : "—"}
          </div>
        </div>
        <div className="bg-[hsl(22,15%,12%)] border border-[hsl(30,12%,18%)] rounded-lg px-3 py-2">
          <div className="text-[9px] text-stone-500 uppercase tracking-wider">Surface</div>
          <div className="text-sm font-bold text-stone-200 truncate">
            {trail.terrain || "Off-road"}
          </div>
        </div>
        <div className="bg-[hsl(22,15%,12%)] border border-[hsl(30,12%,18%)] rounded-lg px-3 py-2">
          <div className="text-[9px] text-stone-500 uppercase tracking-wider">Difficulty</div>
          <div className="text-sm font-bold" style={{ color: diffColor }}>
            {diff}/10 · {diffLabel}
          </div>
        </div>
      </div>

      <TrailElevationChart trail={trail} />

      {(regradeResult || canRegrade || showAdminBootstrapHint) ? (
        <div className="px-4 pb-2">
          <div
            className="rounded-lg border border-[hsl(30,12%,18%)] bg-[hsl(22,15%,12%)] px-3 py-2"
            data-testid="trail-detail-ai-grade"
          >
            <div className="flex items-center justify-between gap-2">
              <div className="text-[10px] uppercase tracking-wider text-stone-500">
                AI grade{isSystemAdmin && !isOwner ? " · admin" : ""}
              </div>
              {canRegrade ? (
                <button
                  onClick={handleRegrade}
                  disabled={regradeStatus === "loading"}
                  className="text-[10px] uppercase tracking-wider text-amber-400 hover:text-amber-300 disabled:opacity-60"
                  data-testid="trail-detail-regrade"
                >
                  {regradeStatus === "loading"
                    ? "Grading…"
                    : regradeStatus === "error"
                    ? "Retry grading"
                    : regradeResult
                    ? "Re-grade"
                    : "Grade with AI"}
                </button>
              ) : null}
            </div>
            {regradeResult ? (
              <div className="mt-1">
                <div className="text-sm font-bold text-stone-200">{regradeResult.grade}/10</div>
                {regradeResult.rationale ? (
                  <div className="text-[11px] text-stone-400 mt-0.5">{regradeResult.rationale}</div>
                ) : null}
              </div>
            ) : (
              <div className="text-[11px] text-stone-500 mt-0.5">
                {canRegrade
                  ? "No AI grade yet — click to generate one."
                  : "No AI grade yet."}
              </div>
            )}
            {regradeStatus === "error" && regradeError ? (
              <div
                className="mt-1 text-[11px] text-amber-300 leading-snug"
                data-testid="trail-detail-regrade-error"
              >
                {regradeError}
              </div>
            ) : null}
            {showAdminBootstrapHint ? (
              <div
                className="mt-2 flex items-start gap-2 rounded border border-amber-500/30 bg-amber-500/10 px-2.5 py-2 text-[11px] text-amber-200 leading-snug"
                data-testid="trail-detail-admin-bootstrap-hint"
              >
                <svg viewBox="0 0 24 24" className="w-3.5 h-3.5 shrink-0 mt-0.5 text-amber-400" fill="none" stroke="currentColor" strokeWidth="2">
                  <circle cx="12" cy="12" r="10" />
                  <line x1="12" y1="8" x2="12" y2="12" />
                  <line x1="12" y1="16" x2="12.01" y2="16" />
                </svg>
                <span>
                  Admin features are waiting to be turned on.{" "}
                  <a
                    href="/admin"
                    onClick={(e) => { e.preventDefault(); setLocation("/admin"); }}
                    className="font-bold text-amber-300 underline hover:text-amber-200"
                    data-testid="trail-detail-admin-bootstrap-link"
                  >
                    Go to Admin
                  </a>{" "}
                  to get started.
                </span>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}

      {/* Inline cap warning — surfaced when the user tries to add this
          trail but the planner already holds PLANNER_MAX_TRAILS trails.
          Sits above the action buttons so the rider sees it without
          having to scroll. */}
      {addError ? (
        <div
          className="mx-4 mt-1 mb-2 bg-red-900/30 border border-red-600/50 rounded-lg px-3 py-2 flex items-start gap-2"
          data-testid="trail-detail-add-error"
        >
          <svg viewBox="0 0 24 24" className="w-4 h-4 text-red-400 shrink-0 mt-0.5" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="8" x2="12" y2="12" />
            <line x1="12" y1="16" x2="12.01" y2="16" />
          </svg>
          <p className="text-[11px] text-red-200 leading-tight">{addError}</p>
        </div>
      ) : null}

      {isSignedIn ? (
        <div className="px-4 pb-2">
          <button
            onClick={onProposeEdit}
            className="w-full py-2.5 rounded-xl text-xs font-black uppercase tracking-wider transition-all flex items-center justify-center gap-1.5 border border-stone-700 text-stone-300 bg-stone-900/40 hover:border-amber-500/40 hover:text-amber-400"
            data-testid="trail-detail-propose-edit"
          >
            <svg viewBox="0 0 24 24" className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2.5">
              <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
              <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
            </svg>
            Propose an Edit
          </button>
        </div>
      ) : null}

      {!isApproximated ? (
        <div className="px-4 pb-2">
          <MarkRiddenButton trail={trail} />
        </div>
      ) : null}

      <div className="px-4 pb-5 pt-1 grid grid-cols-2 gap-2">
        {isApproximated ? (
          <div
            className="py-3 px-2 rounded-xl text-[11px] font-bold uppercase tracking-wider text-stone-500 border border-dashed border-stone-700 bg-stone-900/40 flex items-center justify-center text-center leading-tight"
            data-testid="trail-detail-add-planner-disabled"
            title="AI-approximated trails are reference only and cannot be used for navigation. A moderator must verify the route first."
          >
            Reference only — cannot navigate
          </div>
        ) : routeAtLimit ? (
          // Route is full — render a disabled stand-in so the rider can
          // see WHY the affordance is unavailable instead of clicking a
          // button that silently no-ops. Mirrors the visual weight of
          // the active button so the layout doesn't shift.
          <button
            type="button"
            disabled
            className="py-3 px-2 rounded-xl text-[11px] font-bold uppercase tracking-wider text-stone-500 border border-dashed border-stone-700 bg-stone-900/40 flex items-center justify-center text-center leading-tight cursor-not-allowed"
            data-testid="trail-detail-add-planner-full"
            title={`Route is full — limit is ${PLANNER_MAX_TRAILS} trails. Remove one before adding more.`}
          >
            Route full ({PLANNER_MAX_TRAILS} max)
          </button>
        ) : (
        <button
          onClick={handleAddToPlanner}
          className={`group py-3 rounded-xl text-xs font-black uppercase tracking-wider transition-all flex items-center justify-center gap-1.5 ${
            inPlannerRoute
              ? "bg-amber-500/15 border border-amber-500/40 text-amber-400 hover:bg-red-500/15 hover:border-red-500/50 hover:text-red-400"
              : "text-stone-900 shadow-lg shadow-amber-900/30"
          }`}
          style={
            inPlannerRoute
              ? undefined
              : { background: "linear-gradient(135deg, #d4870c 0%, #f0a832 50%, #d4870c 100%)" }
          }
          data-testid="trail-detail-add-planner"
          aria-pressed={inPlannerRoute}
        >
          {inPlannerRoute ? (
            <>
              <svg viewBox="0 0 24 24" className="w-3.5 h-3.5 group-hover:hidden" fill="none" stroke="currentColor" strokeWidth="2.5">
                <polyline points="20 6 9 17 4 12" />
              </svg>
              <svg viewBox="0 0 24 24" className="w-3.5 h-3.5 hidden group-hover:block" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                <line x1="6" y1="6" x2="18" y2="18" />
                <line x1="6" y1="18" x2="18" y2="6" />
              </svg>
              <span className="group-hover:hidden">{controlled ? "Selected" : "In Planner"}</span>
              <span className="hidden group-hover:inline">Remove</span>
            </>
          ) : (
            <>
              <svg viewBox="0 0 24 24" className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2.5">
                <line x1="12" y1="5" x2="12" y2="19" />
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
              {controlled ? "Add to Selection" : "Add to Planner"}
            </>
          )}
        </button>
        )}
        <button
          onClick={handleSave}
          disabled={saveStatus === "saving" || saveStatus === "saved"}
          className={`py-3 rounded-xl text-xs font-black uppercase tracking-wider transition-all flex items-center justify-center gap-1.5 border ${
            saveStatus === "saved"
              ? "border-amber-500/40 bg-amber-500/15 text-amber-400 cursor-default"
              : saveStatus === "error" || saveStatus === "needsAuth"
              ? "border-red-500/50 text-red-400 bg-red-500/10"
              : "border-stone-700 text-stone-300 bg-stone-900/40 hover:border-amber-500/40 hover:text-amber-400"
          }`}
          data-testid="trail-detail-save"
        >
          {saveStatus === "saving" ? (
            <>
              <span className="w-3.5 h-3.5 border-2 border-stone-500/40 border-t-stone-200 rounded-full animate-spin"></span>
              Saving…
            </>
          ) : saveStatus === "saved" ? (
            <>
              <svg viewBox="0 0 24 24" className="w-3.5 h-3.5" fill="#f0a832" stroke="#f0a832" strokeWidth="2">
                <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
              </svg>
              Saved
            </>
          ) : saveStatus === "needsAuth" ? (
            <span
              onClick={(e) => {
                e.stopPropagation();
                setLocation("/sign-in");
              }}
              className="cursor-pointer"
            >
              Sign in to save
            </span>
          ) : saveStatus === "error" ? (
            <>Try Again</>
          ) : (
            <>
              <svg viewBox="0 0 24 24" className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
              </svg>
              Save
            </>
          )}
        </button>
      </div>
    </div>
  );
}
