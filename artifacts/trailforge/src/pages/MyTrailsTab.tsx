import { useState, useEffect } from "react";
import { useLocation } from "wouter";
import { fetchSavedTrails, getSessionId, type Trail } from "@/lib/supabase";
import { useCurrentUser } from "@/hooks/useCurrentUser";

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
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  useEffect(() => {
    if (!isLoaded) return;
    setLoading(true);
    const owner = userId
      ? { userId, sessionId: null }
      : { userId: null, sessionId: getSessionId() };
    fetchSavedTrails(owner).then((trails) => {
      setSavedTrails(trails);
      setLoading(false);
    });
  }, [isLoaded, userId]);

  const totalKm = savedTrails
    .reduce((sum, t) => sum + (t.distance_km ?? 0), 0)
    .toFixed(1);

  return (
    <div className="flex flex-col h-full overflow-y-auto">
      <div className="px-4 pt-4 pb-2">
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

      {/* Stats Bar */}
      <div className="mx-4 mb-3 bg-[hsl(22,15%,11%)] border border-[hsl(30,12%,20%)] rounded-xl p-3">
        <div className="grid grid-cols-3 gap-3">
          <div className="text-center">
            <div className="text-xl font-bold text-amber-400">{loading ? "—" : totalKm}</div>
            <div className="text-[10px] text-stone-500 uppercase tracking-wider mt-0.5">Total km</div>
          </div>
          <div className="text-center border-x border-[hsl(30,12%,20%)]">
            <div className="text-xl font-bold text-amber-400">{loading ? "—" : savedTrails.length}</div>
            <div className="text-[10px] text-stone-500 uppercase tracking-wider mt-0.5">Saved</div>
          </div>
          <div className="text-center">
            <div className="text-xl font-bold text-amber-400">
              {loading ? "—" : savedTrails.filter(t => (t.difficulty ?? 0) >= 7).length}
            </div>
            <div className="text-[10px] text-stone-500 uppercase tracking-wider mt-0.5">Expert+</div>
          </div>
        </div>
      </div>

      {/* Trail List */}
      <div className="px-4 pb-6 space-y-3">
        {loading ? (
          <div className="flex flex-col items-center justify-center py-16">
            <div className="w-8 h-8 border-2 border-amber-500/30 border-t-amber-500 rounded-full animate-spin mb-3"></div>
            <p className="text-sm text-stone-400">Loading from Supabase...</p>
          </div>
        ) : savedTrails.length === 0 ? (
          <div className="text-center py-12">
            <div className="text-4xl mb-3">🏍</div>
            <p className="text-stone-500 text-sm">No saved trails yet.</p>
            <p className="text-stone-600 text-xs mt-1">Search trails in the Planner tab and tap the bookmark icon to save them here.</p>
            {!isSignedIn && (
              <button
                onClick={() => setLocation("/sign-in")}
                className="mt-4 px-4 py-2 rounded-lg text-xs font-bold uppercase tracking-wider text-stone-900"
                style={{ background: "linear-gradient(135deg, #d4870c, #f0a832)" }}
                data-testid="my-trails-sign-in"
              >
                Sign in to sync across devices
              </button>
            )}
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
      </div>
    </div>
  );
}
