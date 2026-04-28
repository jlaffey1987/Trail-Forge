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
  fetchTrailActivityCounts,
  type TrailActivityCounts,
} from "@/lib/trailContent";
import AddTrailMenu, { type AddTrailChoice } from "@/components/contribute/AddTrailMenu";
import UploadGpxFlow from "@/components/contribute/UploadGpxFlow";
import EditTrailDialog from "@/components/contribute/EditTrailDialog";

const DIFFICULTY_COLORS: Record<number, string> = {
  1: "#4ade80", 2: "#86efac", 3: "#a3e635", 4: "#bef264", 5: "#fbbf24",
  6: "#fb923c", 7: "#f97316", 8: "#ef4444", 9: "#dc2626", 10: "#7f1d1d",
};

function formatDistance(km: number | null) {
  return km != null ? `${km.toFixed(1)} km` : "—";
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
  const [activityCounts, setActivityCounts] = useState<Record<string, TrailActivityCounts>>({});
  const [showAddMenu, setShowAddMenu] = useState(false);
  const [showUploadGpx, setShowUploadGpx] = useState(false);
  const [editingTrail, setEditingTrail] = useState<Trail | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

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

  const handleAddChoice = (choice: AddTrailChoice) => {
    setShowAddMenu(false);
    if (choice === "upload") {
      setShowUploadGpx(true);
    } else {
      // Record / Draw both happen on the Map. Dispatch a global event that
      // MainShell listens for: it switches the active tab to "map" and sets
      // ?mode= in the URL so MapTab's mount-effect auto-opens the flow.
      // (Wouter's setLocation alone doesn't switch tabs because the shell is
      //  state-driven, not route-driven.)
      window.dispatchEvent(
        new CustomEvent("trailforge:open-add-trail", { detail: { mode: choice } }),
      );
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
                  <button
                    className="w-full p-3 text-left"
                    onClick={() => setExpandedId(isExpanded ? null : `owned-${trail.id}`)}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex-1 min-w-0">
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
                      </div>
                      <div className="flex flex-col items-end gap-1 shrink-0">
                        <span className={`text-[10px] px-2 py-0.5 rounded-full font-medium ${
                          trail.is_public ? "text-green-400 bg-green-900/30" : "text-stone-400 bg-stone-700/30"
                        }`}>
                          {trail.is_public ? "Public" : "Private"}
                        </span>
                        <svg
                          viewBox="0 0 24 24"
                          className={`w-4 h-4 text-stone-500 transition-transform ${isExpanded ? "rotate-180" : ""}`}
                          fill="none" stroke="currentColor" strokeWidth="2"
                        >
                          <polyline points="6 9 12 15 18 9" />
                        </svg>
                      </div>
                    </div>
                    <div className="flex flex-wrap gap-x-3 gap-y-1 mt-2 text-xs">
                      <span className="text-stone-400">{formatDistance(trail.distance_km)}</span>
                      <span className="text-stone-600">·</span>
                      <span className="text-stone-400">{trail.terrain || "Mixed"}</span>
                      <span className="text-stone-600">·</span>
                      <span className={trail.legal_status === "BOAT" ? "text-amber-400" : "text-green-400"}>
                        {trail.legal_status || trail.type || "Trail"}
                      </span>
                    </div>
                  </button>
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
              >
                <button
                  className="w-full p-3 text-left"
                  onClick={() => setExpandedId(isExpanded ? null : trail.id)}
                >
                  <div className="flex items-start justify-between">
                    <div className="flex-1">
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
                    </div>
                    <div className="flex flex-col items-end gap-1">
                      <span className="text-[10px] px-2 py-0.5 rounded-full font-medium text-amber-400 bg-amber-900/30">
                        Planned
                      </span>
                      <svg
                        viewBox="0 0 24 24"
                        className={`w-4 h-4 text-stone-500 transition-transform ${isExpanded ? "rotate-180" : ""}`}
                        fill="none" stroke="currentColor" strokeWidth="2"
                      >
                        <polyline points="6 9 12 15 18 9" />
                      </svg>
                    </div>
                  </div>

                  <div className="flex gap-3 mt-2">
                    <span className="text-xs text-stone-400">{formatDistance(trail.distance_km)}</span>
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
    </div>
  );
}
