import { useState, useEffect } from "react";
import { fetchCommunityTrails, type Trail } from "@/lib/supabase";

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

function getPostedTime(created_at: string) {
  const diff = Date.now() - new Date(created_at).getTime();
  const h = Math.floor(diff / 3600000);
  if (h < 1) return "Just now";
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

export default function DiscoverTab() {
  const [activeFilter, setActiveFilter] = useState("All");
  const [liked, setLiked] = useState<Set<string>>(new Set());
  const [trails, setTrails] = useState<Trail[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");

  useEffect(() => {
    fetchCommunityTrails().then((data) => {
      setTrails(data);
      setLoading(false);
    });
  }, []);

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
    <div className="flex flex-col h-full overflow-y-auto">
      <div className="px-4 pt-4 pb-2">
        <h1 className="text-lg font-bold tracking-wide text-amber-400 uppercase" style={{ letterSpacing: "0.12em" }}>
          Discover
        </h1>
        <p className="text-xs text-stone-400 mt-0.5">
          {loading ? "Loading live trails..." : `${trails.length} community trails`}
        </p>
      </div>

      {/* Search Bar */}
      <div className="px-4 mb-3">
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

      {/* Filter Chips */}
      <div className="px-4 mb-3 flex gap-2 overflow-x-auto pb-1" style={{ scrollbarWidth: "none" }}>
        {FILTERS.map((f) => (
          <button
            key={f}
            onClick={() => setActiveFilter(f)}
            className={`shrink-0 px-3 py-1.5 rounded-full text-xs font-semibold transition-all ${
              activeFilter === f
                ? "bg-amber-500 text-stone-900"
                : "bg-[hsl(22,15%,14%)] text-stone-400 border border-[hsl(30,12%,20%)]"
            }`}
          >
            {f}
          </button>
        ))}
      </div>

      {/* Loading */}
      {loading && (
        <div className="flex flex-col items-center justify-center py-16 px-4">
          <div className="w-8 h-8 border-2 border-amber-500/30 border-t-amber-500 rounded-full animate-spin mb-3"></div>
          <p className="text-sm text-stone-400">Loading live trails from Supabase...</p>
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

              return (
                <div
                  key={trail.id}
                  className="bg-[hsl(22,15%,11%)] border border-[hsl(30,12%,20%)] rounded-xl overflow-hidden hover:border-amber-500/20 transition-colors"
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

                    <div className="flex items-center gap-2 mb-2">
                      <span className="text-xs text-stone-400 bg-stone-800/80 px-2 py-0.5 rounded">
                        {formatDistance(trail.distance_km)}
                      </span>
                      <span className="text-xs text-stone-500 bg-stone-800/40 px-2 py-0.5 rounded">
                        {trail.terrain || "Mixed"}
                      </span>
                    </div>

                    <div className="flex items-center justify-between pt-2 border-t border-[hsl(30,12%,16%)]">
                      <div className="flex items-center gap-3">
                        <button onClick={() => toggleLike(trail.id)} className="flex items-center gap-1 transition-colors">
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
                      <button className="text-xs text-amber-400 font-semibold hover:text-amber-300 transition-colors">
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
    </div>
  );
}
