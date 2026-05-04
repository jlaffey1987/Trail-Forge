import { useState, useEffect, useRef, useCallback } from "react";
import {
  parseGPX,
  buildCombinedGPX,
  downloadGPX,
  buildGoogleMapsUrl,
  buildAppleMapsUrl,
  buildWazeUrl,
  calcRouteDistanceKm,
  getTrailStart,
  type TrailRoute,
} from "@/lib/gpx";
import { fetchTrailGpxByIds, type Trail } from "@/lib/supabase";
import { haversineM } from "@/lib/routing";
import type { RouteEntry, RouteWaypoint } from "@/lib/routing";
import {
  RIDE_TYPES,
  RIDE_TYPE_LABEL,
  type RideType,
} from "@/lib/savedRoutes";

const DIFFICULTY_COLORS: Record<number, string> = {
  1: "#4ade80", 2: "#86efac", 3: "#a3e635", 4: "#bef264", 5: "#fbbf24",
  6: "#fb923c", 7: "#f97316", 8: "#ef4444", 9: "#dc2626", 10: "#7f1d1d",
};

const WAYPOINT_KIND_COLOR: Record<RouteWaypoint["kind"], string> = {
  fuel: "#3b82f6",
  campsite: "#22c55e",
  custom: "#f0a832",
};

function waypointGlyph(kind: RouteWaypoint["kind"]): string {
  if (kind === "fuel")
    return "M3 12V5a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v14H3v-7zM13 8h2a2 2 0 0 1 2 2v6a2 2 0 0 0 2 2 2 2 0 0 0 2-2v-6l-3-3";
  if (kind === "campsite") return "M3 20 12 4l9 16H3z M12 4v16";
  return "M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z";
}

function trailToRoute(trail: Trail): TrailRoute {
  return {
    id: trail.id,
    name: trail.name,
    waypoints: parseGPX(trail.gpx_data),
    distance_km: trail.distance_km,
    legal_status: trail.legal_status,
    difficulty: trail.difficulty,
  };
}

interface Props {
  selectedTrails: Trail[];
  onReorder: (trails: Trail[]) => void;
  onRemove: (id: string) => void;
  onClose: () => void;
  /**
   * Custom waypoints (fuel/campsite/custom) the rider has added to the
   * route. Rendered interleaved at the top of the list so they're easy
   * to scan and remove. The trail order/transit math is unchanged.
   */
  waypoints?: RouteWaypoint[];
  onRemoveWaypoint?: (waypointId: string) => void;
  /**
   * Interleaved trail+waypoint list in the rider's chosen order. When
   * provided, the builder renders entries inline so a fuel stop can sit
   * between trail 1 and trail 2 instead of in a separate panel above.
   * Falls back to the legacy "waypoints first, then trails" layout if
   * omitted.
   */
  entries?: RouteEntry[];
  /**
   * Replace the full ordered list — used when the rider drags a stop
   * into a new position. Receives the new entries array. Required to
   * enable the up/down reorder buttons on waypoint rows.
   */
  onReorderEntries?: (entries: RouteEntry[]) => void;
  /**
   * Persist the current route under a name. Receives the name and the
   * caller is expected to do the API write + refresh. Optional — when
   * omitted (e.g. signed-out caller) the Save button is hidden so we
   * don't tease a feature the user can't use without an account.
   * Returns "saved" / "limit" / "error" so the builder can surface
   * the right toast without owning the API call itself.
   */
  onSaveRoute?: (payload: {
    name: string;
    description: string | null;
    rideType: RideType | null;
    isPublic: boolean;
  }) => Promise<"saved" | "limit" | "error">;
  /**
   * The saved-route row currently loaded into the planner, if any. When
   * set, the builder offers an "Update <name>" affordance in addition
   * to the regular Save flow so the rider can persist edits back to
   * the same row instead of duplicating it.
   */
  activeLoadedRoute?: { id: string; name: string } | null;
  /**
   * Persist the current route over the active loaded saved-route row.
   * Invoked only when the rider taps "Update <name>" — the parent is
   * responsible for the API call and surfacing any toast. We only need
   * to know success vs not-found vs generic error so we can clear the
   * binding when the row no longer exists.
   */
  onUpdateRoute?: () => Promise<"saved" | "not-found" | "error">;
  /**
   * Human-readable Start / End labels framing the stop list. When
   * provided, the panel renders dedicated anchor rows at the top and
   * bottom of the list so the rider can see the full ordered trip
   * (start → trails/waypoints → end). Optional — when omitted the
   * builder falls back to the legacy stops-only layout.
   */
  startLabel?: string | null;
  endLabel?: string | null;
  /**
   * Commit a new entry order after a drag-reorder. When provided, this
   * wins over `onReorderEntries` for drag commits — the parent owns
   * snapshot+restore and any in-place re-routing of the assembled
   * trip. Returns `ok:false` to signal the previous order should stay
   * on screen (parent must restore the store before resolving). The
   * panel surfaces the parent-supplied error inline.
   */
  onCommitReorder?: (
    nextEntries: RouteEntry[],
    onProgress: (step: number, total: number, label: string) => void,
  ) => Promise<{ ok: true } | { ok: false; error: string }>;
  /**
   * Find candidate trails the rider could substitute the given trail
   * for. Reuses the same picker contract as the in-trip swap flow
   * (`NavigationView.onFetchSwapAlternates`). Returning `[]` means
   * "no alternates found" — the picker shows an empty-state.
   */
  onFetchSwapAlternates?: (trailId: string) => Promise<Trail[]>;
  /**
   * Substitute the given trail with the chosen alternate. Same
   * snapshot/restore contract as `onCommitReorder`: on `ok:false` the
   * planner store is left untouched and the previous trail stays in
   * the panel.
   */
  onCommitSwap?: (
    oldTrailId: string,
    newTrail: Trail,
    onProgress: (step: number, total: number, label: string) => void,
  ) => Promise<{ ok: true } | { ok: false; error: string }>;
  /**
   * Commit a trail removal from the My Route panel. Same recompute /
   * snapshot-restore contract as `onCommitReorder` and `onCommitSwap`:
   * when an assembled trip exists the parent re-runs the multi-modal
   * assembly with the trail filtered out and only persists the new
   * order on success. When omitted the legacy `onRemove` path is used
   * (direct store mutation, no re-routing).
   */
  onCommitRemoveTrail?: (
    trailId: string,
    onProgress: (step: number, total: number, label: string) => void,
  ) => Promise<{ ok: true } | { ok: false; error: string }>;
  /**
   * Commit a waypoint removal from the My Route panel. Same contract
   * as `onCommitRemoveTrail`. When omitted the legacy
   * `onRemoveWaypoint` path is used.
   */
  onCommitRemoveWaypoint?: (
    waypointId: string,
    onProgress: (step: number, total: number, label: string) => void,
  ) => Promise<{ ok: true } | { ok: false; error: string }>;
}

export default function RouteBuilder({
  selectedTrails,
  onReorder,
  onRemove,
  onClose,
  waypoints,
  onRemoveWaypoint,
  entries,
  onReorderEntries,
  onSaveRoute,
  activeLoadedRoute,
  onUpdateRoute,
  startLabel,
  endLabel,
  onCommitReorder,
  onFetchSwapAlternates,
  onCommitSwap,
  onCommitRemoveTrail,
  onCommitRemoveWaypoint,
}: Props) {
  const [downloading, setDownloading] = useState(false);
  const [gpxReady, setGpxReady] = useState(false);
  const [transitDistances, setTransitDistances] = useState<number[]>([]);
  // Save-route dialog state. Kept local so the parent doesn't need to
  // own a modal — the builder is already a full-screen sheet.
  const [showSaveDialog, setShowSaveDialog] = useState(false);
  const [saveName, setSaveName] = useState("");
  // Publish-flow extras: optional description, ride-type tag, and the
  // public toggle. We default `isPublic` to false so a careless tap on
  // "Save" never accidentally exposes a draft route to Discover.
  const [saveDescription, setSaveDescription] = useState("");
  const [saveRideType, setSaveRideType] = useState<RideType | "">("");
  const [saveIsPublic, setSaveIsPublic] = useState(false);
  const [savingRoute, setSavingRoute] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveToast, setSaveToast] = useState<string | null>(null);
  // "Update <name>" runs without a dialog — it just persists the
  // current route over the loaded row — so we only need a busy flag
  // to disable both Update and Save during the in-flight request.
  const [updatingRoute, setUpdatingRoute] = useState(false);
  // The Map tab no longer ships `gpx_data` with bbox responses, so trails
  // added to the planner from the map arrive without it. We hydrate the
  // missing GPX here on demand so the combined GPX export and the per-trail
  // start/end points used for transit math work correctly.
  const [hydratedTrails, setHydratedTrails] = useState<Trail[]>(selectedTrails);
  const [loadingGpx, setLoadingGpx] = useState(false);

  const routes = hydratedTrails.map(trailToRoute);
  const totalTrailKm = hydratedTrails.reduce((s, t) => s + (t.distance_km ?? 0), 0);
  const totalWithTransit = calcRouteDistanceKm(routes);
  const transitKm = totalWithTransit - totalTrailKm;

  useEffect(() => {
    setHydratedTrails(selectedTrails);
    const missing = Array.from(
      new Set(
        selectedTrails.filter((t) => t.gpx_data == null).map((t) => t.id),
      ),
    );
    if (missing.length === 0) {
      // Nothing to hydrate — make sure we don't leave the button stuck in
      // a "Loading…" state from a previous run that got cancelled.
      setLoadingGpx(false);
      return;
    }
    let cancelled = false;
    setLoadingGpx(true);
    void fetchTrailGpxByIds(missing).then((gpxMap) => {
      if (cancelled) return;
      setHydratedTrails((prev) =>
        prev.map((t) => {
          if (t.gpx_data != null) return t;
          const g = gpxMap.get(t.id);
          return g != null ? { ...t, gpx_data: g } : t;
        }),
      );
      setLoadingGpx(false);
    });
    return () => {
      // Mark this fetch cancelled. The next effect run is responsible for
      // resetting `loadingGpx` based on whether new hydration is needed,
      // which keeps the button state consistent with the latest selection.
      cancelled = true;
    };
  }, [selectedTrails]);

  useEffect(() => {
    const dists: number[] = [];
    for (let i = 0; i < routes.length - 1; i++) {
      const end = routes[i].waypoints[routes[i].waypoints.length - 1];
      const start = routes[i + 1].waypoints[0];
      if (end && start) {
        const R = 6371;
        const dLat = ((start.lat - end.lat) * Math.PI) / 180;
        const dLon = ((start.lon - end.lon) * Math.PI) / 180;
        const a = Math.sin(dLat / 2) ** 2 + Math.cos((end.lat * Math.PI) / 180) * Math.cos((start.lat * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
        dists.push(R * 2 * Math.asin(Math.sqrt(a)));
      } else {
        dists.push(0);
      }
    }
    setTransitDistances(dists);
    setGpxReady(
      hydratedTrails.length > 0 &&
        routes.every((r) => r.waypoints.length > 0),
    );
  }, [hydratedTrails]);

  const moveUp = (idx: number) => {
    if (idx === 0) return;
    const next = [...selectedTrails];
    [next[idx - 1], next[idx]] = [next[idx], next[idx - 1]];
    onReorder(next);
  };

  const moveDown = (idx: number) => {
    if (idx === selectedTrails.length - 1) return;
    const next = [...selectedTrails];
    [next[idx], next[idx + 1]] = [next[idx + 1], next[idx]];
    onReorder(next);
  };

  const handleDownloadGPX = () => {
    setDownloading(true);
    setTimeout(() => {
      const gpx = buildCombinedGPX(routes);
      const name = `TrailForge-Route-${new Date().toISOString().slice(0, 10)}.gpx`;
      downloadGPX(gpx, name);
      setDownloading(false);
    }, 300);
  };

  const handleGoogleMaps = () => {
    const url = buildGoogleMapsUrl(routes);
    window.open(url, "_blank");
  };

  const handleAppleMaps = () => {
    const url = buildAppleMapsUrl(routes);
    window.open(url, "_blank");
  };

  const handleWaze = () => {
    const url = buildWazeUrl(routes);
    window.open(url, "_blank");
  };

  const routeFilename = selectedTrails.map((t) => t.name.split(" ")[0]).join("-");

  // Auto-suggest a name from the first/last trail so the rider rarely
  // has to type — they can always override.
  const suggestedName = (() => {
    if (selectedTrails.length === 0) return "";
    if (selectedTrails.length === 1) return selectedTrails[0].name;
    const first = selectedTrails[0].name.split(" ")[0];
    const last = selectedTrails[selectedTrails.length - 1].name.split(" ")[0];
    return `${first} → ${last}`;
  })();

  const openSaveDialog = () => {
    setSaveName(suggestedName);
    setSaveDescription("");
    setSaveRideType("");
    setSaveIsPublic(false);
    setSaveError(null);
    setShowSaveDialog(true);
  };

  const handleConfirmSave = async () => {
    if (!onSaveRoute) return;
    const trimmed = saveName.trim();
    if (trimmed.length === 0) {
      setSaveError("Give your route a name");
      return;
    }
    if (saveIsPublic && !saveRideType) {
      // Discover relies on the ride-type filter to surface routes, so
      // a public route without one would be functionally invisible.
      setSaveError("Pick a ride type before publishing");
      return;
    }
    setSavingRoute(true);
    setSaveError(null);
    const descTrim = saveDescription.trim();
    const result = await onSaveRoute({
      name: trimmed,
      description: descTrim.length > 0 ? descTrim : null,
      rideType: saveRideType === "" ? null : saveRideType,
      isPublic: saveIsPublic,
    });
    setSavingRoute(false);
    if (result === "saved") {
      setShowSaveDialog(false);
      setSaveName("");
      setSaveDescription("");
      setSaveRideType("");
      setSaveIsPublic(false);
      setSaveToast(
        saveIsPublic
          ? `Published "${trimmed}" to Discover`
          : `Saved "${trimmed}" to My Trails`,
      );
    } else if (result === "limit") {
      setSaveError(
        "You've reached 50 saved routes. Delete one in My Trails to save a new one.",
      );
    } else {
      setSaveError("Couldn't save the route. Check your connection and try again.");
    }
  };

  const handleUpdateRoute = async () => {
    if (!onUpdateRoute || !activeLoadedRoute) return;
    setUpdatingRoute(true);
    const result = await onUpdateRoute();
    setUpdatingRoute(false);
    if (result === "saved") {
      setSaveToast(`Updated "${activeLoadedRoute.name}"`);
    } else if (result === "not-found") {
      // Row was deleted from another device — drop the binding so the
      // rider doesn't keep tapping Update on a ghost row, and tell them
      // why the operation didn't take.
      setSaveToast("That saved route no longer exists — use Save as new.");
    } else {
      setSaveToast("Couldn't update — check your connection and try again.");
    }
  };

  // Auto-dismiss the save toast after a couple of seconds.
  useEffect(() => {
    if (!saveToast) return;
    const t = window.setTimeout(() => setSaveToast(null), 2500);
    return () => window.clearTimeout(t);
  }, [saveToast]);

  // ---------------------------------------------------------------
  // Drag-to-reorder + per-trail swap state
  //
  // All state declared up front so the useCallback handlers below can
  // safely reference any of them (no temporal-dead-zone surprises).
  // ---------------------------------------------------------------
  const rowNodesRef = useRef<Map<number, HTMLElement>>(new Map());
  const setRowNode = useCallback((idx: number, el: HTMLElement | null) => {
    if (el) rowNodesRef.current.set(idx, el);
    else rowNodesRef.current.delete(idx);
  }, []);
  const [dragState, setDragState] = useState<{
    fromIdx: number;
    overIdx: number;
  } | null>(null);
  const dragStateRef = useRef(dragState);
  useEffect(() => {
    dragStateRef.current = dragState;
  }, [dragState]);

  const [reordering, setReordering] = useState<{
    progress: { pct: number; label: string };
  } | null>(null);
  const [reorderError, setReorderError] = useState<string | null>(null);

  const [swapPickerFor, setSwapPickerFor] = useState<{
    trailId: string;
    trailName: string;
  } | null>(null);
  const [swapAlternates, setSwapAlternates] = useState<Trail[] | null>(null);
  const [swapping, setSwapping] = useState<{
    trailName: string;
    newTrailName: string;
    progress: { pct: number; label: string };
  } | null>(null);
  const [swapError, setSwapError] = useState<string | null>(null);

  // Removal goes through the same recompute pipeline as reorder/swap
  // when a commit-style handler is supplied by the parent. We use a
  // dedicated busy state so the overlay copy can say "Removing X…"
  // and so the same arrowsBusy guard blocks all three actions while
  // any one is in flight.
  const [removing, setRemoving] = useState<{
    label: string;
    progress: { pct: number; label: string };
  } | null>(null);
  const [removeError, setRemoveError] = useState<string | null>(null);

  // Shared helper — runs a parent-supplied commit-style handler with
  // overlay/progress/error wiring identical to `commitReorder` /
  // swap. Used by the trail and waypoint remove buttons in the
  // entries-mode rows. Returns true on success so the caller can
  // chain UI cleanup if needed.
  const runRemoveCommit = useCallback(
    async (
      label: string,
      run: (
        onProgress: (step: number, total: number, label: string) => void,
      ) => Promise<{ ok: true } | { ok: false; error: string }>,
    ): Promise<boolean> => {
      setRemoveError(null);
      setRemoving({
        label,
        progress: { pct: 0, label: "Updating your route..." },
      });
      try {
        const result = await run((step, total, lbl) => {
          const pct = total > 0 ? Math.round((step / total) * 100) : 0;
          setRemoving((prev) =>
            prev ? { label: prev.label, progress: { pct, label: lbl } } : prev,
          );
        });
        if (!result.ok) {
          setRemoveError(result.error);
          return false;
        }
        return true;
      } catch {
        setRemoveError("Couldn't remove. Please try again.");
        return false;
      } finally {
        setRemoving(null);
      }
    },
    [],
  );

  const computeOverIdx = useCallback((clientY: number, fromIdx: number) => {
    let best = fromIdx;
    for (const [idx, el] of rowNodesRef.current.entries()) {
      const r = el.getBoundingClientRect();
      if (clientY >= r.top && clientY <= r.bottom) {
        best = idx;
        return best;
      }
    }
    // Pointer may be above the first row or below the last row — clamp.
    let topMost: { idx: number; top: number } | null = null;
    let bottomMost: { idx: number; bottom: number } | null = null;
    for (const [idx, el] of rowNodesRef.current.entries()) {
      const r = el.getBoundingClientRect();
      if (topMost === null || r.top < topMost.top) topMost = { idx, top: r.top };
      if (bottomMost === null || r.bottom > bottomMost.bottom)
        bottomMost = { idx, bottom: r.bottom };
    }
    if (topMost && clientY < topMost.top) return topMost.idx;
    if (bottomMost && clientY > bottomMost.bottom) return bottomMost.idx;
    return best;
  }, []);

  const handleDragPointerDown = useCallback(
    (idx: number, e: React.PointerEvent<HTMLButtonElement>) => {
      // Only the primary pointer (left mouse / first touch) starts a
      // drag. Right-clicks etc. fall through.
      if (e.button !== 0 && e.pointerType === "mouse") return;
      if (!entries || entries.length < 2) return;
      if (reordering || swapping || removing) return;
      e.preventDefault();
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        /* setPointerCapture can throw in some test envs */
      }
      setDragState({ fromIdx: idx, overIdx: idx });
    },
    [entries, reordering, swapping, removing],
  );

  const handleDragPointerMove = useCallback(
    (e: React.PointerEvent<HTMLButtonElement>) => {
      const cur = dragStateRef.current;
      if (!cur) return;
      const nextOver = computeOverIdx(e.clientY, cur.fromIdx);
      if (nextOver !== cur.overIdx) {
        setDragState({ fromIdx: cur.fromIdx, overIdx: nextOver });
      }
    },
    [computeOverIdx],
  );

  const commitReorder = useCallback(
    async (fromIdx: number, toIdx: number) => {
      if (!entries || fromIdx === toIdx) return;
      const next = entries.slice();
      const [moved] = next.splice(fromIdx, 1);
      next.splice(toIdx, 0, moved);
      setReorderError(null);
      if (onCommitReorder) {
        setReordering({ progress: { pct: 0, label: "Re-routing your trip..." } });
        try {
          const result = await onCommitReorder(next, (step, total, label) => {
            const pct = total > 0 ? Math.round((step / total) * 100) : 0;
            setReordering((prev) =>
              prev ? { progress: { pct, label } } : prev,
            );
          });
          if (!result.ok) setReorderError(result.error);
        } catch {
          setReorderError("Couldn't reorder. Please try again.");
        } finally {
          setReordering(null);
        }
      } else if (onReorderEntries) {
        onReorderEntries(next);
      }
    },
    [entries, onCommitReorder, onReorderEntries],
  );

  const handleDragPointerUp = useCallback(
    (e: React.PointerEvent<HTMLButtonElement>) => {
      const cur = dragStateRef.current;
      try {
        e.currentTarget.releasePointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
      setDragState(null);
      if (!cur) return;
      void commitReorder(cur.fromIdx, cur.overIdx);
    },
    [commitReorder],
  );

  const handleDragPointerCancel = useCallback(() => {
    setDragState(null);
  }, []);

  // Fetch alternates when the picker opens. Each open issues a fresh
  // request — `swapAlternates === null` means "loading", `[]` means
  // "loaded but no candidates".
  useEffect(() => {
    if (!swapPickerFor || !onFetchSwapAlternates) return;
    let cancelled = false;
    setSwapAlternates(null);
    void onFetchSwapAlternates(swapPickerFor.trailId).then((alts) => {
      if (cancelled) return;
      setSwapAlternates(alts);
    });
    return () => {
      cancelled = true;
    };
  }, [swapPickerFor, onFetchSwapAlternates]);

  const handleConfirmSwap = useCallback(
    async (newTrail: Trail) => {
      if (!swapPickerFor || !onCommitSwap) return;
      const { trailId, trailName } = swapPickerFor;
      setSwapPickerFor(null);
      setSwapAlternates(null);
      setSwapError(null);
      setSwapping({
        trailName,
        newTrailName: newTrail.name,
        progress: { pct: 0, label: "Re-routing your trip..." },
      });
      try {
        const result = await onCommitSwap(
          trailId,
          newTrail,
          (step, total, label) => {
            const pct = total > 0 ? Math.round((step / total) * 100) : 0;
            setSwapping((prev) =>
              prev ? { ...prev, progress: { pct, label } } : prev,
            );
          },
        );
        if (!result.ok) setSwapError(result.error);
      } catch {
        setSwapError("Couldn't swap. Please try again.");
      } finally {
        setSwapping(null);
      }
    },
    [swapPickerFor, onCommitSwap],
  );

  return (
    <div className="fixed inset-0 z-50 flex flex-col" style={{ background: "rgba(0,0,0,0.85)", backdropFilter: "blur(4px)" }}>
      <div
        className="flex flex-col mt-auto rounded-t-2xl overflow-hidden"
        style={{ background: "hsl(22,15%,9%)", maxHeight: "92vh" }}
      >
        {/* Handle bar */}
        <div className="flex justify-center pt-3 pb-1 shrink-0">
          <div className="w-10 h-1 rounded-full bg-stone-600"></div>
        </div>

        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-[hsl(30,12%,16%)] shrink-0">
          <div>
            <h2 className="text-base font-bold text-amber-400 uppercase tracking-widest">My Route</h2>
            <p className="text-xs text-stone-500 mt-0.5">
              {selectedTrails.length} trail{selectedTrails.length !== 1 ? "s" : ""} · {totalTrailKm.toFixed(1)} km riding
            </p>
          </div>
          <button
            onClick={onClose}
            className="w-8 h-8 rounded-full bg-stone-800 flex items-center justify-center text-stone-400 hover:text-stone-200 transition-colors"
          >
            <svg viewBox="0 0 24 24" className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        {/* Stats Row */}
        <div className="grid grid-cols-3 divide-x divide-[hsl(30,12%,16%)] border-b border-[hsl(30,12%,16%)] shrink-0">
          <div className="py-3 text-center">
            <div className="text-lg font-bold text-amber-400">{totalTrailKm.toFixed(1)}</div>
            <div className="text-[10px] text-stone-500 uppercase tracking-wider">Trail km</div>
          </div>
          <div className="py-3 text-center">
            <div className="text-lg font-bold text-stone-300">{transitKm > 0 ? `+${transitKm.toFixed(1)}` : "—"}</div>
            <div className="text-[10px] text-stone-500 uppercase tracking-wider">Transit km</div>
          </div>
          <div className="py-3 text-center">
            <div className="text-lg font-bold text-stone-300">{totalWithTransit.toFixed(1)}</div>
            <div className="text-[10px] text-stone-500 uppercase tracking-wider">Total km</div>
          </div>
        </div>

        {/* Trail Order List */}
        <div className="overflow-y-auto flex-1 px-4 py-3 space-y-2">
          {entries && entries.length > 0 ? (
            (() => {
              // Map trail.id → its position in selectedTrails so we can keep
              // showing the same "Trail #N" badge and start coords riders
              // are used to. Waypoints don't get a number — they're the
              // glue between trails.
              const trailIdxById = new Map<string, number>();
              selectedTrails.forEach((t, i) => trailIdxById.set(t.id, i));
              // The arrow fallback shares commitReorder with the drag
              // handle so it gets the same recompute / snapshot-restore
              // treatment when the parent has wired onCommitReorder.
              // Without this, an arrow tap on an already-planned trip
              // would mutate the store without re-running the
              // multi-modal assembly.
              const swapEntries = (a: number, b: number) => {
                if (a < 0 || b < 0 || a >= entries.length || b >= entries.length) return;
                if (a === b) return;
                void commitReorder(a, b);
              };
              const canReorder = !!(onReorderEntries || onCommitReorder);
              // Arrow buttons are disabled while a recompute is in
              // flight so the rider can't fire a second mutation
              // before the first one settles. Mirrors the drag-handle
              // guard in handleDragPointerDown.
              const arrowsBusy = !!reordering || !!swapping || !!removing;
              // Per-entry approximate coordinate, used for showing each
              // stop's straight-line leg distance from the previous stop.
              // Trail rows use the trail's GPX start when its parsed
              // route is available; otherwise leg distance is omitted.
              const entryCoord = (e: RouteEntry): { lat: number; lng: number } | null => {
                if (e.kind === "waypoint") return { lat: e.waypoint.lat, lng: e.waypoint.lng };
                const ti = trailIdxById.get(e.trail.id);
                if (ti == null) return null;
                const r = routes[ti];
                const s = r ? getTrailStart(r.waypoints) : null;
                return s ? { lat: s.lat, lng: s.lon } : null;
              };
              const rows = entries.map((entry, idx) => {
                const stopNum = idx + 1;
                const prevCoord = idx > 0 ? entryCoord(entries[idx - 1]) : null;
                const thisCoord = entryCoord(entry);
                const legKm =
                  prevCoord && thisCoord
                    ? haversineM(prevCoord, thisCoord) / 1000
                    : null;
                const isDragOver =
                  dragState != null && dragState.overIdx === idx && dragState.fromIdx !== idx;
                const isDragSource = dragState?.fromIdx === idx;
                const dragHandle = canReorder ? (
                  <button
                    type="button"
                    onPointerDown={(e) => handleDragPointerDown(idx, e)}
                    onPointerMove={handleDragPointerMove}
                    onPointerUp={handleDragPointerUp}
                    onPointerCancel={handleDragPointerCancel}
                    aria-label="Drag to reorder this stop"
                    data-testid={`route-builder-drag-handle-${idx}`}
                    className="w-7 h-9 rounded flex flex-col items-center justify-center text-stone-500 hover:text-amber-400 transition-colors touch-none cursor-grab active:cursor-grabbing"
                    style={{ touchAction: "none" }}
                  >
                    <svg viewBox="0 0 20 20" className="w-4 h-4" fill="currentColor" aria-hidden="true">
                      <circle cx="6" cy="5" r="1.4" />
                      <circle cx="14" cy="5" r="1.4" />
                      <circle cx="6" cy="10" r="1.4" />
                      <circle cx="14" cy="10" r="1.4" />
                      <circle cx="6" cy="15" r="1.4" />
                      <circle cx="14" cy="15" r="1.4" />
                    </svg>
                  </button>
                ) : null;
                if (entry.kind === "waypoint") {
                  const wp = entry.waypoint;
                  return (
                    <div
                      key={`wp-${wp.id}`}
                      ref={(el) => setRowNode(idx, el)}
                      data-testid={`route-builder-waypoint-${wp.id}`}
                      className={`flex items-center gap-2 bg-[hsl(22,15%,13%)] border rounded-lg px-2 py-2 transition-all ${
                        isDragOver
                          ? "border-amber-400/80 shadow-lg shadow-amber-900/30"
                          : isDragSource
                            ? "border-amber-500/60 opacity-60"
                            : "border-[hsl(30,12%,22%)]"
                      }`}
                    >
                      {dragHandle}
                      <div
                        className="w-7 h-7 rounded-full bg-stone-800 text-stone-100 flex items-center justify-center text-[11px] font-black shrink-0 border border-stone-600"
                        aria-label={`Stop ${stopNum}`}
                      >
                        {stopNum}
                      </div>
                      <div
                        className="w-6 h-6 rounded-full flex items-center justify-center shrink-0"
                        style={{
                          background: WAYPOINT_KIND_COLOR[wp.kind],
                          border: "2px solid #f0a832",
                        }}
                      >
                        <svg
                          viewBox="0 0 24 24"
                          width="11"
                          height="11"
                          fill="none"
                          stroke="#fff"
                          strokeWidth="2.4"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        >
                          <path d={waypointGlyph(wp.kind)} />
                        </svg>
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="text-xs font-semibold text-stone-100 truncate">
                          {wp.name}
                        </div>
                        <div className="text-[10px] text-stone-500 capitalize">
                          {wp.kind} stop
                          {legKm != null && (
                            <>
                              {" "}· <span className="text-stone-400">{legKm.toFixed(1)} km from prev</span>
                            </>
                          )}
                        </div>
                      </div>
                      {canReorder && (
                        <div className="flex flex-col gap-0.5">
                          <button
                            type="button"
                            onClick={() => swapEntries(idx, idx - 1)}
                            disabled={idx === 0 || arrowsBusy}
                            aria-label={`Move stop ${wp.name} up`}
                            data-testid={`route-builder-waypoint-up-${wp.id}`}
                            className="w-6 h-6 rounded flex items-center justify-center text-stone-500 hover:text-stone-300 disabled:opacity-25 disabled:cursor-not-allowed transition-colors"
                          >
                            <svg viewBox="0 0 24 24" className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2.5">
                              <polyline points="18 15 12 9 6 15" />
                            </svg>
                          </button>
                          <button
                            type="button"
                            onClick={() => swapEntries(idx, idx + 1)}
                            disabled={idx === entries.length - 1 || arrowsBusy}
                            aria-label={`Move stop ${wp.name} down`}
                            data-testid={`route-builder-waypoint-down-${wp.id}`}
                            className="w-6 h-6 rounded flex items-center justify-center text-stone-500 hover:text-stone-300 disabled:opacity-25 disabled:cursor-not-allowed transition-colors"
                          >
                            <svg viewBox="0 0 24 24" className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2.5">
                              <polyline points="6 9 12 15 18 9" />
                            </svg>
                          </button>
                        </div>
                      )}
                      {(onRemoveWaypoint || onCommitRemoveWaypoint) && (
                        <button
                          type="button"
                          onClick={() => {
                            if (onCommitRemoveWaypoint) {
                              void runRemoveCommit(wp.name, (onProgress) =>
                                onCommitRemoveWaypoint(wp.id, onProgress),
                              );
                            } else if (onRemoveWaypoint) {
                              onRemoveWaypoint(wp.id);
                            }
                          }}
                          disabled={arrowsBusy}
                          aria-label={`Remove stop ${wp.name}`}
                          data-testid={`route-builder-waypoint-remove-${wp.id}`}
                          className="w-7 h-7 rounded-full bg-stone-800/60 flex items-center justify-center text-stone-500 hover:text-red-400 hover:bg-red-900/20 transition-colors shrink-0 disabled:opacity-40 disabled:cursor-not-allowed"
                        >
                          <svg
                            viewBox="0 0 24 24"
                            className="w-3.5 h-3.5"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                          >
                            <line x1="18" y1="6" x2="6" y2="18" />
                            <line x1="6" y1="6" x2="18" y2="18" />
                          </svg>
                        </button>
                      )}
                    </div>
                  );
                }
                // Trail entry — re-use the existing card layout but route
                // the up/down arrows through the entries reorder handler
                // when present so a trail can swap with an adjacent stop.
                const trail = entry.trail;
                const tIdx = trailIdxById.get(trail.id) ?? 0;
                const diff = trail.difficulty ?? 5;
                const route = routes[tIdx];
                const start = route ? getTrailStart(route.waypoints) : null;
                const transitDist = transitDistances[tIdx];
                const moveTrailUp = () => {
                  if (canReorder) {
                    swapEntries(idx, idx - 1);
                  } else {
                    moveUp(tIdx);
                  }
                };
                const moveTrailDown = () => {
                  if (canReorder) {
                    swapEntries(idx, idx + 1);
                  } else {
                    moveDown(tIdx);
                  }
                };
                const isFirst = idx === 0;
                const isLast = idx === entries.length - 1;
                // The "Navigate between trails" connector should only
                // appear when the very next entry is also a trail —
                // a waypoint stop is its own visible step in the chain.
                const nextEntry = entries[idx + 1];
                const showTransit =
                  nextEntry?.kind === "trail" && transitDist != null;
                return (
                  <div key={`trail-${trail.id}`} ref={(el) => setRowNode(idx, el)}>
                    <div
                      className={`bg-[hsl(22,15%,13%)] border rounded-xl overflow-hidden transition-all ${
                        isDragOver
                          ? "border-amber-400/80 shadow-lg shadow-amber-900/30"
                          : isDragSource
                            ? "border-amber-500/60 opacity-60"
                            : "border-[hsl(30,12%,22%)]"
                      }`}
                    >
                      <div className="flex items-center gap-2 p-3">
                        {dragHandle}
                        <div
                          className="w-7 h-7 rounded-full bg-amber-500 text-stone-900 flex items-center justify-center text-xs font-black shrink-0"
                          aria-label={`Stop ${stopNum}`}
                        >
                          {stopNum}
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-1.5 mb-0.5">
                            <span
                              className="w-4 h-4 rounded text-[10px] font-bold text-black flex items-center justify-center shrink-0"
                              style={{ backgroundColor: DIFFICULTY_COLORS[diff] ?? "#fbbf24" }}
                            >
                              {diff}
                            </span>
                            <span className="text-sm font-bold text-stone-100 truncate">{trail.name}</span>
                          </div>
                          <div className="flex items-center gap-1.5 flex-wrap">
                            <span className="text-[10px] text-stone-500">{trail.distance_km?.toFixed(1)} km</span>
                            <span className="text-stone-700">·</span>
                            <span className={`text-[10px] ${trail.legal_status === "BOAT" ? "text-amber-400" : "text-green-400"}`}>
                              {trail.legal_status}
                            </span>
                            {legKm != null && (
                              <>
                                <span className="text-stone-700">·</span>
                                <span className="text-[10px] text-stone-400">
                                  {legKm.toFixed(1)} km from prev
                                </span>
                              </>
                            )}
                          </div>
                        </div>
                        <div className="flex flex-col gap-0.5">
                          <button
                            onClick={moveTrailUp}
                            disabled={isFirst || arrowsBusy}
                            aria-label={`Move ${trail.name} earlier`}
                            data-testid={`route-builder-trail-up-${trail.id}`}
                            className="w-6 h-6 rounded flex items-center justify-center text-stone-500 hover:text-stone-300 disabled:opacity-25 disabled:cursor-not-allowed transition-colors"
                          >
                            <svg viewBox="0 0 24 24" className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2.5">
                              <polyline points="18 15 12 9 6 15" />
                            </svg>
                          </button>
                          <button
                            onClick={moveTrailDown}
                            disabled={isLast || arrowsBusy}
                            aria-label={`Move ${trail.name} later`}
                            data-testid={`route-builder-trail-down-${trail.id}`}
                            className="w-6 h-6 rounded flex items-center justify-center text-stone-500 hover:text-stone-300 disabled:opacity-25 disabled:cursor-not-allowed transition-colors"
                          >
                            <svg viewBox="0 0 24 24" className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2.5">
                              <polyline points="6 9 12 15 18 9" />
                            </svg>
                          </button>
                        </div>
                        {onCommitSwap && onFetchSwapAlternates && (
                          <button
                            type="button"
                            onClick={() =>
                              setSwapPickerFor({ trailId: trail.id, trailName: trail.name })
                            }
                            disabled={!!reordering || !!swapping}
                            aria-label={`Swap ${trail.name} for another trail`}
                            data-testid={`route-builder-trail-swap-${trail.id}`}
                            title="Swap for another trail"
                            className="w-7 h-7 rounded-full bg-stone-800/60 flex items-center justify-center text-stone-500 hover:text-amber-400 hover:bg-amber-900/20 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                          >
                            <svg viewBox="0 0 24 24" className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2">
                              <polyline points="17 1 21 5 17 9" />
                              <path d="M3 11V9a4 4 0 0 1 4-4h14" />
                              <polyline points="7 23 3 19 7 15" />
                              <path d="M21 13v2a4 4 0 0 1-4 4H3" />
                            </svg>
                          </button>
                        )}
                        <button
                          onClick={() => {
                            if (onCommitRemoveTrail) {
                              void runRemoveCommit(trail.name, (onProgress) =>
                                onCommitRemoveTrail(trail.id, onProgress),
                              );
                            } else {
                              onRemove(trail.id);
                            }
                          }}
                          disabled={arrowsBusy}
                          aria-label={`Remove ${trail.name}`}
                          data-testid={`route-builder-trail-remove-${trail.id}`}
                          className="w-7 h-7 rounded-full bg-stone-800/60 flex items-center justify-center text-stone-600 hover:text-red-400 hover:bg-red-900/20 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                        >
                          <svg viewBox="0 0 24 24" className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2">
                            <line x1="18" y1="6" x2="6" y2="18" />
                            <line x1="6" y1="6" x2="18" y2="18" />
                          </svg>
                        </button>
                      </div>
                    </div>
                    {showTransit && (
                      <div className="flex items-center gap-2 py-1.5 px-3">
                        <div className="flex flex-col items-center gap-0.5">
                          <div className="w-px h-2 bg-stone-700"></div>
                          <div className="w-px h-2 bg-stone-700"></div>
                        </div>
                        <div className="flex items-center gap-1.5 bg-[hsl(22,15%,12%)] border border-[hsl(30,12%,17%)] rounded-lg px-3 py-1.5 flex-1">
                          <svg viewBox="0 0 24 24" className="w-3.5 h-3.5 text-blue-400 shrink-0" fill="none" stroke="currentColor" strokeWidth="2">
                            <path d="M3 12h18M13 6l6 6-6 6"/>
                          </svg>
                          <span className="text-[10px] text-stone-400">
                            Navigate between trails
                            {transitDist > 0 && (
                              <span className="text-blue-400 ml-1">~{transitDist.toFixed(1)} km road</span>
                            )}
                          </span>
                          <span className="ml-auto text-[10px] text-stone-600">via GPS nav</span>
                        </div>
                      </div>
                    )}
                  </div>
                );
              });
              // Frame the rows with Start / End anchors when the parent
              // tells us where the trip begins and ends. These are pure
              // visual anchors — they're not draggable, swappable, or
              // removable, just a reminder of the bookends.
              return (
                <>
                  {startLabel && (
                    <div
                      data-testid="route-builder-start-anchor"
                      className="flex items-center gap-2 bg-[hsl(22,15%,11%)] border border-amber-500/30 rounded-lg px-2 py-2"
                    >
                      <div
                        className="w-7 h-7 rounded-full flex items-center justify-center shrink-0 bg-amber-500/20 border-2 border-amber-500"
                        aria-hidden="true"
                      >
                        <svg viewBox="0 0 24 24" className="w-3.5 h-3.5 text-amber-400" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                          <circle cx="12" cy="10" r="3" />
                          <path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7z" />
                        </svg>
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="text-[10px] font-bold uppercase tracking-wider text-amber-400">Start</div>
                        <div className="text-xs text-stone-200 truncate">{startLabel}</div>
                      </div>
                    </div>
                  )}
                  {rows}
                  {endLabel && (
                    <div
                      data-testid="route-builder-end-anchor"
                      className="flex items-center gap-2 bg-[hsl(22,15%,11%)] border border-amber-500/30 rounded-lg px-2 py-2"
                    >
                      <div
                        className="w-7 h-7 rounded-full flex items-center justify-center shrink-0 bg-amber-500/20 border-2 border-amber-500"
                        aria-hidden="true"
                      >
                        <svg viewBox="0 0 24 24" className="w-3.5 h-3.5 text-amber-400" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M4 21V4a1 1 0 0 1 1-1h12l-2 4 2 4H6" />
                        </svg>
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="text-[10px] font-bold uppercase tracking-wider text-amber-400">End</div>
                        <div className="text-xs text-stone-200 truncate">{endLabel}</div>
                      </div>
                    </div>
                  )}
                  {(reorderError || swapError || removeError) && (
                    <div
                      data-testid="route-builder-reorder-error"
                      className="bg-red-900/30 border border-red-600/50 rounded-lg px-3 py-2 flex items-start gap-2"
                    >
                      <svg viewBox="0 0 24 24" className="w-4 h-4 text-red-400 shrink-0 mt-0.5" fill="none" stroke="currentColor" strokeWidth="2">
                        <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
                      </svg>
                      <p className="text-[11px] text-red-200 leading-tight flex-1">{reorderError ?? swapError ?? removeError}</p>
                      <button
                        type="button"
                        onClick={() => {
                          setReorderError(null);
                          setSwapError(null);
                          setRemoveError(null);
                        }}
                        aria-label="Dismiss error"
                        className="text-red-400 ml-1"
                      >
                        ×
                      </button>
                    </div>
                  )}
                </>
              );
            })()
          ) : (
            <>
          {waypoints && waypoints.length > 0 && (
            <div className="space-y-1.5 pb-2 border-b border-[hsl(30,12%,16%)] mb-2">
              <p className="text-[10px] uppercase tracking-wider text-stone-500 font-bold pb-0.5">
                Stops along route ({waypoints.length})
              </p>
              {waypoints.map((wp) => (
                <div
                  key={wp.id}
                  data-testid={`route-builder-waypoint-${wp.id}`}
                  className="flex items-center gap-2 bg-[hsl(22,15%,13%)] border border-[hsl(30,12%,22%)] rounded-lg px-2 py-2"
                >
                  <div
                    className="w-7 h-7 rounded-full flex items-center justify-center shrink-0"
                    style={{
                      background: WAYPOINT_KIND_COLOR[wp.kind],
                      border: "2px solid #f0a832",
                    }}
                  >
                    <svg
                      viewBox="0 0 24 24"
                      width="13"
                      height="13"
                      fill="none"
                      stroke="#fff"
                      strokeWidth="2.4"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d={waypointGlyph(wp.kind)} />
                    </svg>
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-xs font-semibold text-stone-100 truncate">
                      {wp.name}
                    </div>
                    <div className="text-[10px] text-stone-500 capitalize">
                      {wp.kind} stop · {wp.lat.toFixed(4)},{" "}
                      {wp.lng.toFixed(4)}
                    </div>
                  </div>
                  {onRemoveWaypoint && (
                    <button
                      type="button"
                      onClick={() => onRemoveWaypoint(wp.id)}
                      aria-label={`Remove stop ${wp.name}`}
                      data-testid={`route-builder-waypoint-remove-${wp.id}`}
                      className="w-7 h-7 rounded-full bg-stone-800/60 flex items-center justify-center text-stone-500 hover:text-red-400 hover:bg-red-900/20 transition-colors shrink-0"
                    >
                      <svg
                        viewBox="0 0 24 24"
                        className="w-3.5 h-3.5"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                      >
                        <line x1="18" y1="6" x2="6" y2="18" />
                        <line x1="6" y1="6" x2="18" y2="18" />
                      </svg>
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
          {selectedTrails.map((trail, idx) => {
            const diff = trail.difficulty ?? 5;
            const route = routes[idx];
            const start = getTrailStart(route.waypoints);
            const transitDist = transitDistances[idx];

            return (
              <div key={trail.id}>
                {/* Trail Card */}
                <div className="bg-[hsl(22,15%,13%)] border border-[hsl(30,12%,22%)] rounded-xl overflow-hidden">
                  <div className="flex items-center gap-2 p-3">
                    {/* Order Badge */}
                    <div className="w-7 h-7 rounded-full bg-amber-500 text-stone-900 flex items-center justify-center text-xs font-black shrink-0">
                      {idx + 1}
                    </div>

                    {/* Trail Info */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5 mb-0.5">
                        <span
                          className="w-4 h-4 rounded text-[10px] font-bold text-black flex items-center justify-center shrink-0"
                          style={{ backgroundColor: DIFFICULTY_COLORS[diff] ?? "#fbbf24" }}
                        >
                          {diff}
                        </span>
                        <span className="text-sm font-bold text-stone-100 truncate">{trail.name}</span>
                      </div>
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <span className="text-[10px] text-stone-500">{trail.distance_km?.toFixed(1)} km</span>
                        <span className="text-stone-700">·</span>
                        <span className={`text-[10px] ${trail.legal_status === "BOAT" ? "text-amber-400" : "text-green-400"}`}>
                          {trail.legal_status}
                        </span>
                        {start && (
                          <>
                            <span className="text-stone-700">·</span>
                            <span className="text-[10px] text-stone-600">
                              {start.lat.toFixed(4)}, {start.lon.toFixed(4)}
                            </span>
                          </>
                        )}
                      </div>
                    </div>

                    {/* Controls */}
                    <div className="flex flex-col gap-0.5">
                      <button
                        onClick={() => moveUp(idx)}
                        disabled={idx === 0}
                        className="w-6 h-6 rounded flex items-center justify-center text-stone-500 hover:text-stone-300 disabled:opacity-25 disabled:cursor-not-allowed transition-colors"
                      >
                        <svg viewBox="0 0 24 24" className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2.5">
                          <polyline points="18 15 12 9 6 15" />
                        </svg>
                      </button>
                      <button
                        onClick={() => moveDown(idx)}
                        disabled={idx === selectedTrails.length - 1}
                        className="w-6 h-6 rounded flex items-center justify-center text-stone-500 hover:text-stone-300 disabled:opacity-25 disabled:cursor-not-allowed transition-colors"
                      >
                        <svg viewBox="0 0 24 24" className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2.5">
                          <polyline points="6 9 12 15 18 9" />
                        </svg>
                      </button>
                    </div>
                    <button
                      onClick={() => onRemove(trail.id)}
                      className="w-7 h-7 rounded-full bg-stone-800/60 flex items-center justify-center text-stone-600 hover:text-red-400 hover:bg-red-900/20 transition-colors"
                    >
                      <svg viewBox="0 0 24 24" className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2">
                        <line x1="18" y1="6" x2="6" y2="18" />
                        <line x1="6" y1="6" x2="18" y2="18" />
                      </svg>
                    </button>
                  </div>
                </div>

                {/* Transit Connector */}
                {idx < selectedTrails.length - 1 && (
                  <div className="flex items-center gap-2 py-1.5 px-3">
                    <div className="flex flex-col items-center gap-0.5">
                      <div className="w-px h-2 bg-stone-700"></div>
                      <div className="w-px h-2 bg-stone-700"></div>
                    </div>
                    <div className="flex items-center gap-1.5 bg-[hsl(22,15%,12%)] border border-[hsl(30,12%,17%)] rounded-lg px-3 py-1.5 flex-1">
                      <svg viewBox="0 0 24 24" className="w-3.5 h-3.5 text-blue-400 shrink-0" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M3 12h18M13 6l6 6-6 6"/>
                      </svg>
                      <span className="text-[10px] text-stone-400">
                        Navigate between trails
                        {transitDist > 0 && (
                          <span className="text-blue-400 ml-1">~{transitDist.toFixed(1)} km road</span>
                        )}
                      </span>
                      <span className="ml-auto text-[10px] text-stone-600">via GPS nav</span>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
            </>
          )}
        </div>

        {/* Action Buttons */}
        <div className="px-4 pb-6 pt-3 space-y-2 border-t border-[hsl(30,12%,16%)] shrink-0">
          {/* Save route — only shown when the parent wired a handler
              (i.e. the rider is signed in). Disabled until at least one
              trail is in the route. */}
          {onSaveRoute && activeLoadedRoute && onUpdateRoute && (
            <>
              {/* Primary update — overwrite the loaded row. */}
              <button
                type="button"
                onClick={() => void handleUpdateRoute()}
                disabled={selectedTrails.length === 0 || updatingRoute || savingRoute}
                data-testid="route-builder-update-route"
                className="w-full py-2.5 rounded-xl text-xs font-bold uppercase tracking-widest transition-all flex items-center justify-center gap-2 disabled:opacity-40 disabled:cursor-not-allowed"
                style={{
                  background:
                    selectedTrails.length === 0 || updatingRoute || savingRoute
                      ? "hsl(22,15%,16%)"
                      : "linear-gradient(135deg, #d4870c 0%, #f0a832 50%, #d4870c 100%)",
                  color:
                    selectedTrails.length === 0 || updatingRoute || savingRoute
                      ? "#6b7280"
                      : "#1a0e05",
                }}
              >
                {updatingRoute ? (
                  <>
                    <span className="w-3.5 h-3.5 border-2 border-stone-900/40 border-t-stone-900 rounded-full animate-spin"></span>
                    Updating…
                  </>
                ) : (
                  <>
                    <svg viewBox="0 0 24 24" className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2.4">
                      <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/>
                      <polyline points="17 21 17 13 7 13 7 21"/>
                    </svg>
                    Update "{activeLoadedRoute.name.length > 22 ? `${activeLoadedRoute.name.slice(0, 22)}…` : activeLoadedRoute.name}"
                  </>
                )}
              </button>
              {/* Secondary — open the regular dialog to create a new row. */}
              <button
                type="button"
                onClick={openSaveDialog}
                disabled={selectedTrails.length === 0 || updatingRoute || savingRoute}
                data-testid="route-builder-save-as-new"
                className="w-full py-2 rounded-xl text-[11px] font-bold uppercase tracking-widest border border-amber-500/30 text-amber-300/90 bg-transparent hover:bg-amber-500/10 transition-all flex items-center justify-center gap-2 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                Save as new…
              </button>
            </>
          )}
          {onSaveRoute && !(activeLoadedRoute && onUpdateRoute) && (
            <button
              type="button"
              onClick={openSaveDialog}
              disabled={selectedTrails.length === 0}
              data-testid="route-builder-save-route"
              className="w-full py-2.5 rounded-xl text-xs font-bold uppercase tracking-widest border transition-all flex items-center justify-center gap-2 border-amber-500/40 text-amber-300 bg-amber-500/5 hover:bg-amber-500/10 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <svg viewBox="0 0 24 24" className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2.4">
                <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/>
                <polyline points="17 21 17 13 7 13 7 21"/>
                <polyline points="7 3 7 8 15 8"/>
              </svg>
              Save Route to My Trails
            </button>
          )}

          {/* Download GPX */}
          <button
            onClick={handleDownloadGPX}
            disabled={downloading || loadingGpx || !gpxReady}
            className="w-full py-3.5 rounded-xl font-bold text-sm uppercase tracking-widest transition-all flex items-center justify-center gap-2"
            style={{ background: gpxReady && !loadingGpx ? "linear-gradient(135deg, #d4870c 0%, #f0a832 50%, #d4870c 100%)" : "hsl(22,15%,16%)", color: gpxReady && !loadingGpx ? "#1a0e05" : "#6b7280" }}
          >
            {downloading ? (
              <>
                <span className="w-4 h-4 border-2 border-stone-900/50 border-t-stone-900 rounded-full animate-spin"></span>
                Generating GPX...
              </>
            ) : loadingGpx ? (
              <>
                <span className="w-4 h-4 border-2 border-stone-500/40 border-t-stone-300 rounded-full animate-spin"></span>
                Loading trail data...
              </>
            ) : (
              <>
                <svg viewBox="0 0 24 24" className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                  <polyline points="7 10 12 15 17 10"/>
                  <line x1="12" y1="15" x2="12" y2="3"/>
                </svg>
                Download Combined GPX
              </>
            )}
          </button>

          {!gpxReady && !loadingGpx && (
            <p className="text-[10px] text-stone-600 text-center">GPX data unavailable for some trails</p>
          )}

          {/* Navigation Apps */}
          <div className="grid grid-cols-3 gap-2">
            <button
              onClick={handleGoogleMaps}
              className="py-3 rounded-xl text-xs font-semibold border border-[hsl(30,12%,22%)] bg-[hsl(22,15%,13%)] text-stone-300 hover:border-blue-500/40 hover:text-blue-300 transition-all flex flex-col items-center gap-1"
            >
              <svg viewBox="0 0 24 24" className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7z"/>
                <circle cx="12" cy="9" r="2.5"/>
              </svg>
              Google Maps
            </button>
            <button
              onClick={handleAppleMaps}
              className="py-3 rounded-xl text-xs font-semibold border border-[hsl(30,12%,22%)] bg-[hsl(22,15%,13%)] text-stone-300 hover:border-stone-400/40 hover:text-stone-200 transition-all flex flex-col items-center gap-1"
            >
              <svg viewBox="0 0 24 24" className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M12 2a10 10 0 1 0 10 10A10 10 0 0 0 12 2z"/>
                <path d="M12 8v4l3 3"/>
              </svg>
              Apple Maps
            </button>
            <button
              onClick={handleWaze}
              className="py-3 rounded-xl text-xs font-semibold border border-[hsl(30,12%,22%)] bg-[hsl(22,15%,13%)] text-stone-300 hover:border-purple-500/40 hover:text-purple-300 transition-all flex flex-col items-center gap-1"
            >
              <svg viewBox="0 0 24 24" className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="1.5">
                <circle cx="12" cy="10" r="7"/>
                <path d="M9.5 10a1 1 0 1 0 2 0 1 1 0 0 0-2 0M13.5 10a1 1 0 1 0 2 0 1 1 0 0 0-2 0M9 13.5s1 2 3 2 3-2 3-2"/>
                <path d="M12 17v4M8 21h8"/>
              </svg>
              Waze
            </button>
          </div>

          <p className="text-[10px] text-stone-600 text-center">
            Navigation routes between trail start points · Trails linked in order above
          </p>
        </div>
      </div>

      {/* Save-route dialog — sits above the builder sheet. Plain controlled
          input so it works inside the iOS standalone PWA where window.prompt
          is suppressed. */}
      {showSaveDialog && (
        <div
          className="fixed inset-0 z-[2700] flex items-center justify-center px-4"
          style={{ background: "rgba(0,0,0,0.85)" }}
          role="dialog"
          aria-modal="true"
          data-testid="save-route-dialog"
        >
          <div className="w-full max-w-sm bg-[hsl(22,15%,12%)] border border-[hsl(30,12%,22%)] rounded-2xl p-5">
            <h3 className="text-sm font-bold text-amber-400 uppercase tracking-widest mb-1">
              Save Route
            </h3>
            <p className="text-xs text-stone-400 mb-3">
              {selectedTrails.length} trail{selectedTrails.length !== 1 ? "s" : ""} · {totalTrailKm.toFixed(1)} km
            </p>
            <label className="block text-[11px] uppercase tracking-wider text-stone-500 font-bold mb-1">
              Route name
            </label>
            <input
              type="text"
              value={saveName}
              onChange={(e) => {
                setSaveName(e.target.value);
                if (saveError) setSaveError(null);
              }}
              maxLength={120}
              placeholder="e.g. Welsh Weekend Loop"
              autoFocus
              data-testid="save-route-name-input"
              className="w-full px-3 py-2.5 rounded-lg bg-[hsl(22,15%,9%)] border border-[hsl(30,12%,22%)] text-stone-100 text-sm placeholder-stone-600 focus:outline-none focus:border-amber-500/60"
            />

            <label className="block text-[11px] uppercase tracking-wider text-stone-500 font-bold mt-3 mb-1">
              Description (optional)
            </label>
            <textarea
              value={saveDescription}
              onChange={(e) => setSaveDescription(e.target.value)}
              rows={2}
              maxLength={2000}
              placeholder="What's this route like?"
              data-testid="save-route-description-input"
              className="w-full px-3 py-2 rounded-lg bg-[hsl(22,15%,9%)] border border-[hsl(30,12%,22%)] text-stone-100 text-xs placeholder-stone-600 focus:outline-none focus:border-amber-500/60 resize-none"
            />

            <label className="block text-[11px] uppercase tracking-wider text-stone-500 font-bold mt-3 mb-1">
              Ride type
            </label>
            <div className="flex flex-wrap gap-1.5" data-testid="save-route-ride-type">
              {RIDE_TYPES.map((rt) => {
                const active = saveRideType === rt;
                return (
                  <button
                    key={rt}
                    type="button"
                    onClick={() => setSaveRideType(active ? "" : rt)}
                    data-testid={`save-route-ride-type-${rt}`}
                    className={`px-2.5 py-1 rounded-full text-[11px] font-semibold border transition-colors ${
                      active
                        ? "bg-amber-500 text-stone-900 border-amber-500"
                        : "text-stone-300 border-stone-700 bg-[hsl(22,15%,9%)] hover:border-amber-500/50"
                    }`}
                  >
                    {RIDE_TYPE_LABEL[rt]}
                  </button>
                );
              })}
            </div>

            <label className="flex items-start gap-2 mt-4 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={saveIsPublic}
                onChange={(e) => setSaveIsPublic(e.target.checked)}
                data-testid="save-route-public-toggle"
                className="mt-0.5 w-4 h-4 accent-amber-500"
              />
              <span className="text-[12px] text-stone-200 leading-snug">
                <span className="font-semibold">Publish to Discover</span>
                <span className="block text-[11px] text-stone-500 mt-0.5">
                  Other riders can view, like, comment, and "Follow this route" in the planner.
                </span>
              </span>
            </label>

            {saveError && (
              <p
                className="text-[11px] text-red-400 mt-2"
                data-testid="save-route-error"
              >
                {saveError}
              </p>
            )}
            <div className="flex gap-2 mt-4">
              <button
                type="button"
                onClick={() => {
                  setShowSaveDialog(false);
                  setSaveError(null);
                }}
                disabled={savingRoute}
                className="flex-1 py-2.5 rounded-lg text-xs font-bold uppercase tracking-wider text-stone-300 border border-stone-700 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void handleConfirmSave()}
                disabled={savingRoute || saveName.trim().length === 0}
                data-testid="save-route-confirm"
                className="flex-1 py-2.5 rounded-lg text-xs font-bold uppercase tracking-wider text-stone-900 disabled:opacity-50"
                style={{
                  background:
                    savingRoute || saveName.trim().length === 0
                      ? "hsl(22,15%,16%)"
                      : "linear-gradient(135deg, #d4870c 0%, #f0a832 50%, #d4870c 100%)",
                  color:
                    savingRoute || saveName.trim().length === 0
                      ? "#6b7280"
                      : "#1a0e05",
                }}
              >
                {savingRoute ? "Saving…" : "Save"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Success toast */}
      {saveToast && (
        <div
          className="fixed bottom-24 left-1/2 -translate-x-1/2 z-[2800] bg-[hsl(22,15%,14%)] border border-amber-500/40 text-amber-300 text-xs font-bold px-4 py-2 rounded-full shadow-lg"
          data-testid="route-builder-toast"
        >
          {saveToast}
        </div>
      )}

      {/* Reorder / swap progress overlay — covers the sheet so the
          rider can't fire a second mutation while we're rebuilding the
          assembled trip. Shares the same look as the planner-tab plan
          progress block. */}
      {(reordering || swapping || removing) && (
        <div
          className="fixed inset-0 z-[2750] flex items-center justify-center px-6"
          style={{ background: "rgba(0,0,0,0.7)", backdropFilter: "blur(2px)" }}
          data-testid="route-builder-recompute-overlay"
          role="status"
          aria-live="polite"
        >
          <div className="w-full max-w-sm bg-[hsl(22,15%,12%)] border border-amber-500/40 rounded-2xl px-5 py-4">
            <div className="flex items-center gap-2 mb-2">
              <span className="w-3.5 h-3.5 border-2 border-amber-500/30 border-t-amber-500 rounded-full animate-spin"></span>
              <p className="text-xs font-bold text-amber-300 uppercase tracking-wider">
                {swapping
                  ? `Swapping ${swapping.trailName}…`
                  : removing
                    ? `Removing ${removing.label}…`
                    : "Reordering route…"}
              </p>
            </div>
            <p className="text-[11px] text-stone-300 mb-2">
              {(swapping ?? removing ?? reordering)!.progress.label}
            </p>
            <div className="h-1.5 bg-stone-800 rounded-full overflow-hidden">
              <div
                className="h-full bg-gradient-to-r from-amber-500 to-amber-300 transition-all duration-300"
                style={{ width: `${(swapping ?? removing ?? reordering)!.progress.pct}%` }}
              />
            </div>
          </div>
        </div>
      )}

      {/* Per-trail swap picker — shown when the rider taps the swap
          icon on a trail row. Reuses the same data contract as the
          in-trip swap flow so the alternates already exclude
          AI-approximated trails. */}
      {swapPickerFor && (
        <div
          className="fixed inset-0 z-[2700] flex items-end justify-center"
          style={{ background: "rgba(0,0,0,0.85)", backdropFilter: "blur(4px)" }}
          role="dialog"
          aria-modal="true"
          aria-label={`Swap ${swapPickerFor.trailName}`}
          data-testid="route-builder-swap-picker"
        >
          <div
            className="w-full max-w-md bg-[hsl(22,15%,10%)] border-t border-amber-500/30 rounded-t-2xl flex flex-col"
            style={{ maxHeight: "70vh" }}
          >
            <div className="flex items-start justify-between px-4 py-3 border-b border-[hsl(30,12%,16%)] shrink-0">
              <div className="min-w-0">
                <h3 className="text-sm font-bold text-amber-400 uppercase tracking-widest">
                  Swap Trail
                </h3>
                <p className="text-xs text-stone-400 mt-0.5 truncate">
                  Replace <span className="text-stone-200">{swapPickerFor.trailName}</span>
                </p>
              </div>
              <button
                type="button"
                onClick={() => {
                  setSwapPickerFor(null);
                  setSwapAlternates(null);
                }}
                aria-label="Close swap picker"
                data-testid="route-builder-swap-cancel"
                className="w-8 h-8 rounded-full bg-stone-800 flex items-center justify-center text-stone-400 hover:text-stone-200 transition-colors shrink-0"
              >
                <svg viewBox="0 0 24 24" className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>
            <div className="overflow-y-auto flex-1 px-4 py-3 space-y-2">
              {swapAlternates === null ? (
                <div className="flex items-center gap-2 py-6 justify-center text-stone-500">
                  <span className="w-3.5 h-3.5 border-2 border-stone-600 border-t-stone-300 rounded-full animate-spin"></span>
                  <span className="text-xs">Finding nearby alternates…</span>
                </div>
              ) : swapAlternates.length === 0 ? (
                <div
                  className="text-center py-6 text-xs text-stone-500"
                  data-testid="route-builder-swap-empty"
                >
                  No similar trails found nearby. Try removing this trail and adding another from the map.
                </div>
              ) : (
                swapAlternates.map((alt) => {
                  const altDiff = alt.difficulty ?? 5;
                  return (
                    <button
                      key={alt.id}
                      type="button"
                      onClick={() => void handleConfirmSwap(alt)}
                      data-testid={`route-builder-swap-pick-${alt.id}`}
                      className="w-full text-left bg-[hsl(22,15%,13%)] border border-[hsl(30,12%,22%)] hover:border-amber-500/60 rounded-lg px-3 py-2.5 transition-all"
                    >
                      <div className="flex items-center gap-2 mb-0.5">
                        <span
                          className="w-4 h-4 rounded text-[10px] font-bold text-black flex items-center justify-center shrink-0"
                          style={{ backgroundColor: DIFFICULTY_COLORS[altDiff] ?? "#fbbf24" }}
                        >
                          {altDiff}
                        </span>
                        <span className="text-sm font-bold text-stone-100 truncate">
                          {alt.name}
                        </span>
                      </div>
                      <div className="flex items-center gap-1.5 flex-wrap">
                        {alt.distance_km != null && (
                          <>
                            <span className="text-[10px] text-stone-500">
                              {alt.distance_km.toFixed(1)} km
                            </span>
                            <span className="text-stone-700">·</span>
                          </>
                        )}
                        <span
                          className={`text-[10px] ${alt.legal_status === "BOAT" ? "text-amber-400" : "text-green-400"}`}
                        >
                          {alt.legal_status}
                        </span>
                      </div>
                    </button>
                  );
                })
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
