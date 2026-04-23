import { useState } from "react";

interface CommunityTrail {
  id: number;
  name: string;
  author: string;
  authorAvatar: string;
  distance: string;
  difficulty: number;
  region: string;
  surface: string;
  likes: number;
  comments: number;
  tags: string[];
  preview: string;
  posted: string;
  featured?: boolean;
}

const COMMUNITY_TRAILS: CommunityTrail[] = [
  {
    id: 1,
    name: "The Roaches Circuit",
    author: "DirtBiker_UK",
    authorAvatar: "DB",
    distance: "38.5 km",
    difficulty: 7,
    region: "Staffordshire Moorlands",
    surface: "Technical Enduro",
    likes: 487,
    comments: 63,
    tags: ["Technical", "Rocky", "Views"],
    preview: "bg-gradient-to-br from-stone-800 to-stone-900",
    posted: "2h ago",
    featured: true,
  },
  {
    id: 2,
    name: "Forest of Dean Green Run",
    author: "GreenLaner_Pro",
    authorAvatar: "GL",
    distance: "24.2 km",
    difficulty: 3,
    region: "Forest of Dean",
    surface: "Green Lane",
    likes: 312,
    comments: 41,
    tags: ["Family Friendly", "Wooded", "Scenic"],
    preview: "bg-gradient-to-br from-green-900 to-stone-900",
    posted: "5h ago",
  },
  {
    id: 3,
    name: "Kielder Forest Enduro",
    author: "TrailMaster_99",
    authorAvatar: "TM",
    distance: "71.8 km",
    difficulty: 9,
    region: "Northumberland",
    surface: "Extreme",
    likes: 891,
    comments: 147,
    tags: ["Epic", "Remote", "Advanced"],
    preview: "bg-gradient-to-br from-slate-800 to-stone-900",
    posted: "1d ago",
    featured: true,
  },
  {
    id: 4,
    name: "Welsh Border Taster",
    author: "OffRoad_Wales",
    authorAvatar: "OW",
    distance: "19.7 km",
    difficulty: 4,
    region: "Welsh Borders",
    surface: "Mixed",
    likes: 156,
    comments: 22,
    tags: ["Mixed", "Beginner+", "Hills"],
    preview: "bg-gradient-to-br from-emerald-900 to-stone-900",
    posted: "2d ago",
  },
  {
    id: 5,
    name: "Exmoor Beast",
    author: "SomsetRider",
    authorAvatar: "SR",
    distance: "55.3 km",
    difficulty: 8,
    region: "Exmoor",
    surface: "BOATs",
    likes: 624,
    comments: 89,
    tags: ["BOATs", "Moor", "Challenging"],
    preview: "bg-gradient-to-br from-amber-900 to-stone-900",
    posted: "3d ago",
  },
];

const DIFFICULTY_COLORS: Record<number, string> = {
  1: "#4ade80", 2: "#86efac", 3: "#a3e635", 4: "#bef264", 5: "#fbbf24",
  6: "#fb923c", 7: "#f97316", 8: "#ef4444", 9: "#dc2626", 10: "#7f1d1d",
};

const FILTERS = ["All", "Featured", "Nearby", "Latest", "Top Rated"];

export default function DiscoverTab() {
  const [activeFilter, setActiveFilter] = useState("All");
  const [liked, setLiked] = useState<Set<number>>(new Set());

  const toggleLike = (id: number) => {
    setLiked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const filtered = activeFilter === "Featured"
    ? COMMUNITY_TRAILS.filter((t) => t.featured)
    : COMMUNITY_TRAILS;

  return (
    <div className="flex flex-col h-full overflow-y-auto">
      <div className="px-4 pt-4 pb-2">
        <h1 className="text-lg font-bold tracking-wide text-amber-400 uppercase" style={{ letterSpacing: "0.12em" }}>
          Discover
        </h1>
        <p className="text-xs text-stone-400 mt-0.5">Community trails from riders like you</p>
      </div>

      {/* Search Bar */}
      <div className="px-4 mb-3">
        <div className="relative">
          <svg
            viewBox="0 0 24 24"
            className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-stone-500"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <circle cx="11" cy="11" r="8" />
            <path d="m21 21-4.35-4.35" />
          </svg>
          <input
            type="text"
            placeholder="Search community trails..."
            className="w-full bg-[hsl(22,15%,11%)] border border-[hsl(30,12%,20%)] rounded-lg pl-9 pr-4 py-2.5 text-sm text-stone-200 placeholder:text-stone-500 focus:outline-none focus:border-amber-500/60 transition-colors"
          />
        </div>
      </div>

      {/* Filter Chips */}
      <div className="px-4 mb-3 flex gap-2 overflow-x-auto pb-1 no-scrollbar">
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

      {/* Trail Cards */}
      <div className="px-4 pb-6 space-y-3">
        {filtered.map((trail) => (
          <div
            key={trail.id}
            className="bg-[hsl(22,15%,11%)] border border-[hsl(30,12%,20%)] rounded-xl overflow-hidden hover:border-amber-500/20 transition-colors"
          >
            {/* Map Preview Strip */}
            <div className={`h-20 ${trail.preview} relative flex items-end p-2`}>
              {trail.featured && (
                <span className="absolute top-2 right-2 bg-amber-500 text-stone-900 text-[10px] font-bold px-2 py-0.5 rounded-full uppercase tracking-wider">
                  Featured
                </span>
              )}
              <div className="flex items-center gap-1.5">
                <div
                  className="w-5 h-5 rounded flex items-center justify-center text-[10px] font-bold text-black shrink-0"
                  style={{ backgroundColor: DIFFICULTY_COLORS[trail.difficulty] }}
                >
                  {trail.difficulty}
                </div>
                <span className="text-xs font-bold text-white/90">{trail.surface}</span>
              </div>
            </div>

            <div className="p-3">
              <div className="flex items-start justify-between mb-1">
                <h3 className="text-sm font-bold text-stone-100">{trail.name}</h3>
                <span className="text-[10px] text-stone-500 ml-2 shrink-0">{trail.posted}</span>
              </div>

              <div className="flex items-center gap-2 mb-2">
                <div className="w-5 h-5 rounded-full bg-gradient-to-br from-amber-600 to-amber-800 flex items-center justify-center text-[9px] font-bold text-white">
                  {trail.authorAvatar}
                </div>
                <span className="text-xs text-stone-400">{trail.author}</span>
                <span className="text-xs text-stone-600">·</span>
                <span className="text-xs text-stone-500">{trail.region}</span>
              </div>

              <div className="flex items-center gap-2 mb-2">
                <span className="text-xs text-stone-400 bg-stone-800/80 px-2 py-0.5 rounded">
                  {trail.distance}
                </span>
                {trail.tags.map((tag) => (
                  <span key={tag} className="text-xs text-stone-500 bg-stone-800/40 px-2 py-0.5 rounded">
                    {tag}
                  </span>
                ))}
              </div>

              <div className="flex items-center justify-between pt-2 border-t border-[hsl(30,12%,16%)]">
                <div className="flex items-center gap-3">
                  <button
                    onClick={() => toggleLike(trail.id)}
                    className="flex items-center gap-1 transition-colors"
                  >
                    <svg
                      viewBox="0 0 24 24"
                      className={`w-4 h-4 ${liked.has(trail.id) ? "fill-red-500 stroke-red-500" : "stroke-stone-500"}`}
                      fill="none"
                      strokeWidth="2"
                    >
                      <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" />
                    </svg>
                    <span className={`text-xs ${liked.has(trail.id) ? "text-red-400" : "text-stone-500"}`}>
                      {trail.likes + (liked.has(trail.id) ? 1 : 0)}
                    </span>
                  </button>
                  <div className="flex items-center gap-1">
                    <svg viewBox="0 0 24 24" className="w-4 h-4 stroke-stone-500" fill="none" strokeWidth="2">
                      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                    </svg>
                    <span className="text-xs text-stone-500">{trail.comments}</span>
                  </div>
                </div>
                <button className="text-xs text-amber-400 font-semibold hover:text-amber-300 transition-colors">
                  View Trail
                </button>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
