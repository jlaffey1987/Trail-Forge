import { useState } from "react";

interface TrailResult {
  id: number;
  name: string;
  distance: string;
  difficulty: number;
  elevation: string;
  surface: string;
  region: string;
  type: string;
  rating: number;
  reviews: number;
}

const SAMPLE_TRAILS: TrailResult[] = [
  {
    id: 1,
    name: "Black Mountain Ridge Loop",
    distance: "34.2 km",
    difficulty: 7,
    elevation: "+820m",
    surface: "Technical Enduro",
    region: "Peak District",
    type: "BOATs",
    rating: 4.8,
    reviews: 126,
  },
  {
    id: 2,
    name: "Shropshire Green Corridor",
    distance: "18.7 km",
    difficulty: 4,
    elevation: "+340m",
    surface: "Green Lane",
    region: "Shropshire Hills",
    type: "Green Lanes",
    rating: 4.5,
    reviews: 89,
  },
  {
    id: 3,
    name: "Dartmoor Crossing",
    distance: "52.1 km",
    difficulty: 8,
    elevation: "+1,240m",
    surface: "Extreme Enduro",
    region: "Dartmoor",
    type: "BOATs",
    rating: 4.9,
    reviews: 203,
  },
  {
    id: 4,
    name: "North Yorkshire Moors Trail",
    distance: "27.8 km",
    difficulty: 5,
    elevation: "+580m",
    surface: "Green Lane",
    region: "North Yorkshire",
    type: "Green Lanes",
    rating: 4.6,
    reviews: 147,
  },
];

const DIFFICULTY_COLORS: Record<number, string> = {
  1: "#4ade80",
  2: "#86efac",
  3: "#a3e635",
  4: "#bef264",
  5: "#fbbf24",
  6: "#fb923c",
  7: "#f97316",
  8: "#ef4444",
  9: "#dc2626",
  10: "#7f1d1d",
};

const DIFFICULTY_LABELS: Record<number, string> = {
  1: "Novice",
  2: "Easy",
  3: "Easy+",
  4: "Moderate",
  5: "Medium",
  6: "Hard",
  7: "Expert",
  8: "Extreme",
  9: "Pro",
  10: "Elite",
};

const BIKE_TYPES = ["Enduro", "Trail", "Adventure", "Trials", "MX", "Dual Sport"];

export default function PlannerTab() {
  const [startLocation, setStartLocation] = useState("");
  const [endLocation, setEndLocation] = useState("");
  const [difficulty, setDifficulty] = useState<number[]>([]);
  const [overlays, setOverlays] = useState({ boats: false, greenLanes: false });
  const [selectedBikes, setSelectedBikes] = useState<string[]>([]);
  const [results, setResults] = useState<TrailResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [savedTrails, setSavedTrails] = useState<Set<number>>(new Set());

  const toggleDifficulty = (level: number) => {
    setDifficulty((prev) =>
      prev.includes(level) ? prev.filter((d) => d !== level) : [...prev, level]
    );
  };

  const toggleBike = (bike: string) => {
    setSelectedBikes((prev) =>
      prev.includes(bike) ? prev.filter((b) => b !== bike) : [...prev, bike]
    );
  };

  const toggleOverlay = (key: "boats" | "greenLanes") => {
    setOverlays((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const handleSearch = () => {
    if (!startLocation && !endLocation) return;
    setSearching(true);
    setTimeout(() => {
      setResults(SAMPLE_TRAILS);
      setSearching(false);
    }, 1200);
  };

  const toggleSave = (id: number) => {
    setSavedTrails((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const DifficultyBadge = ({ level }: { level: number }) => (
    <span
      className="inline-flex items-center justify-center w-6 h-6 rounded text-xs font-bold text-black"
      style={{ backgroundColor: DIFFICULTY_COLORS[level] }}
    >
      {level}
    </span>
  );

  return (
    <div className="flex flex-col h-full overflow-y-auto">
      <div className="px-4 pt-4 pb-2">
        <h1 className="text-lg font-bold tracking-wide text-amber-400 uppercase" style={{ letterSpacing: "0.12em" }}>
          Trail Planner
        </h1>
        <p className="text-xs text-stone-400 mt-0.5">Plan your off-road adventure</p>
      </div>

      <div className="px-4 space-y-3 pb-4">
        {/* Location Inputs */}
        <div className="space-y-2">
          <div className="relative">
            <div className="absolute left-3 top-1/2 -translate-y-1/2 w-2 h-2 rounded-full bg-green-500"></div>
            <input
              type="text"
              placeholder="Start location..."
              value={startLocation}
              onChange={(e) => setStartLocation(e.target.value)}
              className="w-full bg-[hsl(22,15%,11%)] border border-[hsl(30,12%,20%)] rounded-lg pl-8 pr-4 py-3 text-sm text-stone-200 placeholder:text-stone-500 focus:outline-none focus:border-amber-500/60 focus:ring-1 focus:ring-amber-500/30 transition-colors"
            />
          </div>
          <div className="relative">
            <div className="absolute left-3 top-1/2 -translate-y-1/2 w-2 h-2 rounded-full bg-amber-500"></div>
            <input
              type="text"
              placeholder="End location (optional)..."
              value={endLocation}
              onChange={(e) => setEndLocation(e.target.value)}
              className="w-full bg-[hsl(22,15%,11%)] border border-[hsl(30,12%,20%)] rounded-lg pl-8 pr-4 py-3 text-sm text-stone-200 placeholder:text-stone-500 focus:outline-none focus:border-amber-500/60 focus:ring-1 focus:ring-amber-500/30 transition-colors"
            />
          </div>
        </div>

        {/* Difficulty Scale */}
        <div className="bg-[hsl(22,15%,11%)] border border-[hsl(30,12%,20%)] rounded-lg p-3">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-semibold text-stone-300 uppercase tracking-wider">Difficulty</span>
            {difficulty.length > 0 && (
              <span className="text-xs text-amber-400">
                {difficulty.length === 1
                  ? DIFFICULTY_LABELS[difficulty[0]]
                  : `${difficulty.length} selected`}
              </span>
            )}
          </div>
          <div className="flex gap-1.5">
            {Array.from({ length: 10 }, (_, i) => i + 1).map((level) => (
              <button
                key={level}
                onClick={() => toggleDifficulty(level)}
                className="flex-1 aspect-square rounded flex items-center justify-center text-xs font-bold transition-all"
                style={{
                  backgroundColor: difficulty.includes(level)
                    ? DIFFICULTY_COLORS[level]
                    : "hsl(22,15%,16%)",
                  color: difficulty.includes(level) ? "#000" : DIFFICULTY_COLORS[level],
                  border: `1px solid ${DIFFICULTY_COLORS[level]}40`,
                  transform: difficulty.includes(level) ? "scale(1.1)" : "scale(1)",
                }}
              >
                {level}
              </button>
            ))}
          </div>
          {difficulty.length > 0 && (
            <p className="text-[10px] text-stone-500 mt-2">
              {difficulty.sort((a, b) => a - b).map((d) => DIFFICULTY_LABELS[d]).join(" · ")}
            </p>
          )}
        </div>

        {/* Overlay Toggles */}
        <div className="bg-[hsl(22,15%,11%)] border border-[hsl(30,12%,20%)] rounded-lg p-3">
          <span className="text-xs font-semibold text-stone-300 uppercase tracking-wider block mb-2">
            Trail Types
          </span>
          <div className="flex gap-2">
            <button
              onClick={() => toggleOverlay("boats")}
              className={`flex-1 py-2.5 px-3 rounded-lg text-xs font-semibold border transition-all ${
                overlays.boats
                  ? "bg-amber-500 border-amber-400 text-stone-900"
                  : "bg-transparent border-stone-600 text-stone-400 hover:border-amber-600/50"
              }`}
            >
              BOATs
            </button>
            <button
              onClick={() => toggleOverlay("greenLanes")}
              className={`flex-1 py-2.5 px-3 rounded-lg text-xs font-semibold border transition-all ${
                overlays.greenLanes
                  ? "bg-green-600 border-green-500 text-white"
                  : "bg-transparent border-stone-600 text-stone-400 hover:border-green-600/50"
              }`}
            >
              Green Lanes
            </button>
          </div>
        </div>

        {/* Bike Type Chips */}
        <div className="bg-[hsl(22,15%,11%)] border border-[hsl(30,12%,20%)] rounded-lg p-3">
          <span className="text-xs font-semibold text-stone-300 uppercase tracking-wider block mb-2">
            Bike Type
          </span>
          <div className="flex flex-wrap gap-2">
            {BIKE_TYPES.map((bike) => (
              <button
                key={bike}
                onClick={() => toggleBike(bike)}
                className={`px-3 py-1.5 rounded-full text-xs font-medium border transition-all ${
                  selectedBikes.includes(bike)
                    ? "bg-amber-500/20 border-amber-500 text-amber-300"
                    : "bg-transparent border-stone-700 text-stone-400 hover:border-stone-500"
                }`}
              >
                {bike}
              </button>
            ))}
          </div>
        </div>

        {/* Find Trails Button */}
        <button
          onClick={handleSearch}
          disabled={!startLocation && !endLocation}
          className="w-full py-4 rounded-xl font-bold text-sm uppercase tracking-widest transition-all relative overflow-hidden disabled:opacity-40 disabled:cursor-not-allowed"
          style={{
            background: "linear-gradient(135deg, #d4870c 0%, #f0a832 50%, #d4870c 100%)",
            backgroundSize: "200% 100%",
            color: "#1a0e05",
          }}
        >
          {searching ? (
            <span className="flex items-center justify-center gap-2">
              <span className="w-4 h-4 border-2 border-stone-900/50 border-t-stone-900 rounded-full animate-spin"></span>
              Searching Trails...
            </span>
          ) : (
            "Find Trails"
          )}
        </button>
      </div>

      {/* Results */}
      {results.length > 0 && (
        <div className="px-4 pb-6">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-bold text-stone-300 uppercase tracking-wider">
              {results.length} Trails Found
            </h2>
            <span className="text-xs text-stone-500">Sorted by rating</span>
          </div>
          <div className="space-y-3">
            {results.map((trail) => (
              <div
                key={trail.id}
                className="bg-[hsl(22,15%,11%)] border border-[hsl(30,12%,20%)] rounded-xl overflow-hidden hover:border-amber-500/30 transition-colors"
              >
                <div className="p-3">
                  <div className="flex items-start justify-between mb-2">
                    <div className="flex-1">
                      <h3 className="text-sm font-bold text-stone-100 leading-tight">{trail.name}</h3>
                      <p className="text-xs text-stone-500 mt-0.5">{trail.region}</p>
                    </div>
                    <button
                      onClick={() => toggleSave(trail.id)}
                      className="ml-2 p-1.5 rounded-lg transition-colors"
                    >
                      <svg
                        viewBox="0 0 24 24"
                        className="w-4 h-4"
                        fill={savedTrails.has(trail.id) ? "#f0a832" : "none"}
                        stroke={savedTrails.has(trail.id) ? "#f0a832" : "#6b7280"}
                        strokeWidth="2"
                      >
                        <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
                      </svg>
                    </button>
                  </div>

                  <div className="flex items-center gap-2 flex-wrap">
                    <DifficultyBadge level={trail.difficulty} />
                    <span className="text-xs text-stone-400 bg-stone-800/80 px-2 py-0.5 rounded">
                      {trail.distance}
                    </span>
                    <span className="text-xs text-green-400 bg-green-900/30 px-2 py-0.5 rounded">
                      {trail.elevation}
                    </span>
                    <span
                      className={`text-xs px-2 py-0.5 rounded ${
                        trail.type === "BOATs"
                          ? "text-amber-300 bg-amber-900/30"
                          : "text-green-300 bg-green-900/30"
                      }`}
                    >
                      {trail.type}
                    </span>
                  </div>

                  <div className="mt-2 flex items-center justify-between">
                    <span className="text-xs text-stone-400">{trail.surface}</span>
                    <div className="flex items-center gap-1">
                      <svg viewBox="0 0 24 24" className="w-3 h-3 fill-amber-400">
                        <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
                      </svg>
                      <span className="text-xs font-semibold text-amber-400">{trail.rating}</span>
                      <span className="text-xs text-stone-500">({trail.reviews})</span>
                    </div>
                  </div>
                </div>

                <div className="border-t border-[hsl(30,12%,16%)] flex">
                  <button className="flex-1 py-2 text-xs text-amber-400 font-semibold hover:bg-amber-500/10 transition-colors">
                    View Route
                  </button>
                  <div className="w-px bg-[hsl(30,12%,16%)]"></div>
                  <button className="flex-1 py-2 text-xs text-green-400 font-semibold hover:bg-green-500/10 transition-colors">
                    Navigate
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
