import { useEffect, useMemo, useState } from "react";
import { type Trail } from "@/lib/supabase";
import { getDifficultyColor } from "@/lib/trailLayer";
import {
  addRouteTrail,
  removeRouteTrail,
  getRouteTrails,
  subscribeRouteTrails,
  PLANNER_MAX_TRAILS,
} from "@/lib/plannerRouteStore";
import { useCompletionIds } from "@/lib/completionsStore";

const DIFFICULTY_LABELS: Record<number, string> = {
  1: "Novice", 2: "Easy", 3: "Easy+", 4: "Moderate", 5: "Medium",
  6: "Hard", 7: "Expert", 8: "Extreme", 9: "Pro", 10: "Elite",
};

type SortKey = "difficulty" | "distance" | "name";

const SORT_STORAGE_KEY = "trailforge:clusterTrailListSort";

const SORT_OPTIONS: { value: SortKey; label: string }[] = [
  { value: "difficulty", label: "Difficulty" },
  { value: "distance", label: "Distance" },
  { value: "name", label: "Name" },
];

function readStoredSort(): SortKey {
  if (typeof window === "undefined") return "difficulty";
  try {
    const v = window.sessionStorage.getItem(SORT_STORAGE_KEY);
    if (v === "difficulty" || v === "distance" || v === "name") return v;
  } catch {
    // sessionStorage may be unavailable (e.g. private mode); fall through.
  }
  return "difficulty";
}

function writeStoredSort(sort: SortKey): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(SORT_STORAGE_KEY, sort);
  } catch {
    // Ignore storage failures — the in-memory state still works.
  }
}

interface Props {
  trails: Trail[];
  onSelectTrail: (trail: Trail) => void;
  onZoomToArea: () => void;
  onClose: () => void;
  /**
   * Optional override for the per-row "Add to route" / "Remove from route"
   * toggle. When provided alongside `selectedIds`, the sheet does NOT
   * subscribe to the global planner route store and instead drives both
   * the visual state and the toggle via these props. Used by PlannerMap so
   * the cluster sheet calls the planner's own `onToggle` (which carries
   * extra side effects like surfacing approximated-trail errors).
   */
  onToggleTrail?: (trail: Trail) => void;
  /**
   * Optional ids of trails currently in the route. When provided alongside
   * `onToggleTrail`, the per-row toggle reflects this set instead of the
   * global planner route store.
   */
  selectedIds?: Set<string>;
}

function toNum(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

// Comparator helper: nulls always sort to the END regardless of direction,
// so unrated / missing-distance trails don't crowd the top of the list.
function compareNullable(
  a: number | null,
  b: number | null,
): number {
  if (a == null && b == null) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  return a - b;
}

function sortTrails(trails: Trail[], sort: SortKey): Trail[] {
  const copy = [...trails];
  switch (sort) {
    case "difficulty":
      copy.sort((a, b) => {
        const cmp = compareNullable(a.difficulty, b.difficulty);
        if (cmp !== 0) return cmp;
        return a.name.localeCompare(b.name);
      });
      return copy;
    case "distance":
      copy.sort((a, b) => {
        const cmp = compareNullable(toNum(a.distance_km), toNum(b.distance_km));
        if (cmp !== 0) return cmp;
        return a.name.localeCompare(b.name);
      });
      return copy;
    case "name":
    default:
      copy.sort((a, b) => a.name.localeCompare(b.name));
      return copy;
  }
}

function formatElevationGain(m: number | null | undefined): string | null {
  if (m == null || !Number.isFinite(m)) return null;
  return `${Math.round(m).toLocaleString()} m`;
}

function difficultyLabel(d: number | null | undefined): string {
  if (d == null) return "Unrated";
  const rounded = Math.max(1, Math.min(10, Math.round(d)));
  return `${DIFFICULTY_LABELS[rounded] ?? ""} (${rounded})`.trim();
}

export default function ClusterTrailListSheet({
  trails,
  onSelectTrail,
  onZoomToArea,
  onClose,
  onToggleTrail,
  selectedIds,
}: Props) {
  const [sortKey, setSortKey] = useState<SortKey>(() => readStoredSort());
  const sorted = useMemo(() => sortTrails(trails, sortKey), [trails, sortKey]);

  const handleSortChange = (next: SortKey) => {
    setSortKey(next);
    writeStoredSort(next);
  };

  // Two ways to drive the per-row "in route" state:
  //
  // 1. Default (MapTab): subscribe to the global planner route store so
  //    the toggles reflect adds/removes happening anywhere else in the
  //    app (e.g. the trail detail sheet) without the user having to
  //    close and re-open this list. We track the FULL set of trail ids
  //    in the route — not just the intersection with the current
  //    `trails` prop — so that if the cluster's trail list changes while
  //    the sheet stays mounted, newly-shown trails already display the
  //    correct in-route state without waiting for the next store emit.
  //
  // 2. Controlled (PlannerMap): the parent owns route state and passes
  //    `selectedIds` + `onToggleTrail` directly. We skip the store
  //    subscription so the sheet can be used in places that don't share
  //    the global store and so the parent's toggle (which may have
  //    extra side effects like approximated-trail warnings) runs.
  const controlled = onToggleTrail != null && selectedIds != null;
  const [storeIds, setStoreIds] = useState<Set<string>>(
    () => (controlled ? new Set() : new Set(getRouteTrails().map((t) => t.id))),
  );
  useEffect(() => {
    if (controlled) return undefined;
    return subscribeRouteTrails((trailsInRoute) => {
      setStoreIds(new Set(trailsInRoute.map((t) => t.id)));
    });
  }, [controlled]);
  const routeIds = controlled ? selectedIds : storeIds;
  const completedIds = useCompletionIds();
  // Inline cap warning shown above the rows so a user who taps "+ Route"
  // when the planner is already full sees an explanation rather than a
  // silent no-op (the server PUT enforces PLANNER_MAX_TRAILS too).
  // Only used in the uncontrolled path; in the controlled path the
  // parent owns route state and surfaces its own warning.
  const [capError, setCapError] = useState<string | null>(null);

  const handleToggleRoute = (trail: Trail) => {
    // Approximated trails are reference-only — never used in navigation.
    // Mirrors the guard in TrailDetailSheet.handleAddToPlanner. The
    // controlled path delegates the guard to the parent's onToggleTrail
    // so it can decide how to surface the rejection (e.g. inline error).
    if (controlled) {
      onToggleTrail(trail);
      return;
    }
    if (trail.verification_status === "ai-approximated") return;
    if (routeIds.has(trail.id)) {
      removeRouteTrail(trail.id);
      setCapError(null);
      return;
    }
    const result = addRouteTrail(trail);
    if (result === "atLimit") {
      setCapError(
        `Route is full — limit is ${PLANNER_MAX_TRAILS} trails. Remove one before adding "${trail.name}".`,
      );
      return;
    }
    setCapError(null);
  };
  // The "+ Route" button is disabled when the planner is full AND the
  // trail isn't already in the route — disable up-front so the rider
  // can't tap a button that would silently no-op.
  const routeFull = !controlled && storeIds.size >= PLANNER_MAX_TRAILS;

  return (
    <div
      className="absolute inset-0 z-[1400] flex items-end justify-center pointer-events-auto"
      data-testid="cluster-trail-list-sheet"
    >
      <button
        type="button"
        aria-label="Close cluster list"
        onClick={onClose}
        className="absolute inset-0 bg-black/50"
      />
      <div className="relative w-full max-w-md mx-2 mb-2 bg-stone-900 border border-stone-700 rounded-2xl shadow-2xl flex flex-col"
        style={{ maxHeight: "70vh" }}
      >
        <div className="flex items-center justify-between px-4 pt-3 pb-2 border-b border-stone-800">
          <div>
            <div className="text-[10px] font-bold uppercase tracking-widest text-stone-500">
              Trails in this cluster
            </div>
            <div className="text-sm font-bold text-stone-100" data-testid="cluster-trail-list-count">
              {sorted.length} trail{sorted.length !== 1 ? "s" : ""}
            </div>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="text-stone-400 hover:text-stone-200 text-xl leading-none px-2"
            data-testid="cluster-trail-list-close"
          >
            ×
          </button>
        </div>

        <div
          className="flex items-center gap-2 px-4 py-2 border-b border-stone-800"
          data-testid="cluster-trail-list-sort"
          role="radiogroup"
          aria-label="Sort trails"
        >
          <span className="text-[10px] font-bold uppercase tracking-widest text-stone-500">
            Sort
          </span>
          <div className="flex items-center gap-1">
            {SORT_OPTIONS.map((opt) => {
              const active = sortKey === opt.value;
              return (
                <button
                  key={opt.value}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  onClick={() => handleSortChange(opt.value)}
                  data-testid={`cluster-trail-list-sort-${opt.value}`}
                  className={
                    "px-2 py-1 rounded-md text-[10px] font-bold uppercase tracking-wider border transition-colors " +
                    (active
                      ? "border-amber-500 bg-amber-500/15 text-amber-300"
                      : "border-stone-700 text-stone-400 hover:border-stone-500 hover:text-stone-200")
                  }
                >
                  {opt.label}
                </button>
              );
            })}
          </div>
        </div>

        {capError ? (
          <div
            className="mx-3 mt-2 mb-1 bg-red-900/30 border border-red-600/50 rounded-lg px-3 py-2 flex items-start gap-2"
            data-testid="cluster-trail-list-cap-error"
            role="alert"
          >
            <svg viewBox="0 0 24 24" className="w-4 h-4 text-red-400 shrink-0 mt-0.5" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="10" />
              <line x1="12" y1="8" x2="12" y2="12" />
              <line x1="12" y1="16" x2="12.01" y2="16" />
            </svg>
            <p className="text-[11px] text-red-200 leading-tight">{capError}</p>
          </div>
        ) : null}

        <div className="overflow-y-auto flex-1" data-testid="cluster-trail-list-rows">
          {sorted.length === 0 ? (
            <div className="px-4 py-6 text-xs text-stone-500 text-center">
              No trails to show.
            </div>
          ) : (
            <ul className="divide-y divide-stone-800">
              {sorted.map((trail) => {
                const diffColor = getDifficultyColor(trail.difficulty ?? undefined);
                const km = toNum(trail.distance_km);
                const gain = formatElevationGain(trail.elevation_gain_m);
                const loss = formatElevationGain(trail.elevation_loss_m);
                const inRoute = routeIds.has(trail.id);
                const isApproximated =
                  trail.verification_status === "ai-approximated";
                return (
                  <li
                    key={trail.id}
                    className="flex items-stretch hover:bg-stone-800/60 active:bg-stone-800 transition-colors"
                  >
                    <button
                      type="button"
                      onClick={() => onSelectTrail(trail)}
                      className="flex-1 min-w-0 flex items-center justify-between gap-3 px-4 py-2.5 text-left"
                      data-testid={`cluster-trail-row-${trail.id}`}
                    >
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-1.5">
                          <div className="text-sm font-semibold text-stone-100 truncate flex-1 min-w-0">
                            {trail.name}
                          </div>
                          {completedIds.has(trail.id) && (
                            <span
                              className="shrink-0 inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full text-[9px] font-bold uppercase tracking-wider text-emerald-300 bg-emerald-500/15 border border-emerald-500/40"
                              data-testid={`cluster-trail-ridden-${trail.id}`}
                              title="You've ridden this trail"
                            >
                              <svg viewBox="0 0 24 24" className="w-2.5 h-2.5" fill="none" stroke="currentColor" strokeWidth="3">
                                <polyline points="20 6 9 17 4 12" />
                              </svg>
                              Ridden
                            </span>
                          )}
                        </div>
                        <div className="text-[10px] text-stone-500 mt-0.5 flex items-center gap-2 flex-wrap">
                          {km != null && <span>{km.toFixed(1)} km</span>}
                          {gain && (
                            <span
                              className="text-emerald-400"
                              title="Total ascent"
                              data-testid={`cluster-trail-elevation-gain-${trail.id}`}
                            >
                              ↑ {gain}
                            </span>
                          )}
                          {loss && (
                            <span
                              className="text-sky-400"
                              title="Total descent"
                              data-testid={`cluster-trail-elevation-loss-${trail.id}`}
                            >
                              ↓ {loss}
                            </span>
                          )}
                          {trail.legal_status && (
                            <span className="uppercase tracking-wider">{trail.legal_status}</span>
                          )}
                        </div>
                      </div>
                      <span
                        className="shrink-0 inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold text-stone-900"
                        style={{ background: diffColor }}
                        data-testid={`cluster-trail-difficulty-${trail.id}`}
                      >
                        {difficultyLabel(trail.difficulty)}
                      </span>
                    </button>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleToggleRoute(trail);
                      }}
                      disabled={isApproximated || (routeFull && !inRoute)}
                      aria-pressed={inRoute}
                      title={
                        isApproximated
                          ? "AI-approximated trails can't be added to a route"
                          : routeFull && !inRoute
                            ? `Route is full — limit is ${PLANNER_MAX_TRAILS} trails. Remove one before adding more.`
                            : inRoute
                              ? "Remove from planner route"
                              : "Add to planner route"
                      }
                      data-testid={`cluster-trail-route-toggle-${trail.id}`}
                      className={
                        "shrink-0 self-center mr-2 px-2.5 py-1 rounded-md text-[10px] font-bold uppercase tracking-wider border transition-colors " +
                        (isApproximated || (routeFull && !inRoute)
                          ? "border-stone-800 text-stone-600 cursor-not-allowed"
                          : inRoute
                            ? "border-amber-500 bg-amber-500/15 text-amber-300 hover:bg-amber-500/25"
                            : "border-stone-700 text-stone-300 hover:border-amber-500 hover:text-amber-300")
                      }
                    >
                      {inRoute
                        ? "✓ In route"
                        : routeFull
                          ? "Route full"
                          : "+ Route"}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <div className="px-3 py-2.5 border-t border-stone-800 flex items-center justify-end gap-2">
          <button
            onClick={onClose}
            className="px-3 py-1.5 rounded-lg text-xs font-bold uppercase tracking-wider text-stone-300 hover:text-stone-100"
          >
            Cancel
          </button>
          <button
            onClick={onZoomToArea}
            className="px-3 py-1.5 rounded-lg text-xs font-bold uppercase tracking-wider text-stone-900"
            style={{ background: "linear-gradient(135deg, #d4870c, #f0a832)" }}
            data-testid="cluster-zoom-to-area"
          >
            Zoom to area
          </button>
        </div>
      </div>
    </div>
  );
}
