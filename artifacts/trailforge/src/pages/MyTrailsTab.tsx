import { useState } from "react";

interface SavedTrail {
  id: number;
  name: string;
  date: string;
  distance: string;
  duration: string;
  difficulty: number;
  region: string;
  waypoints: number;
  status: "completed" | "planned" | "in-progress";
}

const SAVED_TRAILS: SavedTrail[] = [
  {
    id: 1,
    name: "Peak District Loop",
    date: "18 Apr 2026",
    distance: "47.3 km",
    duration: "3h 20m",
    difficulty: 7,
    region: "Peak District",
    waypoints: 12,
    status: "completed",
  },
  {
    id: 2,
    name: "Shropshire Hills Blast",
    date: "12 Apr 2026",
    distance: "29.1 km",
    duration: "2h 05m",
    difficulty: 5,
    region: "Shropshire",
    waypoints: 8,
    status: "completed",
  },
  {
    id: 3,
    name: "Dartmoor Epic",
    date: "Scheduled 1 May 2026",
    distance: "62.4 km",
    duration: "Est. 5h",
    difficulty: 9,
    region: "Dartmoor",
    waypoints: 18,
    status: "planned",
  },
];

const DIFFICULTY_COLORS: Record<number, string> = {
  1: "#4ade80", 2: "#86efac", 3: "#a3e635", 4: "#bef264", 5: "#fbbf24",
  6: "#fb923c", 7: "#f97316", 8: "#ef4444", 9: "#dc2626", 10: "#7f1d1d",
};

const STATUS_CONFIG = {
  completed: { label: "Completed", color: "text-green-400", bg: "bg-green-900/30" },
  planned: { label: "Planned", color: "text-amber-400", bg: "bg-amber-900/30" },
  "in-progress": { label: "In Progress", color: "text-blue-400", bg: "bg-blue-900/30" },
};

export default function MyTrailsTab() {
  const [filter, setFilter] = useState<"all" | "completed" | "planned">("all");
  const [expandedId, setExpandedId] = useState<number | null>(null);

  const filtered = SAVED_TRAILS.filter(
    (t) => filter === "all" || t.status === filter
  );

  const totalKm = SAVED_TRAILS.filter((t) => t.status === "completed")
    .reduce((sum, t) => sum + parseFloat(t.distance), 0)
    .toFixed(1);

  return (
    <div className="flex flex-col h-full overflow-y-auto">
      <div className="px-4 pt-4 pb-2">
        <h1 className="text-lg font-bold tracking-wide text-amber-400 uppercase" style={{ letterSpacing: "0.12em" }}>
          My Trails
        </h1>
      </div>

      {/* Stats Bar */}
      <div className="mx-4 mb-3 bg-[hsl(22,15%,11%)] border border-[hsl(30,12%,20%)] rounded-xl p-3">
        <div className="grid grid-cols-3 gap-3">
          <div className="text-center">
            <div className="text-xl font-bold text-amber-400">{totalKm}</div>
            <div className="text-[10px] text-stone-500 uppercase tracking-wider mt-0.5">Total km</div>
          </div>
          <div className="text-center border-x border-[hsl(30,12%,20%)]">
            <div className="text-xl font-bold text-amber-400">
              {SAVED_TRAILS.filter((t) => t.status === "completed").length}
            </div>
            <div className="text-[10px] text-stone-500 uppercase tracking-wider mt-0.5">Completed</div>
          </div>
          <div className="text-center">
            <div className="text-xl font-bold text-amber-400">
              {SAVED_TRAILS.filter((t) => t.status === "planned").length}
            </div>
            <div className="text-[10px] text-stone-500 uppercase tracking-wider mt-0.5">Planned</div>
          </div>
        </div>
      </div>

      {/* Filter Tabs */}
      <div className="px-4 mb-3 flex gap-1.5">
        {(["all", "completed", "planned"] as const).map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`flex-1 py-1.5 px-2 rounded-lg text-xs font-semibold capitalize transition-all ${
              filter === f
                ? "bg-amber-500 text-stone-900"
                : "bg-[hsl(22,15%,14%)] text-stone-400 border border-[hsl(30,12%,20%)]"
            }`}
          >
            {f === "all" ? "All" : f.charAt(0).toUpperCase() + f.slice(1)}
          </button>
        ))}
      </div>

      {/* Trail List */}
      <div className="px-4 pb-6 space-y-3">
        {filtered.length === 0 ? (
          <div className="text-center py-12">
            <div className="text-4xl mb-3">🏍</div>
            <p className="text-stone-500 text-sm">No trails here yet.</p>
            <p className="text-stone-600 text-xs mt-1">Save trails from the Planner tab</p>
          </div>
        ) : (
          filtered.map((trail) => {
            const status = STATUS_CONFIG[trail.status];
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
                          className="w-5 h-5 rounded text-xs font-bold text-black flex items-center justify-center"
                          style={{ backgroundColor: DIFFICULTY_COLORS[trail.difficulty] }}
                        >
                          {trail.difficulty}
                        </span>
                        <h3 className="text-sm font-bold text-stone-100">{trail.name}</h3>
                      </div>
                      <p className="text-xs text-stone-500">{trail.date}</p>
                    </div>
                    <div className="flex flex-col items-end gap-1">
                      <span className={`text-[10px] px-2 py-0.5 rounded-full font-medium ${status.color} ${status.bg}`}>
                        {status.label}
                      </span>
                      <svg
                        viewBox="0 0 24 24"
                        className={`w-4 h-4 text-stone-500 transition-transform ${isExpanded ? "rotate-180" : ""}`}
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                      >
                        <polyline points="6 9 12 15 18 9" />
                      </svg>
                    </div>
                  </div>

                  <div className="flex gap-3 mt-2">
                    <span className="text-xs text-stone-400">{trail.distance}</span>
                    <span className="text-xs text-stone-600">·</span>
                    <span className="text-xs text-stone-400">{trail.duration}</span>
                    <span className="text-xs text-stone-600">·</span>
                    <span className="text-xs text-stone-400">{trail.region}</span>
                  </div>
                </button>

                {isExpanded && (
                  <div className="border-t border-[hsl(30,12%,16%)] p-3">
                    <div className="grid grid-cols-2 gap-2 mb-3">
                      <div className="bg-[hsl(22,15%,14%)] rounded-lg p-2">
                        <div className="text-xs text-stone-500 mb-0.5">Waypoints</div>
                        <div className="text-sm font-bold text-amber-400">{trail.waypoints}</div>
                      </div>
                      <div className="bg-[hsl(22,15%,14%)] rounded-lg p-2">
                        <div className="text-xs text-stone-500 mb-0.5">Region</div>
                        <div className="text-sm font-bold text-stone-300">{trail.region}</div>
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
