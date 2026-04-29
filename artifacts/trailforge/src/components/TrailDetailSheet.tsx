import { useEffect, useRef, useState, useCallback } from "react";
import { useLocation } from "wouter";
import { type Trail, saveTrail } from "@/lib/supabase";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { getDifficultyColor } from "@/lib/trailLayer";
import {
  addRouteTrail,
  removeRouteTrail,
  isInRoute,
  subscribeRouteTrails,
} from "@/lib/plannerRouteStore";
import {
  fetchTrailActivityCounts,
  fetchTrailPermissions,
  type TrailActivityCounts,
  type TrailPermissions,
} from "@/lib/trailContent";
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
  // Lets the parent (e.g. a trail card) reflect the latest activity counts
  // for this trail without refetching the whole feed.
  onCountsChanged?: (trailId: string, counts: TrailActivityCounts) => void;
  // Prev/next neighbours in the surrounding context (search results, route
  // order, cluster list, etc.) so the rider can jump trail-to-trail without
  // closing the sheet. Either or both may be null at the start/end of the
  // list. Arrows are hidden entirely when no neighbour is available on
  // either side (i.e. context of one).
  prevTrail?: Trail | null;
  nextTrail?: Trail | null;
  onNavigate?: (trail: Trail) => void;
}

export default function TrailDetailSheet({
  trail,
  onClose,
  onAddedToPlanner,
  onCountsChanged,
  prevTrail,
  nextTrail,
  onNavigate,
}: Props) {
  // Hold the latest callback in a ref so refreshCounts doesn't change
  // identity each render — otherwise an inline parent callback would
  // cycle: fetch → setCounts → parent rerender → new callback → effect
  // re-runs → fetch again.
  const onCountsChangedRef = useRef(onCountsChanged);
  useEffect(() => {
    onCountsChangedRef.current = onCountsChanged;
  }, [onCountsChanged]);
  const { isSignedIn, userId } = useCurrentUser();
  const [, setLocation] = useLocation();
  const [inPlannerRoute, setInPlannerRoute] = useState(() => isInRoute(trail.id));
  const [saveStatus, setSaveStatus] = useState<"idle" | "saving" | "saved" | "error" | "needsAuth">("idle");
  const [activeTab, setActiveTab] = useState<TabKey>("overview");
  const [counts, setCounts] = useState<TrailActivityCounts>({ notes: 0, photos: 0, pending: 0 });
  const [perms, setPerms] = useState<TrailPermissions>({ isOwner: false, isModerator: false, canModerate: false });
  const [isSystemAdmin, setIsSystemAdmin] = useState(false);

  // Keep the in-route flag and per-trail save status in sync when the rider
  // jumps to a neighbouring trail via the prev/next arrows. (The lazy
  // initialisers above only run on mount.)
  useEffect(() => {
    setInPlannerRoute(isInRoute(trail.id));
    setSaveStatus("idle");
  }, [trail.id]);

  useEffect(() => {
    return subscribeRouteTrails(() => setInPlannerRoute(isInRoute(trail.id)));
  }, [trail.id]);

  // Pull the system-admin flag from the API so admins can re-grade ANY
  // trail, not just their own. Owner-only re-grade was a UI regression
  // (the backend route at POST /api/trails/:id/grade-ai already permits
  // owner OR system admin). Failing closed (admin=false) on network
  // error is fine — admins can still re-grade through the AdminPage.
  useEffect(() => {
    let cancelled = false;
    if (!isSignedIn) {
      setIsSystemAdmin(false);
      return;
    }
    fetch("/api/admin/whoami", { credentials: "include" })
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { isAdmin?: boolean } | null) => {
        if (!cancelled) setIsSystemAdmin(Boolean(j?.isAdmin));
      })
      .catch(() => {
        if (!cancelled) setIsSystemAdmin(false);
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
      // Approximated trails are reference-only — never used in navigation.
      return;
    }
    if (inPlannerRoute) {
      removeRouteTrail(trail.id);
      return;
    }
    addRouteTrail(trail);
    onAddedToPlanner?.(trail);
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
              // Re-mount the panel on trail switch so internal state
              // (regrade result/status) doesn't bleed across trails when
              // the rider navigates with the prev/next arrows.
              key={trail.id}
              trail={trail}
              diff={diff}
              diffColor={diffColor}
              diffLabel={diffLabel}
              inPlannerRoute={inPlannerRoute}
              saveStatus={saveStatus}
              handleAddToPlanner={handleAddToPlanner}
              handleSave={handleSave}
              setLocation={setLocation}
              isOwner={perms.isOwner}
              isSystemAdmin={isSystemAdmin}
              isExternalSource={Boolean(isExternalSource)}
              isApproximated={isApproximated}
              isUnverified={isUnverified}
            />
          ) : null}
          {activeTab === "notes" ? (
            <TrailNotesPanel trailId={trail.id} onCountsChanged={refreshCounts} />
          ) : null}
          {activeTab === "photos" ? (
            <TrailPhotosPanel trailId={trail.id} onCountsChanged={refreshCounts} />
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

interface OverviewProps {
  trail: Trail;
  diff: number;
  diffColor: string;
  diffLabel: string;
  inPlannerRoute: boolean;
  saveStatus: "idle" | "saving" | "saved" | "error" | "needsAuth";
  handleAddToPlanner: () => void;
  handleSave: () => void;
  setLocation: (path: string) => void;
  isOwner: boolean;
  isSystemAdmin: boolean;
  isExternalSource: boolean;
  isApproximated: boolean;
  isUnverified: boolean;
}

function OverviewPanel({
  trail,
  diff,
  diffColor,
  diffLabel,
  inPlannerRoute,
  saveStatus,
  handleAddToPlanner,
  handleSave,
  setLocation,
  isOwner,
  isSystemAdmin,
  isExternalSource,
  isApproximated,
  isUnverified,
}: OverviewProps) {
  // Re-grade is allowed for the trail's owner OR a system admin —
  // mirrors the backend permission check at POST /api/trails/:id/grade-ai.
  const canRegrade = isOwner || isSystemAdmin;
  const [regradeStatus, setRegradeStatus] = useState<"idle" | "loading" | "done" | "error">("idle");
  const [regradeResult, setRegradeResult] = useState<{ grade: number; rationale: string } | null>(
    trail.ai_grade != null
      ? { grade: trail.ai_grade, rationale: trail.ai_grade_rationale ?? "" }
      : null,
  );

  const handleRegrade = async () => {
    setRegradeStatus("loading");
    try {
      const res = await fetch(`/api/trails/${trail.id}/grade-ai`, {
        method: "POST",
        credentials: "include",
      });
      if (!res.ok) {
        setRegradeStatus("error");
        return;
      }
      const json = (await res.json()) as { grade: number; rationale: string };
      setRegradeResult(json);
      setRegradeStatus("done");
    } catch {
      setRegradeStatus("error");
    }
  };

  return (
    <div data-testid="trail-overview-panel">
      {(isExternalSource || isApproximated || isUnverified) ? (
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

      {(regradeResult || canRegrade) ? (
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
          </div>
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
              <span className="group-hover:hidden">In Planner</span>
              <span className="hidden group-hover:inline">Remove</span>
            </>
          ) : (
            <>
              <svg viewBox="0 0 24 24" className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2.5">
                <line x1="12" y1="5" x2="12" y2="19" />
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
              Add to Planner
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
