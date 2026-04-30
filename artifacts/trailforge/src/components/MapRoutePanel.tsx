import { Component, useState, type ReactNode } from "react";
import { type Trail } from "@/lib/supabase";
import { getDifficultyColor } from "@/lib/trailLayer";
import type { RouteEntry, RouteWaypoint } from "@/lib/routing";

interface Props {
  trails: Trail[];
  onReorder: (next: Trail[]) => void;
  onRemove: (id: string) => void;
  onClear: () => void;
  onBuildRoute: () => void;
  // Tapping a row opens the parent's TrailDetailSheet so the rider can read
  // the route's trails in order (and use the sheet's prev/next arrows to
  // jump between them). Optional — when not provided, rows are still
  // reorderable/removable but not tappable.
  onSelectTrail?: (trail: Trail) => void;
  /** Custom POI/waypoint stops the rider has added to the planner route. */
  waypoints?: RouteWaypoint[];
  onRemoveWaypoint?: (waypointId: string) => void;
  /**
   * Interleaved trail+waypoint list in the rider's chosen order. When
   * provided, the panel renders rows inline (mirrors `RouteBuilder`) so a
   * fuel stop can sit between trail 1 and trail 2 instead of in a fixed
   * "Stops" group at the top. Falls back to the legacy split layout when
   * absent — keeps existing tests and any caller that hasn't migrated yet
   * working unchanged.
   */
  entries?: RouteEntry[];
  /**
   * Replace the full ordered list — used when the rider taps a row's
   * up/down arrow to swap with an adjacent stop. Required to enable the
   * reorder buttons on waypoint rows in interleaved mode.
   */
  onReorderEntries?: (entries: RouteEntry[]) => void;
}

const WAYPOINT_KIND_COLOR: Record<RouteWaypoint["kind"], string> = {
  fuel: "#3b82f6",
  campsite: "#22c55e",
  custom: "#f0a832",
};

/** Safe numeric coercion — Supabase returns `numeric` columns as strings. */
function toNum(v: unknown): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

class PanelErrorBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(err: unknown) {
    // Surface to console so we can debug, but don't break the surrounding map.
    // eslint-disable-next-line no-console
    console.error("[MapRoutePanel] render failure:", err);
  }
  render() {
    if (this.state.failed) return null;
    return this.props.children;
  }
}

/**
 * Floating "Route" panel rendered over the Map tab. Shows the trails the user
 * has added to their planner route in tap order, with reorder + remove
 * controls and a single "Build Route" CTA that hands off to the Planner.
 *
 * Renders as a compact pill by default and expands into a card on tap so it
 * doesn't dominate the map view.
 */
function MapRoutePanelInner({
  trails,
  onReorder,
  onRemove,
  onClear,
  onBuildRoute,
  onSelectTrail,
  waypoints,
  onRemoveWaypoint,
  entries,
  onReorderEntries,
}: Props) {
  const [expanded, setExpanded] = useState(false);
  const wps = waypoints ?? [];
  // Hide the panel only when both lists are empty so a rider can still
  // see (and remove) custom stops they added before picking any trails.
  if (trails.length === 0 && wps.length === 0) return null;

  const totalKm = trails.reduce((s, t) => s + toNum(t.distance_km), 0);

  // Interleaved render is the canonical mode now — both PlannerTab and
  // MapTab pass `entries`. The legacy split-section render below is kept
  // as a fallback so callers (or tests) that haven't migrated still work.
  // Gate on presence of the prop, not its length: an empty array from a
  // migrated caller (e.g. mid-clear flicker) should still hit the
  // interleaved branch so we don't bounce between layouts.
  const interleaved = entries != null;

  const moveUp = (idx: number) => {
    if (idx === 0) return;
    const next = [...trails];
    [next[idx - 1], next[idx]] = [next[idx], next[idx - 1]];
    onReorder(next);
  };

  const moveDown = (idx: number) => {
    if (idx === trails.length - 1) return;
    const next = [...trails];
    [next[idx], next[idx + 1]] = [next[idx + 1], next[idx]];
    onReorder(next);
  };

  // Swap two adjacent rows in the interleaved entries list. We bounds-check
  // here so the callers (the up/down buttons) can stay declarative and
  // avoid re-deriving "is this the first/last row" themselves.
  const swapEntries = (a: number, b: number) => {
    if (!entries || !onReorderEntries) return;
    if (a < 0 || b < 0 || a >= entries.length || b >= entries.length) return;
    const next = entries.slice();
    [next[a], next[b]] = [next[b], next[a]];
    onReorderEntries(next);
  };

  // Map trail.id → its 1-based position in the original trail list so the
  // interleaved render can keep showing the same numbered badge ("Trail #2")
  // riders are used to. Waypoints don't get a number — they're glue rows.
  const trailIdxById = new Map<string, number>();
  trails.forEach((t, i) => trailIdxById.set(t.id, i));

  return (
    <div
      className="absolute top-12 left-1/2 -translate-x-1/2 z-[1100] pointer-events-auto"
      style={{ width: "calc(100% - 24px)", maxWidth: "360px" }}
      data-testid="map-route-panel"
    >
      <div
        className="rounded-xl shadow-2xl overflow-hidden"
        style={{
          background: "hsl(22,15%,11%)",
          border: "1.5px solid #d4870c80",
        }}
      >
        {/* Summary bar (always visible) */}
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="w-full flex items-center gap-2 px-3 py-2 text-left"
          data-testid="map-route-panel-toggle"
          aria-expanded={expanded}
        >
          <div className="w-7 h-7 rounded-md bg-amber-500/15 flex items-center justify-center shrink-0">
            <svg
              viewBox="0 0 24 24"
              className="w-4 h-4 text-amber-400"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
              <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
            </svg>
          </div>
          <div className="flex-1 min-w-0">
            <div
              className="text-[11px] font-black text-amber-400 uppercase tracking-wider"
              data-testid="map-route-panel-summary"
            >
              {trails.length} Trail{trails.length !== 1 ? "s" : ""} ·{" "}
              {totalKm.toFixed(1)} km
              {wps.length > 0 ? ` · ${wps.length} stop${wps.length !== 1 ? "s" : ""}` : ""}
            </div>
            <div className="text-[10px] text-stone-400 mt-0.5 truncate">
              {trails.length > 0
                ? trails.map((t) => t.name).slice(0, 2).join(" → ") +
                  (trails.length > 2 ? ` → +${trails.length - 2} more` : "")
                : wps.map((w) => w.name).slice(0, 2).join(" → ") +
                  (wps.length > 2 ? ` → +${wps.length - 2} more` : "")}
            </div>
          </div>
          <svg
            viewBox="0 0 24 24"
            className={`w-4 h-4 text-stone-400 shrink-0 transition-transform ${
              expanded ? "rotate-180" : ""
            }`}
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
          >
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </button>

        {/* Expanded list + actions */}
        {expanded && (
          <div className="border-t border-[hsl(30,12%,18%)]">
            <div
              className="max-h-56 overflow-y-auto px-2 py-2 space-y-1"
              data-testid="map-route-panel-list"
            >
              {interleaved
                ? entries!.map((entry, idx) => {
                    const isFirst = idx === 0;
                    const isLast = idx === entries!.length - 1;
                    if (entry.kind === "waypoint") {
                      const wp = entry.waypoint;
                      return (
                        <div
                          key={`wp-${wp.id}`}
                          data-testid={`map-route-panel-waypoint-${wp.id}`}
                          className="flex items-center gap-1.5 bg-[hsl(22,15%,13%)] rounded-lg px-2 py-1.5 border border-[hsl(30,12%,18%)]"
                        >
                          <div
                            className="w-5 h-5 rounded-full flex items-center justify-center shrink-0"
                            style={{
                              background: WAYPOINT_KIND_COLOR[wp.kind],
                              border: "1.5px solid #f0a832",
                            }}
                          >
                            <svg
                              viewBox="0 0 24 24"
                              width="9"
                              height="9"
                              fill="none"
                              stroke="#fff"
                              strokeWidth="2.4"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                            >
                              {wp.kind === "fuel" ? (
                                <path d="M3 12V5a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v14H3v-7zM13 8h2a2 2 0 0 1 2 2v6a2 2 0 0 0 2 2 2 2 0 0 0 2-2v-6l-3-3" />
                              ) : wp.kind === "campsite" ? (
                                <path d="M3 20 12 4l9 16H3z M12 4v16" />
                              ) : (
                                <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z" />
                              )}
                            </svg>
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="text-[11px] font-bold text-stone-100 truncate">
                              {wp.name}
                            </div>
                            <div className="text-[9px] text-stone-500 capitalize">
                              {wp.kind} stop
                            </div>
                          </div>
                          {onReorderEntries && (
                            <div className="flex flex-col gap-0">
                              <button
                                type="button"
                                onClick={() => swapEntries(idx, idx - 1)}
                                disabled={isFirst}
                                aria-label={`Move stop ${wp.name} up`}
                                data-testid={`map-route-panel-waypoint-up-${wp.id}`}
                                className="w-5 h-4 rounded flex items-center justify-center text-stone-500 hover:text-stone-200 disabled:opacity-25 disabled:cursor-not-allowed transition-colors"
                              >
                                <svg viewBox="0 0 24 24" className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth="2.5">
                                  <polyline points="18 15 12 9 6 15" />
                                </svg>
                              </button>
                              <button
                                type="button"
                                onClick={() => swapEntries(idx, idx + 1)}
                                disabled={isLast}
                                aria-label={`Move stop ${wp.name} down`}
                                data-testid={`map-route-panel-waypoint-down-${wp.id}`}
                                className="w-5 h-4 rounded flex items-center justify-center text-stone-500 hover:text-stone-200 disabled:opacity-25 disabled:cursor-not-allowed transition-colors"
                              >
                                <svg viewBox="0 0 24 24" className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth="2.5">
                                  <polyline points="6 9 12 15 18 9" />
                                </svg>
                              </button>
                            </div>
                          )}
                          {onRemoveWaypoint && (
                            <button
                              type="button"
                              onClick={() => onRemoveWaypoint(wp.id)}
                              aria-label={`Remove stop ${wp.name}`}
                              data-testid={`map-route-panel-waypoint-remove-${wp.id}`}
                              className="w-6 h-6 rounded-full bg-stone-800/60 flex items-center justify-center text-stone-500 hover:text-red-400 hover:bg-red-900/20 transition-colors shrink-0"
                            >
                              <svg viewBox="0 0 24 24" className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth="2.5">
                                <line x1="18" y1="6" x2="6" y2="18" />
                                <line x1="6" y1="6" x2="18" y2="18" />
                              </svg>
                            </button>
                          )}
                        </div>
                      );
                    }
                    // Trail row — same chrome as the legacy render. The
                    // up/down arrows route through the entries swap so the
                    // trail can swap with an adjacent waypoint as well as
                    // another trail (the whole point of this task).
                    const trail = entry.trail;
                    const tIdx = trailIdxById.get(trail.id) ?? 0;
                    const diff = trail.difficulty ?? 5;
                    const diffColor = getDifficultyColor(diff);
                    return (
                      <div
                        key={`trail-${trail.id}`}
                        className="flex items-center gap-1.5 bg-[hsl(22,15%,13%)] rounded-lg px-2 py-1.5 border border-[hsl(30,12%,18%)]"
                        data-testid={`map-route-panel-item-${tIdx}`}
                      >
                        <div
                          className="w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-black text-stone-900 shrink-0"
                          style={{ backgroundColor: diffColor }}
                        >
                          {tIdx + 1}
                        </div>
                        {onSelectTrail ? (
                          <button
                            type="button"
                            onClick={() => onSelectTrail(trail)}
                            className="flex-1 min-w-0 text-left hover:text-amber-300 transition-colors"
                            aria-label={`View details for ${trail.name}`}
                            data-testid={`map-route-panel-open-${tIdx}`}
                          >
                            <div className="text-[11px] font-bold text-stone-100 truncate">
                              {trail.name}
                            </div>
                            <div className="text-[9px] text-stone-500">
                              {trail.distance_km != null
                                ? `${toNum(trail.distance_km).toFixed(1)} km`
                                : "—"}
                              {trail.legal_status ? ` · ${trail.legal_status}` : ""}
                            </div>
                          </button>
                        ) : (
                          <div className="flex-1 min-w-0">
                            <div className="text-[11px] font-bold text-stone-100 truncate">
                              {trail.name}
                            </div>
                            <div className="text-[9px] text-stone-500">
                              {trail.distance_km != null
                                ? `${toNum(trail.distance_km).toFixed(1)} km`
                                : "—"}
                              {trail.legal_status ? ` · ${trail.legal_status}` : ""}
                            </div>
                          </div>
                        )}
                        <div className="flex flex-col gap-0">
                          <button
                            type="button"
                            onClick={() =>
                              onReorderEntries
                                ? swapEntries(idx, idx - 1)
                                : moveUp(tIdx)
                            }
                            disabled={isFirst}
                            aria-label={`Move ${trail.name} up`}
                            data-testid={`map-route-panel-up-${tIdx}`}
                            className="w-5 h-4 rounded flex items-center justify-center text-stone-500 hover:text-stone-200 disabled:opacity-25 disabled:cursor-not-allowed transition-colors"
                          >
                            <svg viewBox="0 0 24 24" className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth="2.5">
                              <polyline points="18 15 12 9 6 15" />
                            </svg>
                          </button>
                          <button
                            type="button"
                            onClick={() =>
                              onReorderEntries
                                ? swapEntries(idx, idx + 1)
                                : moveDown(tIdx)
                            }
                            disabled={isLast}
                            aria-label={`Move ${trail.name} down`}
                            data-testid={`map-route-panel-down-${tIdx}`}
                            className="w-5 h-4 rounded flex items-center justify-center text-stone-500 hover:text-stone-200 disabled:opacity-25 disabled:cursor-not-allowed transition-colors"
                          >
                            <svg viewBox="0 0 24 24" className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth="2.5">
                              <polyline points="6 9 12 15 18 9" />
                            </svg>
                          </button>
                        </div>
                        <button
                          type="button"
                          onClick={() => onRemove(trail.id)}
                          aria-label={`Remove ${trail.name}`}
                          data-testid={`map-route-panel-remove-${tIdx}`}
                          className="w-6 h-6 rounded-full bg-stone-800/60 flex items-center justify-center text-stone-500 hover:text-red-400 hover:bg-red-900/20 transition-colors shrink-0"
                        >
                          <svg viewBox="0 0 24 24" className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth="2.5">
                            <line x1="18" y1="6" x2="6" y2="18" />
                            <line x1="6" y1="6" x2="18" y2="18" />
                          </svg>
                        </button>
                      </div>
                    );
                  })
                : (
                <>
                  {wps.length > 0 && (
                    <div className="space-y-1 pb-1.5 border-b border-[hsl(30,12%,18%)] mb-1.5">
                      <p className="text-[9px] uppercase tracking-wider text-stone-500 font-bold px-1">
                        Stops ({wps.length})
                      </p>
                      {wps.map((wp) => (
                        <div
                          key={wp.id}
                          data-testid={`map-route-panel-waypoint-${wp.id}`}
                          className="flex items-center gap-1.5 bg-[hsl(22,15%,13%)] rounded-lg px-2 py-1.5 border border-[hsl(30,12%,18%)]"
                        >
                          <div
                            className="w-5 h-5 rounded-full flex items-center justify-center shrink-0"
                            style={{
                              background: WAYPOINT_KIND_COLOR[wp.kind],
                              border: "1.5px solid #f0a832",
                            }}
                          >
                            <svg
                              viewBox="0 0 24 24"
                              width="9"
                              height="9"
                              fill="none"
                              stroke="#fff"
                              strokeWidth="2.4"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                            >
                              {wp.kind === "fuel" ? (
                                <path d="M3 12V5a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v14H3v-7zM13 8h2a2 2 0 0 1 2 2v6a2 2 0 0 0 2 2 2 2 0 0 0 2-2v-6l-3-3" />
                              ) : wp.kind === "campsite" ? (
                                <path d="M3 20 12 4l9 16H3z M12 4v16" />
                              ) : (
                                <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z" />
                              )}
                            </svg>
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="text-[11px] font-bold text-stone-100 truncate">
                              {wp.name}
                            </div>
                            <div className="text-[9px] text-stone-500 capitalize">
                              {wp.kind} stop
                            </div>
                          </div>
                          {onRemoveWaypoint && (
                            <button
                              type="button"
                              onClick={() => onRemoveWaypoint(wp.id)}
                              aria-label={`Remove stop ${wp.name}`}
                              data-testid={`map-route-panel-waypoint-remove-${wp.id}`}
                              className="w-6 h-6 rounded-full bg-stone-800/60 flex items-center justify-center text-stone-500 hover:text-red-400 hover:bg-red-900/20 transition-colors shrink-0"
                            >
                              <svg viewBox="0 0 24 24" className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth="2.5">
                                <line x1="18" y1="6" x2="6" y2="18" />
                                <line x1="6" y1="6" x2="18" y2="18" />
                              </svg>
                            </button>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                  {trails.map((trail, idx) => {
                    const diff = trail.difficulty ?? 5;
                    const diffColor = getDifficultyColor(diff);
                    return (
                      <div
                        key={trail.id}
                        className="flex items-center gap-1.5 bg-[hsl(22,15%,13%)] rounded-lg px-2 py-1.5 border border-[hsl(30,12%,18%)]"
                        data-testid={`map-route-panel-item-${idx}`}
                      >
                        <div
                          className="w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-black text-stone-900 shrink-0"
                          style={{ backgroundColor: diffColor }}
                        >
                          {idx + 1}
                        </div>
                        {onSelectTrail ? (
                          <button
                            type="button"
                            onClick={() => onSelectTrail(trail)}
                            className="flex-1 min-w-0 text-left hover:text-amber-300 transition-colors"
                            aria-label={`View details for ${trail.name}`}
                            data-testid={`map-route-panel-open-${idx}`}
                          >
                            <div className="text-[11px] font-bold text-stone-100 truncate">
                              {trail.name}
                            </div>
                            <div className="text-[9px] text-stone-500">
                              {trail.distance_km != null
                                ? `${toNum(trail.distance_km).toFixed(1)} km`
                                : "—"}
                              {trail.legal_status ? ` · ${trail.legal_status}` : ""}
                            </div>
                          </button>
                        ) : (
                          <div className="flex-1 min-w-0">
                            <div className="text-[11px] font-bold text-stone-100 truncate">
                              {trail.name}
                            </div>
                            <div className="text-[9px] text-stone-500">
                              {trail.distance_km != null
                                ? `${toNum(trail.distance_km).toFixed(1)} km`
                                : "—"}
                              {trail.legal_status ? ` · ${trail.legal_status}` : ""}
                            </div>
                          </div>
                        )}
                        <div className="flex flex-col gap-0">
                          <button
                            type="button"
                            onClick={() => moveUp(idx)}
                            disabled={idx === 0}
                            aria-label={`Move ${trail.name} up`}
                            data-testid={`map-route-panel-up-${idx}`}
                            className="w-5 h-4 rounded flex items-center justify-center text-stone-500 hover:text-stone-200 disabled:opacity-25 disabled:cursor-not-allowed transition-colors"
                          >
                            <svg viewBox="0 0 24 24" className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth="2.5">
                              <polyline points="18 15 12 9 6 15" />
                            </svg>
                          </button>
                          <button
                            type="button"
                            onClick={() => moveDown(idx)}
                            disabled={idx === trails.length - 1}
                            aria-label={`Move ${trail.name} down`}
                            data-testid={`map-route-panel-down-${idx}`}
                            className="w-5 h-4 rounded flex items-center justify-center text-stone-500 hover:text-stone-200 disabled:opacity-25 disabled:cursor-not-allowed transition-colors"
                          >
                            <svg viewBox="0 0 24 24" className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth="2.5">
                              <polyline points="6 9 12 15 18 9" />
                            </svg>
                          </button>
                        </div>
                        <button
                          type="button"
                          onClick={() => onRemove(trail.id)}
                          aria-label={`Remove ${trail.name}`}
                          data-testid={`map-route-panel-remove-${idx}`}
                          className="w-6 h-6 rounded-full bg-stone-800/60 flex items-center justify-center text-stone-500 hover:text-red-400 hover:bg-red-900/20 transition-colors shrink-0"
                        >
                          <svg viewBox="0 0 24 24" className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth="2.5">
                            <line x1="18" y1="6" x2="6" y2="18" />
                            <line x1="6" y1="6" x2="18" y2="18" />
                          </svg>
                        </button>
                      </div>
                    );
                  })}
                </>
              )}
            </div>

            {/* Action row */}
            <div className="grid grid-cols-[auto_1fr] gap-1.5 px-2 pb-2 pt-1">
              <button
                type="button"
                onClick={() => {
                  if (
                    trails.length > 1 &&
                    !window.confirm(
                      `Clear all ${trails.length} trails from your route?`,
                    )
                  )
                    return;
                  onClear();
                }}
                aria-label="Clear all trails from route"
                data-testid="map-route-panel-clear"
                className="w-9 h-9 rounded-lg flex items-center justify-center border border-stone-700 bg-stone-900/60 text-stone-400 hover:border-red-500/60 hover:text-red-400 hover:bg-red-900/20 transition-all"
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
                  <polyline points="3 6 5 6 21 6" />
                  <path d="M19 6l-1.5 14a2 2 0 0 1-2 1.8H8.5a2 2 0 0 1-2-1.8L5 6" />
                  <path d="M10 11v6M14 11v6" />
                  <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
                </svg>
              </button>
              <button
                type="button"
                onClick={onBuildRoute}
                data-testid="map-route-panel-build"
                className="py-2 rounded-lg text-[11px] font-black uppercase tracking-wider text-stone-900 shadow-lg shadow-amber-900/30 flex items-center justify-center gap-1.5"
                style={{
                  background:
                    "linear-gradient(135deg, #d4870c 0%, #f0a832 50%, #d4870c 100%)",
                }}
              >
                <svg
                  viewBox="0 0 24 24"
                  className="w-3.5 h-3.5"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.5"
                >
                  <polygon points="3 11 22 2 13 21 11 13 3 11" />
                </svg>
                Build Route
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default function MapRoutePanel(props: Props) {
  return (
    <PanelErrorBoundary>
      <MapRoutePanelInner {...props} />
    </PanelErrorBoundary>
  );
}
