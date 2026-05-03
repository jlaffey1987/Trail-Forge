import { useCallback, useEffect, useState } from "react";
import { useLocation } from "wouter";
import {
  deleteOwnedTrail,
  fetchOwnedTrails,
  fetchSavedTrails,
  getSessionId,
  type Trail,
} from "@/lib/supabase";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import {
  listSavedRoutes,
  deleteSavedRoute,
  renameSavedRoute,
  type SavedRouteSummary,
} from "@/lib/savedRoutes";
import { setRouteEntries } from "@/lib/plannerRouteStore";
import type { RouteEntry } from "@/lib/routing";
import {
  fetchTrailActivityCounts,
  type TrailActivityCounts,
} from "@/lib/trailContent";
import AddTrailMenu, { type AddTrailChoice } from "@/components/contribute/AddTrailMenu";
import UploadGpxFlow from "@/components/contribute/UploadGpxFlow";
import EditTrailDialog from "@/components/contribute/EditTrailDialog";
import GroupsSection from "@/components/groups/GroupsSection";
import TrailDetailSheet from "@/components/TrailDetailSheet";

const DIFFICULTY_COLORS: Record<number, string> = {
  1: "#4ade80", 2: "#86efac", 3: "#a3e635", 4: "#bef264", 5: "#fbbf24",
  6: "#fb923c", 7: "#f97316", 8: "#ef4444", 9: "#dc2626", 10: "#7f1d1d",
};

const UPLOAD_GPX_INTENT_KEY_PREFIX = "trailforge.upload_gpx_intent_at:";
const UPLOAD_GPX_INTENT_TTL_MS = 5 * 60 * 1000;

function uploadIntentKey(userId: string | null | undefined): string {
  // Namespace by user (or "anon") so a previous user's interrupted upload
  // never auto-pops the modal for whoever signs in next on a shared device.
  return `${UPLOAD_GPX_INTENT_KEY_PREFIX}${userId ?? "anon"}`;
}

function formatDistance(km: number | null) {
  return km != null ? `${km.toFixed(1)} km` : "—";
}

function formatElevationGain(m: number | null | undefined): string | null {
  if (m == null || !Number.isFinite(m)) return null;
  return `${Math.round(m).toLocaleString()} m`;
}

function formatDate(dateStr: string) {
  return new Date(dateStr).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

export default function MyTrailsTab() {
  const { isLoaded, isSignedIn, userId } = useCurrentUser();
  const [, setLocation] = useLocation();
  const [savedTrails, setSavedTrails] = useState<Trail[]>([]);
  const [ownedTrails, setOwnedTrails] = useState<Trail[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [selectedTrail, setSelectedTrail] = useState<Trail | null>(null);
  const [activityCounts, setActivityCounts] = useState<Record<string, TrailActivityCounts>>({});
  const [showAddMenu, setShowAddMenu] = useState(false);
  const [showUploadGpx, setShowUploadGpx] = useState(false);
  const [editingTrail, setEditingTrail] = useState<Trail | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  // Saved routes — named library a signed-in rider has stashed away.
  // Loaded once per sign-in; refreshed after a load/delete so the list
  // stays accurate without polling.
  const [savedRoutes, setSavedRoutes] = useState<SavedRouteSummary[]>([]);
  const [loadingSavedRoutes, setLoadingSavedRoutes] = useState(false);
  const [deletingRouteId, setDeletingRouteId] = useState<string | null>(null);
  const [confirmDeleteRouteId, setConfirmDeleteRouteId] = useState<string | null>(null);
  // Inline rename dialog state. Holds the row being renamed plus the
  // editable text — the live `savedRoutes` array isn't mutated until
  // the server confirms the rename, so a failure leaves the original
  // name visible.
  const [renamingRoute, setRenamingRoute] = useState<SavedRouteSummary | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [renamingBusy, setRenamingBusy] = useState(false);
  const [renameError, setRenameError] = useState<string | null>(null);

  const refreshSavedRoutes = useCallback(async () => {
    if (!userId) {
      setSavedRoutes([]);
      return;
    }
    setLoadingSavedRoutes(true);
    const routes = await listSavedRoutes();
    setSavedRoutes(routes);
    setLoadingSavedRoutes(false);
  }, [userId]);

  useEffect(() => {
    if (!isLoaded) return;
    void refreshSavedRoutes();
  }, [isLoaded, refreshSavedRoutes]);

  const handleLoadRoute = useCallback(
    (route: SavedRouteSummary) => {
      // Rebuild a RouteEntry[] from the saved row's hydrated trails +
      // waypoints, ordered by entryOrder. Trails the rider can no
      // longer see (private/deleted) are silently skipped — same
      // behaviour as the planner-route GET. setRouteEntries replaces
      // the live store, persists to localStorage, AND triggers the
      // debounced PUT /me/planner-route, so the swap is mirrored
      // across devices.
      const trailById = new Map(route.trails.map((t) => [t.id, t]));
      const wpById = new Map(route.waypoints.map((w) => [w.id, w]));
      const order =
        route.entryOrder.length > 0
          ? route.entryOrder
          : [
              ...route.trailIds.map((id) => ({ kind: "trail" as const, id })),
              ...route.waypoints.map((w) => ({
                kind: "waypoint" as const,
                id: w.id,
              })),
            ];
      const entries: RouteEntry[] = [];
      for (const ref of order) {
        if (ref.kind === "trail") {
          const t = trailById.get(ref.id);
          if (t) entries.push({ kind: "trail", trail: t });
        } else {
          const w = wpById.get(ref.id);
          if (w) entries.push({ kind: "waypoint", waypoint: w });
        }
      }
      setRouteEntries(entries);
      setToast(`Loaded "${route.name}" into the planner`);
      // Jump straight to the Map so the rider sees the route drawn —
      // they can open the Planner from there if they want to edit.
      setLocation("/map");
    },
    [setLocation],
  );

  const openRenameDialog = useCallback((route: SavedRouteSummary) => {
    setRenamingRoute(route);
    setRenameDraft(route.name);
    setRenameError(null);
  }, []);

  const handleSubmitRename = useCallback(async () => {
    if (!renamingRoute) return;
    const trimmed = renameDraft.trim();
    if (trimmed.length === 0) {
      setRenameError("Name can't be empty");
      return;
    }
    if (trimmed.length > 200) {
      setRenameError("Name is too long (max 200 chars)");
      return;
    }
    if (trimmed === renamingRoute.name) {
      setRenamingRoute(null);
      return;
    }
    setRenamingBusy(true);
    setRenameError(null);
    const result = await renameSavedRoute(renamingRoute.id, trimmed);
    setRenamingBusy(false);
    if (result.status === "ok") {
      // Patch the local list in place so the new name shows up
      // immediately without a full refetch round-trip.
      setSavedRoutes((prev) =>
        prev.map((r) =>
          r.id === renamingRoute.id ? { ...r, name: result.name } : r,
        ),
      );
      setRenamingRoute(null);
      setToast("Route renamed");
    } else if (result.status === "not-found") {
      setRenameError("This route no longer exists");
    } else {
      setRenameError("Couldn't rename route");
    }
  }, [renamingRoute, renameDraft]);

  const handleDeleteRoute = useCallback(
    async (id: string) => {
      setDeletingRouteId(id);
      const ok = await deleteSavedRoute(id);
      setDeletingRouteId(null);
      setConfirmDeleteRouteId(null);
      if (ok) {
        setSavedRoutes((prev) => prev.filter((r) => r.id !== id));
        setToast("Route deleted");
      } else {
        setToast("Couldn't delete route");
      }
    },
    [],
  );

  const refreshOwned = useCallback(async () => {
    if (!userId) {
      setOwnedTrails([]);
      return;
    }
    const owned = await fetchOwnedTrails();
    setOwnedTrails(owned);
  }, [userId]);

  useEffect(() => {
    if (!isLoaded) return;
    setLoading(true);
    const owner = userId
      ? { userId, sessionId: null }
      : { userId: null, sessionId: getSessionId() };

    void Promise.all([
      fetchSavedTrails(owner),
      userId ? fetchOwnedTrails() : Promise.resolve([] as Trail[]),
    ]).then(([saved, owned]) => {
      setSavedTrails(saved);
      setOwnedTrails(owned);
      setLoading(false);
      const allIds = [...saved.map((t) => t.id), ...owned.map((t) => t.id)];
      if (allIds.length > 0) {
        void fetchTrailActivityCounts(allIds).then(setActivityCounts);
      }
    });
  }, [isLoaded, userId]);

  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => setToast(null), 3500);
    return () => window.clearTimeout(t);
  }, [toast]);

  // Recovery for the iOS standalone PWA edge case: if the OS file picker
  // (or any other system sheet) caused our WebView to be evicted while the
  // upload modal was open, the page reloads cold and the user lands on the
  // empty My Trails screen — confused, because they were just halfway
  // through an upload. We persist a short-lived intent flag so on next
  // mount we re-open the modal automatically. The 5-minute TTL stops a
  // crash from yesterday auto-popping the upload modal today, and the
  // per-user key stops a previous user's interrupted upload from popping
  // for whoever signs in next on a shared device. We gate on `isLoaded`
  // so we only check once the auth state (and therefore the right key) is
  // known.
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!isLoaded) return;
    try {
      const raw = window.localStorage.getItem(uploadIntentKey(userId));
      if (!raw) return;
      const ts = Number(raw);
      if (Number.isFinite(ts) && Date.now() - ts < UPLOAD_GPX_INTENT_TTL_MS) {
        setShowUploadGpx(true);
      } else {
        window.localStorage.removeItem(uploadIntentKey(userId));
      }
    } catch {
      /* localStorage may be unavailable in private mode — non-fatal. */
    }
  }, [isLoaded, userId]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!isLoaded) return;
    try {
      const key = uploadIntentKey(userId);
      if (showUploadGpx) {
        window.localStorage.setItem(key, Date.now().toString());
      } else {
        window.localStorage.removeItem(key);
      }
    } catch {
      /* non-fatal */
    }
  }, [showUploadGpx, isLoaded, userId]);

  const handleAddChoice = (choice: AddTrailChoice) => {
    setShowAddMenu(false);
    if (choice === "upload") {
      setShowUploadGpx(true);
    } else {
      // Record / Draw both happen on the Map. Navigate directly to /map and
      // pass the chosen mode via ?mode= so MapTab's mount-effect auto-opens
      // the matching flow.
      const params = new URLSearchParams(window.location.search);
      params.set("mode", choice);
      setLocation(`/map?${params.toString()}`);
    }
  };

  const handleDelete = async (trailId: string) => {
    setDeletingId(trailId);
    const ok = await deleteOwnedTrail(trailId);
    setDeletingId(null);
    setConfirmDeleteId(null);
    if (!ok) {
      setToast("Could not delete trail");
      return;
    }
    setOwnedTrails((prev) => prev.filter((t) => t.id !== trailId));
    setToast("Trail deleted");
  };

  const totalKm = savedTrails
    .reduce((sum, t) => sum + (t.distance_km ?? 0), 0)
    .toFixed(1);
  const ownedKm = ownedTrails
    .reduce((sum, t) => sum + (t.distance_km ?? 0), 0)
    .toFixed(1);

  return (
    <div className="flex flex-col h-full overflow-y-auto relative">
      <div className="px-4 pt-4 pb-2 flex items-start justify-between gap-3">
        <div>
          <h1 className="text-lg font-bold tracking-wide text-amber-400 uppercase" style={{ letterSpacing: "0.12em" }}>
            My Trails
          </h1>
          {!loading && (
            <div className="flex items-center gap-1.5 mt-0.5">
              <div className="w-1.5 h-1.5 rounded-full bg-green-400"></div>
              <p className="text-xs text-stone-400">Synced with Supabase</p>
            </div>
          )}
        </div>
        <button
          onClick={() => setShowAddMenu(true)}
          className="flex items-center gap-1.5 px-3 py-2 rounded-full text-xs font-bold uppercase tracking-wider text-stone-900 shadow-md"
          style={{ background: "linear-gradient(135deg, #d4870c, #f0a832)" }}
          data-testid="my-trails-add"
        >
          <svg viewBox="0 0 24 24" className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2.5">
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
          Add Trail
        </button>
      </div>

      {/* Stats Bar */}
      <div className="mx-4 mb-3 bg-[hsl(22,15%,11%)] border border-[hsl(30,12%,20%)] rounded-xl p-3">
        <div className="grid grid-cols-3 gap-3">
          <div className="text-center">
            <div className="text-xl font-bold text-amber-400">{loading ? "—" : ownedKm}</div>
            <div className="text-[10px] text-stone-500 uppercase tracking-wider mt-0.5">Owned km</div>
          </div>
          <div className="text-center border-x border-[hsl(30,12%,20%)]">
            <div className="text-xl font-bold text-amber-400">{loading ? "—" : ownedTrails.length}</div>
            <div className="text-[10px] text-stone-500 uppercase tracking-wider mt-0.5">My trails</div>
          </div>
          <div className="text-center">
            <div className="text-xl font-bold text-amber-400">{loading ? "—" : savedTrails.length}</div>
            <div className="text-[10px] text-stone-500 uppercase tracking-wider mt-0.5">Saved</div>
          </div>
        </div>
      </div>

      {/* My Trails (owned) section */}
      <section className="px-4 pb-4">
        <h2 className="text-[11px] font-bold uppercase tracking-widest text-stone-400 mb-2">
          My Trails ({ownedTrails.length})
        </h2>
        {loading ? (
          <div className="text-xs text-stone-500 py-4 text-center">Loading…</div>
        ) : !isSignedIn ? (
          <div className="bg-[hsl(22,15%,11%)] border border-[hsl(30,12%,20%)] rounded-xl p-4 text-center">
            <p className="text-stone-500 text-xs mb-3">Sign in to upload, record, or draw your own trails.</p>
            <button
              onClick={() => setLocation("/sign-in")}
              className="px-4 py-2 rounded-lg text-xs font-bold uppercase tracking-wider text-stone-900"
              style={{ background: "linear-gradient(135deg, #d4870c, #f0a832)" }}
              data-testid="my-trails-sign-in"
            >
              Sign in
            </button>
          </div>
        ) : ownedTrails.length === 0 ? (
          <div className="bg-[hsl(22,15%,11%)] border border-[hsl(30,12%,20%)] rounded-xl p-4 text-center" data-testid="owned-trails-empty">
            <p className="text-stone-500 text-xs">No trails yet. Tap "Add Trail" to upload, record, or draw one.</p>
          </div>
        ) : (
          <div className="space-y-3" data-testid="owned-trails-list">
            {ownedTrails.map((trail) => {
              const diff = trail.difficulty ?? 5;
              const isExpanded = expandedId === `owned-${trail.id}`;
              return (
                <div
                  key={trail.id}
                  className="bg-[hsl(22,15%,11%)] border border-[hsl(30,12%,20%)] rounded-xl overflow-hidden"
                  data-testid={`owned-trail-${trail.id}`}
                >
                  <div className="p-3 flex items-start gap-2">
                    <button
                      type="button"
                      className="flex-1 min-w-0 text-left"
                      onClick={() => setSelectedTrail(trail)}
                      data-testid={`owned-trail-open-${trail.id}`}
                      aria-label={`View details for ${trail.name}`}
                      title="View trail details"
                    >
                      <div className="flex items-center gap-2 mb-1">
                        <span
                          className="w-5 h-5 rounded text-xs font-bold text-black flex items-center justify-center shrink-0"
                          style={{ backgroundColor: DIFFICULTY_COLORS[diff] ?? "#fbbf24" }}
                        >
                          {diff}
                        </span>
                        <h3 className="text-sm font-bold text-stone-100 truncate">{trail.name}</h3>
                      </div>
                      <p className="text-xs text-stone-500">{formatDate(trail.created_at)}</p>
                      <div className="flex flex-wrap gap-x-3 gap-y-1 mt-2 text-xs">
                        <span className="text-stone-400">{formatDistance(trail.distance_km)}</span>
                        {(() => {
                          const gain = formatElevationGain(trail.elevation_gain_m);
                          return gain ? (
                            <>
                              <span className="text-stone-600">·</span>
                              <span
                                className="text-emerald-400"
                                title="Total ascent"
                                data-testid={`owned-trail-elevation-gain-${trail.id}`}
                              >
                                ↑ {gain}
                              </span>
                            </>
                          ) : null;
                        })()}
                        {(() => {
                          const loss = formatElevationGain(trail.elevation_loss_m);
                          return loss ? (
                            <>
                              <span className="text-stone-600">·</span>
                              <span
                                className="text-sky-400"
                                title="Total descent"
                                data-testid={`owned-trail-elevation-loss-${trail.id}`}
                              >
                                ↓ {loss}
                              </span>
                            </>
                          ) : null;
                        })()}
                        <span className="text-stone-600">·</span>
                        <span className="text-stone-400">{trail.terrain || "Mixed"}</span>
                        <span className="text-stone-600">·</span>
                        <span className={trail.legal_status === "BOAT" ? "text-amber-400" : "text-green-400"}>
                          {trail.legal_status || trail.type || "Trail"}
                        </span>
                      </div>
                    </button>
                    <div className="flex flex-col items-end gap-1 shrink-0">
                      <span className={`text-[10px] px-2 py-0.5 rounded-full font-medium ${
                        trail.is_public ? "text-green-400 bg-green-900/30" : "text-stone-400 bg-stone-700/30"
                      }`}>
                        {trail.is_public ? "Public" : "Private"}
                      </span>
                      <button
                        type="button"
                        onClick={() =>
                          setExpandedId(isExpanded ? null : `owned-${trail.id}`)
                        }
                        className="p-1 -m-1 text-stone-500 hover:text-stone-300"
                        aria-label={isExpanded ? "Hide actions" : "Show actions"}
                        aria-expanded={isExpanded}
                        data-testid={`owned-trail-toggle-${trail.id}`}
                      >
                        <svg
                          viewBox="0 0 24 24"
                          className={`w-4 h-4 transition-transform ${isExpanded ? "rotate-180" : ""}`}
                          fill="none" stroke="currentColor" strokeWidth="2"
                        >
                          <polyline points="6 9 12 15 18 9" />
                        </svg>
                      </button>
                    </div>
                  </div>
                  {isExpanded && (
                    <div className="border-t border-[hsl(30,12%,16%)] p-3 space-y-2">
                      {trail.description && (
                        <p className="text-xs text-stone-300 whitespace-pre-line">{trail.description}</p>
                      )}
                      <div className="text-[10px] text-stone-500">
                        {(activityCounts[trail.id]?.notes ?? 0)} notes ·{" "}
                        {(activityCounts[trail.id]?.photos ?? 0)} photos
                      </div>
                      <div className="flex flex-wrap gap-2 pt-1">
                        <button
                          onClick={() => setLocation("/map")}
                          className="flex-1 min-w-[100px] py-2 rounded-lg text-xs font-semibold text-amber-400 border border-amber-500/30 hover:bg-amber-500/10 transition-colors"
                          data-testid={`owned-trail-view-${trail.id}`}
                        >
                          View on Map
                        </button>
                        <button
                          onClick={() => setEditingTrail(trail)}
                          className="flex-1 min-w-[100px] py-2 rounded-lg text-xs font-semibold text-stone-300 border border-stone-700 hover:bg-stone-700/30 transition-colors"
                          data-testid={`owned-trail-edit-${trail.id}`}
                        >
                          Edit
                        </button>
                        <button
                          onClick={() => setConfirmDeleteId(trail.id)}
                          className="flex-1 min-w-[100px] py-2 rounded-lg text-xs font-semibold text-red-400 border border-red-500/30 hover:bg-red-900/30 transition-colors"
                          data-testid={`owned-trail-delete-${trail.id}`}
                        >
                          Delete
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </section>

      <GroupsSection signedIn={!!isSignedIn} />

      {/* Saved Routes — named library of multi-trail routes */}
      {isSignedIn && (
        <section className="px-4 pb-6 space-y-3" data-testid="saved-routes-section">
          <div className="flex items-baseline justify-between">
            <h2 className="text-[11px] font-bold uppercase tracking-widest text-stone-400">
              Saved Routes ({savedRoutes.length})
            </h2>
            <span className="text-[10px] text-stone-500">From the planner</span>
          </div>
          {loadingSavedRoutes ? (
            <div className="flex flex-col items-center justify-center py-6">
              <div className="w-6 h-6 border-2 border-amber-500/30 border-t-amber-500 rounded-full animate-spin"></div>
            </div>
          ) : savedRoutes.length === 0 ? (
            <div className="bg-[hsl(22,15%,11%)] border border-[hsl(30,12%,20%)] rounded-xl p-4 text-center">
              <p className="text-stone-500 text-xs">No saved routes yet.</p>
              <p className="text-stone-600 text-[11px] mt-1">
                Build a route in the Planner, then tap "Save Route to My Trails".
              </p>
            </div>
          ) : (
            savedRoutes.map((route) => {
              const trailCount = route.trails.length;
              // The hydrated count can be lower than trail_ids.length if
              // the rider lost access to some trails (private/deleted).
              // Surface that so they aren't surprised when loading.
              const missing = route.trailIds.length - trailCount;
              return (
                <div
                  key={route.id}
                  data-testid={`saved-route-${route.id}`}
                  className="bg-[hsl(22,15%,11%)] border border-[hsl(30,12%,20%)] rounded-xl overflow-hidden"
                >
                  <div className="p-3">
                    <div className="flex items-start gap-2">
                      <div className="flex-1 min-w-0">
                        <h3 className="text-sm font-bold text-stone-100 truncate">
                          {route.name}
                        </h3>
                        <div className="flex flex-wrap gap-x-3 gap-y-0.5 mt-1">
                          <span className="text-[11px] text-stone-400">
                            {trailCount} trail{trailCount !== 1 ? "s" : ""}
                          </span>
                          {route.waypoints.length > 0 && (
                            <>
                              <span className="text-[11px] text-stone-600">·</span>
                              <span className="text-[11px] text-stone-400">
                                {route.waypoints.length} stop
                                {route.waypoints.length !== 1 ? "s" : ""}
                              </span>
                            </>
                          )}
                          {route.distanceKm != null && (
                            <>
                              <span className="text-[11px] text-stone-600">·</span>
                              <span className="text-[11px] text-amber-400">
                                {route.distanceKm.toFixed(1)} km
                              </span>
                            </>
                          )}
                          <span className="text-[11px] text-stone-600">·</span>
                          <span className="text-[11px] text-stone-500">
                            {formatDate(route.createdAt)}
                          </span>
                        </div>
                        {missing > 0 && (
                          <p
                            className="text-[10px] text-amber-500/70 mt-1"
                            data-testid={`saved-route-missing-${route.id}`}
                          >
                            {missing} trail{missing !== 1 ? "s" : ""} no longer available
                          </p>
                        )}
                      </div>
                      <span className="text-[10px] px-2 py-0.5 rounded-full font-medium text-amber-400 bg-amber-900/30 shrink-0">
                        Route
                      </span>
                    </div>
                    <div className="flex gap-2 mt-3">
                      <button
                        type="button"
                        onClick={() => handleLoadRoute(route)}
                        disabled={trailCount === 0}
                        data-testid={`saved-route-load-${route.id}`}
                        className="flex-1 py-2 rounded-lg text-xs font-bold uppercase tracking-wider text-stone-900 disabled:opacity-40 disabled:cursor-not-allowed"
                        style={{
                          background:
                            trailCount === 0
                              ? "hsl(22,15%,16%)"
                              : "linear-gradient(135deg, #d4870c 0%, #f0a832 50%, #d4870c 100%)",
                          color: trailCount === 0 ? "#6b7280" : "#1a0e05",
                        }}
                      >
                        Load on Map
                      </button>
                      <button
                        type="button"
                        onClick={() => openRenameDialog(route)}
                        data-testid={`saved-route-rename-${route.id}`}
                        className="px-3 py-2 rounded-lg text-xs font-semibold text-stone-300 border border-stone-700 hover:bg-stone-800/60 transition-colors"
                        aria-label={`Rename route ${route.name}`}
                      >
                        <svg viewBox="0 0 24 24" className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2.2">
                          <path d="M12 20h9" />
                          <path d="M16.5 3.5a2.121 2.121 0 1 1 3 3L7 19l-4 1 1-4 12.5-12.5z" />
                        </svg>
                      </button>
                      <button
                        type="button"
                        onClick={() => setConfirmDeleteRouteId(route.id)}
                        disabled={deletingRouteId === route.id}
                        data-testid={`saved-route-delete-${route.id}`}
                        className="px-3 py-2 rounded-lg text-xs font-semibold text-red-400 border border-red-500/30 hover:bg-red-900/30 transition-colors disabled:opacity-50"
                        aria-label={`Delete route ${route.name}`}
                      >
                        <svg viewBox="0 0 24 24" className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2.2">
                          <polyline points="3 6 5 6 21 6" />
                          <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                          <path d="M10 11v6M14 11v6" />
                          <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
                        </svg>
                      </button>
                    </div>
                  </div>
                </div>
              );
            })
          )}
        </section>
      )}

      {/* Saved (planned) trails section */}
      <section className="px-4 pb-6 space-y-3">
        <div className="flex items-baseline justify-between">
          <h2 className="text-[11px] font-bold uppercase tracking-widest text-stone-400">
            Saved from Planner ({savedTrails.length})
          </h2>
          {!loading && (
            <span className="text-[10px] text-stone-500">{totalKm} km total</span>
          )}
        </div>
        {loading ? (
          <div className="flex flex-col items-center justify-center py-10">
            <div className="w-8 h-8 border-2 border-amber-500/30 border-t-amber-500 rounded-full animate-spin mb-3"></div>
            <p className="text-xs text-stone-400">Loading from Supabase…</p>
          </div>
        ) : savedTrails.length === 0 ? (
          <div className="bg-[hsl(22,15%,11%)] border border-[hsl(30,12%,20%)] rounded-xl p-4 text-center">
            <p className="text-stone-500 text-xs">No saved trails yet.</p>
            <p className="text-stone-600 text-[11px] mt-1">Tap the bookmark in the Planner to save trails here.</p>
          </div>
        ) : (
          savedTrails.map((trail) => {
            const diff = trail.difficulty ?? 5;
            const isExpanded = expandedId === trail.id;
            return (
              <div
                key={trail.id}
                className="bg-[hsl(22,15%,11%)] border border-[hsl(30,12%,20%)] rounded-xl overflow-hidden"
                data-testid={`saved-trail-${trail.id}`}
              >
                <div className="p-3 flex items-start gap-2">
                  <button
                    type="button"
                    className="flex-1 min-w-0 text-left"
                    onClick={() => setSelectedTrail(trail)}
                    data-testid={`saved-trail-open-${trail.id}`}
                    aria-label={`View details for ${trail.name}`}
                  >
                    <div className="flex items-center gap-2 mb-1">
                      <span
                        className="w-5 h-5 rounded text-xs font-bold text-black flex items-center justify-center shrink-0"
                        style={{ backgroundColor: DIFFICULTY_COLORS[diff] ?? "#fbbf24" }}
                      >
                        {diff}
                      </span>
                      <h3 className="text-sm font-bold text-stone-100">{trail.name}</h3>
                    </div>
                    <p className="text-xs text-stone-500">{formatDate(trail.created_at)}</p>

                    <div className="flex flex-wrap gap-x-3 gap-y-1 mt-2">
                      <span className="text-xs text-stone-400">{formatDistance(trail.distance_km)}</span>
                      {(() => {
                        const gain = formatElevationGain(trail.elevation_gain_m);
                        return gain ? (
                          <>
                            <span className="text-xs text-stone-600">·</span>
                            <span
                              className="text-xs text-emerald-400"
                              title="Total ascent"
                              data-testid={`saved-trail-elevation-gain-${trail.id}`}
                            >
                              ↑ {gain}
                            </span>
                          </>
                        ) : null;
                      })()}
                      {(() => {
                        const loss = formatElevationGain(trail.elevation_loss_m);
                        return loss ? (
                          <>
                            <span className="text-xs text-stone-600">·</span>
                            <span
                              className="text-xs text-sky-400"
                              title="Total descent"
                              data-testid={`saved-trail-elevation-loss-${trail.id}`}
                            >
                              ↓ {loss}
                            </span>
                          </>
                        ) : null;
                      })()}
                      <span className="text-xs text-stone-600">·</span>
                      <span className="text-xs text-stone-400">{trail.terrain || "Off-road"}</span>
                      <span className="text-xs text-stone-600">·</span>
                      <span className={`text-xs ${trail.legal_status === "BOAT" ? "text-amber-400" : "text-green-400"}`}>
                        {trail.legal_status || trail.type || "Trail"}
                      </span>
                    </div>
                    <div
                      className="text-[10px] text-stone-500 mt-1"
                      data-testid={`trail-card-counts-${trail.id}`}
                    >
                      {(activityCounts[trail.id]?.notes ?? 0)} notes ·{" "}
                      {(activityCounts[trail.id]?.photos ?? 0)} photos ·{" "}
                      {(activityCounts[trail.id]?.pending ?? 0)} pending
                    </div>
                  </button>
                  <div className="flex flex-col items-end gap-1 shrink-0">
                    <span className="text-[10px] px-2 py-0.5 rounded-full font-medium text-amber-400 bg-amber-900/30">
                      Planned
                    </span>
                    <button
                      type="button"
                      onClick={() => setExpandedId(isExpanded ? null : trail.id)}
                      className="p-1 -m-1 text-stone-500 hover:text-stone-300"
                      aria-label={isExpanded ? "Hide actions" : "Show actions"}
                      aria-expanded={isExpanded}
                      data-testid={`saved-trail-toggle-${trail.id}`}
                    >
                      <svg
                        viewBox="0 0 24 24"
                        className={`w-4 h-4 transition-transform ${isExpanded ? "rotate-180" : ""}`}
                        fill="none" stroke="currentColor" strokeWidth="2"
                      >
                        <polyline points="6 9 12 15 18 9" />
                      </svg>
                    </button>
                  </div>
                </div>

                {isExpanded && (
                  <div className="border-t border-[hsl(30,12%,16%)] p-3">
                    <div className="grid grid-cols-2 gap-2 mb-3">
                      <div className="bg-[hsl(22,15%,14%)] rounded-lg p-2">
                        <div className="text-xs text-stone-500 mb-0.5">Distance</div>
                        <div className="text-sm font-bold text-amber-400">{formatDistance(trail.distance_km)}</div>
                      </div>
                      <div className="bg-[hsl(22,15%,14%)] rounded-lg p-2">
                        <div className="text-xs text-stone-500 mb-0.5">Surface</div>
                        <div className="text-sm font-bold text-stone-300">{trail.terrain || "Mixed"}</div>
                      </div>
                    </div>
                    <div className="flex gap-2">
                      <button className="flex-1 py-2 rounded-lg text-xs font-semibold text-amber-400 border border-amber-500/30 hover:bg-amber-500/10 transition-colors">
                        View on Map
                      </button>
                      <button className="flex-1 py-2 rounded-lg text-xs font-semibold text-stone-400 border border-stone-700 hover:bg-stone-700/30 transition-colors">
                        Share
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })
        )}
      </section>

      {/* Toast */}
      {toast && (
        <div className="fixed bottom-20 left-1/2 -translate-x-1/2 z-[2000] bg-[hsl(22,15%,14%)] border border-amber-500/40 text-amber-300 text-xs font-bold px-4 py-2 rounded-full shadow-lg" data-testid="my-trails-toast">
          {toast}
        </div>
      )}

      {/* Add Trail menu */}
      <AddTrailMenu
        open={showAddMenu}
        onClose={() => setShowAddMenu(false)}
        onChoose={handleAddChoice}
      />

      {/* Upload GPX flow */}
      <UploadGpxFlow
        open={showUploadGpx}
        onClose={() => setShowUploadGpx(false)}
        onSaved={() => {
          setToast("Trail uploaded");
          void refreshOwned();
        }}
      />

      {/* Edit dialog */}
      <EditTrailDialog
        open={editingTrail != null}
        trail={editingTrail}
        onClose={() => setEditingTrail(null)}
        onChanged={(updated) => {
          setOwnedTrails((prev) => prev.map((t) => (t.id === updated.id ? updated : t)));
          setToast("Trail updated");
        }}
      />

      {/* Rename saved-route dialog */}
      {renamingRoute && (
        <div
          className="fixed inset-0 z-[2700] flex items-center justify-center px-4"
          style={{ background: "rgba(0,0,0,0.85)" }}
          role="dialog"
          aria-modal="true"
          data-testid="rename-route-dialog"
        >
          <div className="w-full max-w-sm bg-[hsl(22,15%,12%)] border border-amber-500/30 rounded-2xl p-5">
            <h3 className="text-base font-bold text-amber-300 uppercase tracking-wider mb-3">
              Rename Route
            </h3>
            <input
              type="text"
              value={renameDraft}
              onChange={(e) => {
                setRenameDraft(e.target.value);
                if (renameError) setRenameError(null);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !renamingBusy) {
                  e.preventDefault();
                  void handleSubmitRename();
                } else if (e.key === "Escape") {
                  setRenamingRoute(null);
                }
              }}
              autoFocus
              maxLength={200}
              disabled={renamingBusy}
              data-testid="rename-route-input"
              placeholder="Route name"
              className="w-full px-3 py-2.5 rounded-lg bg-[hsl(22,15%,9%)] border border-stone-700 text-sm text-stone-100 placeholder-stone-500 focus:outline-none focus:border-amber-500/60"
            />
            {renameError && (
              <p
                className="mt-2 text-[11px] text-red-400"
                data-testid="rename-route-error"
              >
                {renameError}
              </p>
            )}
            <div className="flex gap-2 mt-4">
              <button
                onClick={() => setRenamingRoute(null)}
                disabled={renamingBusy}
                className="flex-1 py-2.5 rounded-lg text-xs font-bold uppercase tracking-wider text-stone-300 border border-stone-700"
              >
                Cancel
              </button>
              <button
                onClick={() => void handleSubmitRename()}
                disabled={renamingBusy || renameDraft.trim().length === 0}
                data-testid="rename-route-submit"
                className="flex-1 py-2.5 rounded-lg text-xs font-bold uppercase tracking-wider text-stone-900 disabled:opacity-50"
                style={{
                  background:
                    "linear-gradient(135deg, #d4870c 0%, #f0a832 50%, #d4870c 100%)",
                  color: "#1a0e05",
                }}
              >
                {renamingBusy ? "Saving…" : "Save"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete saved-route confirm */}
      {confirmDeleteRouteId && (() => {
        const route = savedRoutes.find((r) => r.id === confirmDeleteRouteId);
        if (!route) return null;
        return (
          <div
            className="fixed inset-0 z-[2700] flex items-center justify-center px-4"
            style={{ background: "rgba(0,0,0,0.85)" }}
            role="dialog"
            aria-modal="true"
            data-testid="delete-route-confirm"
          >
            <div className="w-full max-w-sm bg-[hsl(22,15%,12%)] border border-[hsl(30,12%,22%)] rounded-2xl p-5">
              <h3 className="text-base font-bold text-red-400 uppercase tracking-wider mb-2">
                Delete Route?
              </h3>
              <p className="text-xs text-stone-400 mb-4">
                "{route.name}" will be removed from your saved routes. The trails themselves stay where they are.
              </p>
              <div className="flex gap-2">
                <button
                  onClick={() => setConfirmDeleteRouteId(null)}
                  disabled={deletingRouteId != null}
                  className="flex-1 py-2.5 rounded-lg text-xs font-bold uppercase tracking-wider text-stone-300 border border-stone-700"
                >
                  Cancel
                </button>
                <button
                  onClick={() => void handleDeleteRoute(confirmDeleteRouteId)}
                  disabled={deletingRouteId != null}
                  data-testid="delete-route-confirm-button"
                  className="flex-1 py-2.5 rounded-lg text-xs font-bold uppercase tracking-wider text-white bg-red-600 disabled:opacity-50"
                >
                  {deletingRouteId != null ? "Deleting…" : "Delete"}
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* Delete confirm */}
      {confirmDeleteId && (
        <div
          className="fixed inset-0 z-[2700] flex items-center justify-center px-4"
          style={{ background: "rgba(0,0,0,0.85)" }}
          role="dialog"
          aria-modal="true"
          data-testid="delete-trail-confirm"
        >
          <div className="w-full max-w-sm bg-[hsl(22,15%,12%)] border border-[hsl(30,12%,22%)] rounded-2xl p-5">
            <h3 className="text-base font-bold text-red-400 uppercase tracking-wider mb-2">Delete Trail?</h3>
            <p className="text-xs text-stone-400 mb-4">
              The trail will be removed from the map. Any community notes and photos others added are preserved.
            </p>
            <div className="flex gap-2">
              <button
                onClick={() => setConfirmDeleteId(null)}
                disabled={deletingId != null}
                className="flex-1 py-2.5 rounded-lg text-xs font-bold uppercase tracking-wider text-stone-300 border border-stone-700"
              >
                Cancel
              </button>
              <button
                onClick={() => void handleDelete(confirmDeleteId)}
                disabled={deletingId != null}
                className="flex-1 py-2.5 rounded-lg text-xs font-bold uppercase tracking-wider text-white bg-red-600 disabled:opacity-50"
                data-testid="delete-trail-confirm-button"
              >
                {deletingId != null ? "Deleting…" : "Delete"}
              </button>
            </div>
          </div>
        </div>
      )}

      {selectedTrail && (() => {
        // The same trail may live in either the "owned" or "saved" list.
        // Walk the list it belongs to so prev/next jumps stay within the
        // section the rider was browsing. Falls back to no neighbours if
        // the trail isn't found in either (e.g. just deleted).
        const ownedIdx = ownedTrails.findIndex((t) => t.id === selectedTrail.id);
        const savedIdx = savedTrails.findIndex((t) => t.id === selectedTrail.id);
        const list = ownedIdx >= 0 ? ownedTrails : savedIdx >= 0 ? savedTrails : [];
        const idx = ownedIdx >= 0 ? ownedIdx : savedIdx;
        const prevTrail = idx > 0 ? list[idx - 1] : null;
        const nextTrail = idx >= 0 && idx < list.length - 1 ? list[idx + 1] : null;
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
