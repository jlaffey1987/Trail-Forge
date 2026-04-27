import { useState } from "react";
import { searchTrails, saveTrail, getSessionId, type Trail } from "@/lib/supabase";
import RouteBuilder from "@/components/RouteBuilder";
import NavigationView from "@/components/NavigationView";
import {
  geocode,
  assembleMultiModalRoute,
  type GeoPoint,
  type AssembledRoute,
} from "@/lib/routing";

const DIFFICULTY_COLORS: Record<number, string> = {
  1: "#4ade80", 2: "#86efac", 3: "#a3e635", 4: "#bef264", 5: "#fbbf24",
  6: "#fb923c", 7: "#f97316", 8: "#ef4444", 9: "#dc2626", 10: "#7f1d1d",
};

const DIFFICULTY_LABELS: Record<number, string> = {
  1: "Novice", 2: "Easy", 3: "Easy+", 4: "Moderate", 5: "Medium",
  6: "Hard", 7: "Expert", 8: "Extreme", 9: "Pro", 10: "Elite",
};

const BIKE_TYPES = ["Enduro", "Trail", "Adventure", "Trials", "MX", "Dual Sport"];

function formatDistance(km: number | null) {
  return km != null ? `${km.toFixed(1)} km` : "—";
}

export default function PlannerTab() {
  const [startLocation, setStartLocation] = useState("");
  const [endLocation, setEndLocation] = useState("");
  const [difficulty, setDifficulty] = useState<number[]>([]);
  const [overlays, setOverlays] = useState({ boats: false, greenLanes: false });
  const [selectedBikes, setSelectedBikes] = useState<string[]>([]);
  const [results, setResults] = useState<Trail[]>([]);
  const [searching, setSearching] = useState(false);
  const [savedIds, setSavedIds] = useState<Set<string>>(new Set());
  const [saveStatus, setSaveStatus] = useState<Record<string, "saving" | "saved" | "error">>({});

  // Route linking state
  const [routeTrails, setRouteTrails] = useState<Trail[]>([]);
  const [showRouteBuilder, setShowRouteBuilder] = useState(false);

  // Full trip navigation state
  const [planningTrip, setPlanningTrip] = useState(false);
  const [planProgress, setPlanProgress] = useState<{ step: number; total: number; label: string } | null>(null);
  const [planError, setPlanError] = useState<string | null>(null);
  const [assembledRoute, setAssembledRoute] = useState<AssembledRoute | null>(null);
  const [showNav, setShowNav] = useState(false);
  const [highlightInputs, setHighlightInputs] = useState(false);
  // Cache geocoded points so we don't re-geocode if unchanged
  const [geocodedStart, setGeocodedStart] = useState<{ q: string; pt: GeoPoint } | null>(null);
  const [geocodedEnd, setGeocodedEnd] = useState<{ q: string; pt: GeoPoint } | null>(null);

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

  const handleSearch = async () => {
    setSearching(true);
    const trailTypes: string[] = [];
    if (overlays.boats) trailTypes.push("BOAT");
    if (overlays.greenLanes) trailTypes.push("Green Lane");

    const data = await searchTrails({
      difficulties: difficulty.length > 0 ? difficulty : undefined,
      trailTypes: trailTypes.length > 0 ? trailTypes : undefined,
    });
    setResults(data);
    setSearching(false);
  };

  const handleSave = async (trail: Trail) => {
    setSaveStatus((p) => ({ ...p, [trail.id]: "saving" }));
    const sessionId = getSessionId();
    const ok = await saveTrail(trail.id, sessionId);
    if (ok) {
      setSavedIds((prev) => new Set([...prev, trail.id]));
      setSaveStatus((p) => ({ ...p, [trail.id]: "saved" }));
    } else {
      setSaveStatus((p) => ({ ...p, [trail.id]: "error" }));
    }
  };

  // Route trail linking
  const isInRoute = (id: string) => routeTrails.some((t) => t.id === id);

  const toggleRouteTrail = (trail: Trail) => {
    if (isInRoute(trail.id)) {
      setRouteTrails((prev) => prev.filter((t) => t.id !== trail.id));
    } else {
      setRouteTrails((prev) => [...prev, trail]);
    }
  };

  const removeFromRoute = (id: string) => {
    setRouteTrails((prev) => prev.filter((t) => t.id !== id));
  };

  const totalRouteKm = routeTrails.reduce((s, t) => s + (t.distance_km ?? 0), 0);

  // ============================================================
  // PLAN FULL TRIP — geocodes start/end and assembles road+trail route
  // ============================================================
  const handlePlanTrip = async () => {
    if (planningTrip) return; // Guard against re-entry
    setPlanError(null);

    const missingStart = !startLocation.trim();
    const missingEnd = !endLocation.trim();
    if (missingStart || missingEnd) {
      setHighlightInputs(true);
      const which = missingStart && missingEnd ? "start address and destination" : missingStart ? "start address" : "destination";
      setPlanError(`Please enter your ${which} above to plan navigation.`);
      const container = document.querySelector(".overflow-y-auto");
      if (container) container.scrollTo({ top: 0, behavior: "smooth" });
      setTimeout(() => setHighlightInputs(false), 3000);
      return;
    }

    if (routeTrails.length === 0) {
      setPlanError("Add at least one trail to your route before planning navigation.");
      return;
    }

    setPlanningTrip(true);
    setPlanProgress({ step: 0, total: 100, label: "Looking up start address..." });

    try {
      // Geocode start
      let startPt: GeoPoint | null = null;
      if (geocodedStart && geocodedStart.q === startLocation.trim()) {
        startPt = geocodedStart.pt;
      } else {
        startPt = await geocode(startLocation);
        if (startPt) setGeocodedStart({ q: startLocation.trim(), pt: startPt });
      }
      if (!startPt) {
        setPlanError(`Could not find "${startLocation}". Try a more specific address (e.g. include town and postcode).`);
        setPlanningTrip(false);
        setPlanProgress(null);
        return;
      }

      setPlanProgress({ step: 10, total: 100, label: "Looking up destination..." });

      // Geocode end
      let endPt: GeoPoint | null = null;
      if (geocodedEnd && geocodedEnd.q === endLocation.trim()) {
        endPt = geocodedEnd.pt;
      } else {
        endPt = await geocode(endLocation);
        if (endPt) setGeocodedEnd({ q: endLocation.trim(), pt: endPt });
      }
      if (!endPt) {
        setPlanError(`Could not find "${endLocation}". Try a more specific address.`);
        setPlanningTrip(false);
        setPlanProgress(null);
        return;
      }

      // Assemble route
      const route = await assembleMultiModalRoute(startPt, endPt, routeTrails, (step, total, label) => {
        const pct = 20 + Math.round((step / total) * 75);
        setPlanProgress({ step: pct, total: 100, label });
      });

      if (route.sections.length === 0) {
        setPlanError("Could not build a route. Check your trails have valid GPX data.");
        setPlanningTrip(false);
        setPlanProgress(null);
        return;
      }

      setAssembledRoute(route);
      setShowNav(true);
      setShowRouteBuilder(false);
    } catch (e) {
      setPlanError("Network error while planning trip. Please try again.");
    }
    setPlanningTrip(false);
    setPlanProgress(null);
  };

  return (
    <div className="flex flex-col h-full relative">
      <div className="flex-1 overflow-y-auto pb-2" style={{ paddingBottom: routeTrails.length > 0 ? "120px" : "0" }}>
        <div className="px-4 pt-4 pb-2">
          <h1 className="text-lg font-bold tracking-wide text-amber-400 uppercase" style={{ letterSpacing: "0.12em" }}>
            Trail Planner
          </h1>
          <p className="text-xs text-stone-400 mt-0.5">Address-to-address trip with road + trail navigation</p>
        </div>

        <div className="px-4 space-y-3 pb-4">
          {/* Location Inputs */}
          <div className={`space-y-2 transition-all ${highlightInputs ? "animate-pulse" : ""}`}>
            <div className="relative">
              <div className="absolute left-3 top-1/2 -translate-y-1/2 w-2 h-2 rounded-full bg-green-500"></div>
              <input
                type="text"
                placeholder="Start address (e.g. 9 High Street, Stranraer)"
                value={startLocation}
                onChange={(e) => { setStartLocation(e.target.value); setPlanError(null); }}
                className={`w-full bg-[hsl(22,15%,11%)] border rounded-lg pl-8 pr-4 py-3 text-sm text-stone-200 placeholder:text-stone-500 focus:outline-none focus:ring-1 transition-colors ${
                  highlightInputs ? "border-amber-500 ring-1 ring-amber-500/50" : "border-[hsl(30,12%,20%)] focus:border-amber-500/60 focus:ring-amber-500/30"
                }`}
              />
              {geocodedStart && geocodedStart.q === startLocation.trim() && (
                <div className="absolute right-3 top-1/2 -translate-y-1/2 text-green-400">
                  <svg viewBox="0 0 24 24" className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2.5">
                    <polyline points="20 6 9 17 4 12"/>
                  </svg>
                </div>
              )}
            </div>
            <div className="relative">
              <div className="absolute left-3 top-1/2 -translate-y-1/2 w-2 h-2 rounded-full bg-amber-500"></div>
              <input
                type="text"
                placeholder="Destination (e.g. ABR Festival, Ravenstone Manor)"
                value={endLocation}
                onChange={(e) => { setEndLocation(e.target.value); setPlanError(null); }}
                className={`w-full bg-[hsl(22,15%,11%)] border rounded-lg pl-8 pr-4 py-3 text-sm text-stone-200 placeholder:text-stone-500 focus:outline-none focus:ring-1 transition-colors ${
                  highlightInputs ? "border-amber-500 ring-1 ring-amber-500/50" : "border-[hsl(30,12%,20%)] focus:border-amber-500/60 focus:ring-amber-500/30"
                }`}
              />
              {geocodedEnd && geocodedEnd.q === endLocation.trim() && (
                <div className="absolute right-3 top-1/2 -translate-y-1/2 text-green-400">
                  <svg viewBox="0 0 24 24" className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2.5">
                    <polyline points="20 6 9 17 4 12"/>
                  </svg>
                </div>
              )}
            </div>
            {(geocodedStart || geocodedEnd) && (
              <div className="text-[10px] text-stone-500 px-1 space-y-0.5">
                {geocodedStart && geocodedStart.q === startLocation.trim() && (
                  <p>📍 Start: {geocodedStart.pt.label?.split(",").slice(0, 3).join(",")}</p>
                )}
                {geocodedEnd && geocodedEnd.q === endLocation.trim() && (
                  <p>🏁 End: {geocodedEnd.pt.label?.split(",").slice(0, 3).join(",")}</p>
                )}
              </div>
            )}
          </div>

          {/* Difficulty Scale */}
          <div className="bg-[hsl(22,15%,11%)] border border-[hsl(30,12%,20%)] rounded-lg p-3">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-semibold text-stone-300 uppercase tracking-wider">Difficulty</span>
              {difficulty.length > 0 && (
                <span className="text-xs text-amber-400">
                  {difficulty.length === 1 ? DIFFICULTY_LABELS[difficulty[0]] : `${difficulty.length} selected`}
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
                    backgroundColor: difficulty.includes(level) ? DIFFICULTY_COLORS[level] : "hsl(22,15%,16%)",
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
            <span className="text-xs font-semibold text-stone-300 uppercase tracking-wider block mb-2">Trail Types</span>
            <div className="flex gap-2">
              <button
                onClick={() => toggleOverlay("boats")}
                className={`flex-1 py-2.5 px-3 rounded-lg text-xs font-semibold border transition-all ${
                  overlays.boats ? "bg-amber-500 border-amber-400 text-stone-900" : "bg-transparent border-stone-600 text-stone-400 hover:border-amber-600/50"
                }`}
              >
                BOATs
              </button>
              <button
                onClick={() => toggleOverlay("greenLanes")}
                className={`flex-1 py-2.5 px-3 rounded-lg text-xs font-semibold border transition-all ${
                  overlays.greenLanes ? "bg-green-600 border-green-500 text-white" : "bg-transparent border-stone-600 text-stone-400 hover:border-green-600/50"
                }`}
              >
                Green Lanes
              </button>
            </div>
          </div>

          {/* Bike Type Chips */}
          <div className="bg-[hsl(22,15%,11%)] border border-[hsl(30,12%,20%)] rounded-lg p-3">
            <span className="text-xs font-semibold text-stone-300 uppercase tracking-wider block mb-2">Bike Type</span>
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
            className="w-full py-4 rounded-xl font-bold text-sm uppercase tracking-widest transition-all flex items-center justify-center gap-2"
            style={{ background: "linear-gradient(135deg, #d4870c 0%, #f0a832 50%, #d4870c 100%)", color: "#1a0e05" }}
          >
            {searching ? (
              <>
                <span className="w-4 h-4 border-2 border-stone-900/50 border-t-stone-900 rounded-full animate-spin"></span>
                Searching Supabase...
              </>
            ) : "Find Trails"}
          </button>
        </div>

        {/* Results */}
        {results.length > 0 && (
          <div className="px-4 pb-6">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-sm font-bold text-stone-300 uppercase tracking-wider">
                {results.length} Trails Found
              </h2>
              <div className="flex items-center gap-2">
                {routeTrails.length > 0 && (
                  <span className="text-[10px] text-amber-400 font-medium">
                    {routeTrails.length} in route
                  </span>
                )}
                <div className="flex items-center gap-1">
                  <div className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse"></div>
                  <span className="text-xs text-stone-500">Live</span>
                </div>
              </div>
            </div>

            {/* Route linking hint */}
            {routeTrails.length === 0 && (
              <div className="mb-3 bg-amber-500/10 border border-amber-500/20 rounded-lg px-3 py-2 flex items-center gap-2">
                <svg viewBox="0 0 24 24" className="w-4 h-4 text-amber-400 shrink-0" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>
                  <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>
                </svg>
                <p className="text-[11px] text-amber-300">
                  Tap <span className="font-bold">+ Add to Route</span> on any trail to plan your full road-to-trail trip
                </p>
              </div>
            )}

            <div className="space-y-3">
              {results.map((trail) => {
                const diff = trail.difficulty ?? 5;
                const isSaved = savedIds.has(trail.id);
                const status = saveStatus[trail.id];
                const inRoute = isInRoute(trail.id);
                const routeIndex = routeTrails.findIndex((t) => t.id === trail.id);

                return (
                  <div
                    key={trail.id}
                    className={`bg-[hsl(22,15%,11%)] rounded-xl overflow-hidden transition-all ${
                      inRoute
                        ? "border-2 border-amber-500/60 shadow-lg shadow-amber-900/20"
                        : "border border-[hsl(30,12%,20%)]"
                    }`}
                  >
                    <div className="p-3">
                      <div className="flex items-start justify-between mb-2">
                        <div className="flex-1">
                          <div className="flex items-center gap-1.5 mb-0.5">
                            {inRoute && (
                              <span className="w-5 h-5 rounded-full bg-amber-500 text-stone-900 flex items-center justify-center text-[10px] font-black shrink-0">
                                {routeIndex + 1}
                              </span>
                            )}
                            <h3 className="text-sm font-bold text-stone-100 leading-tight">{trail.name}</h3>
                          </div>
                          <p className="text-xs text-stone-500">{trail.terrain || "Off-road"}</p>
                        </div>
                        <button
                          onClick={() => !isSaved && handleSave(trail)}
                          disabled={isSaved || status === "saving"}
                          className="ml-2 p-1.5 rounded-lg transition-colors"
                        >
                          {status === "saving" ? (
                            <span className="w-4 h-4 border border-amber-500/50 border-t-amber-500 rounded-full animate-spin block"></span>
                          ) : (
                            <svg viewBox="0 0 24 24" className="w-4 h-4" fill={isSaved ? "#f0a832" : "none"} stroke={isSaved ? "#f0a832" : "#6b7280"} strokeWidth="2">
                              <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
                            </svg>
                          )}
                        </button>
                      </div>

                      <div className="flex items-center gap-2 flex-wrap mb-3">
                        <span
                          className="inline-flex items-center justify-center w-6 h-6 rounded text-xs font-bold text-black"
                          style={{ backgroundColor: DIFFICULTY_COLORS[diff] ?? "#fbbf24" }}
                        >
                          {diff}
                        </span>
                        <span className="text-xs text-stone-400 bg-stone-800/80 px-2 py-0.5 rounded">
                          {formatDistance(trail.distance_km)}
                        </span>
                        <span className={`text-xs px-2 py-0.5 rounded ${
                          trail.legal_status === "BOAT"
                            ? "text-amber-300 bg-amber-900/30"
                            : "text-green-300 bg-green-900/30"
                        }`}>
                          {trail.legal_status || "Trail"}
                        </span>
                      </div>

                      <button
                        onClick={() => toggleRouteTrail(trail)}
                        className={`w-full py-2 rounded-lg text-xs font-bold border transition-all flex items-center justify-center gap-1.5 ${
                          inRoute
                            ? "bg-amber-500/15 border-amber-500/50 text-amber-400 hover:bg-red-900/20 hover:border-red-500/40 hover:text-red-400"
                            : "bg-transparent border-stone-700 text-stone-400 hover:border-amber-500/50 hover:text-amber-400 hover:bg-amber-500/5"
                        }`}
                      >
                        {inRoute ? (
                          <>
                            <svg viewBox="0 0 24 24" className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2.5">
                              <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>
                              <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>
                            </svg>
                            Trail #{routeIndex + 1} in Route · Tap to Remove
                          </>
                        ) : (
                          <>
                            <svg viewBox="0 0 24 24" className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2.5">
                              <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
                            </svg>
                            Add to Route
                          </>
                        )}
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {results.length === 0 && !searching && (
          <div className="px-4 text-center py-4">
            <p className="text-xs text-stone-600">Tap Find Trails to search live trails</p>
          </div>
        )}
      </div>

      {/* Route Bar — sticky above bottom nav */}
      {routeTrails.length > 0 && (
        <div
          className="absolute bottom-0 left-0 right-0 z-10 px-3 pb-3 pt-3"
          style={{ background: "linear-gradient(to top, hsl(22,15%,7%) 75%, transparent)" }}
        >
          {/* Plan error */}
          {planError && (
            <div className="mb-2 bg-red-900/30 border border-red-600/50 rounded-lg px-3 py-2 flex items-start gap-2">
              <svg viewBox="0 0 24 24" className="w-4 h-4 text-red-400 shrink-0 mt-0.5" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
              </svg>
              <p className="text-[11px] text-red-200 leading-tight">{planError}</p>
              <button onClick={() => setPlanError(null)} className="text-red-400 ml-1">×</button>
            </div>
          )}

          {/* Plan progress */}
          {planningTrip && planProgress && (
            <div className="mb-2 bg-[hsl(22,15%,12%)] border border-amber-500/40 rounded-lg px-3 py-2.5">
              <div className="flex items-center gap-2 mb-1.5">
                <span className="w-3 h-3 border-2 border-amber-500/30 border-t-amber-500 rounded-full animate-spin"></span>
                <p className="text-[11px] font-bold text-amber-300">{planProgress.label}</p>
              </div>
              <div className="h-1 bg-stone-800 rounded-full overflow-hidden">
                <div
                  className="h-full bg-gradient-to-r from-amber-500 to-amber-300 transition-all duration-300"
                  style={{ width: `${planProgress.step}%` }}
                ></div>
              </div>
            </div>
          )}

          {/* Route summary header */}
          <div className="flex items-center gap-2 px-3 py-2 mb-1.5 rounded-t-xl"
               style={{ background: "linear-gradient(135deg, hsl(22,15%,14%) 0%, hsl(22,15%,16%) 100%)", borderTop: "1.5px solid #d4870c60", borderLeft: "1.5px solid #d4870c60", borderRight: "1.5px solid #d4870c60" }}>
            <div className="w-7 h-7 rounded-md bg-amber-500/15 flex items-center justify-center shrink-0">
              <svg viewBox="0 0 24 24" className="w-4 h-4 text-amber-400" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>
                <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>
              </svg>
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-[11px] font-black text-amber-400 uppercase tracking-wider">
                {routeTrails.length} Trail{routeTrails.length !== 1 ? "s" : ""} · {totalRouteKm.toFixed(1)} km off-road
              </div>
              <div className="text-[10px] text-stone-400 mt-0.5 truncate">
                {routeTrails.map((t) => t.name).slice(0, 2).join(" → ")}
                {routeTrails.length > 2 ? ` → +${routeTrails.length - 2} more` : ""}
              </div>
            </div>
            <div className="flex items-center gap-1 shrink-0">
              {routeTrails.slice(0, 3).map((t, i) => (
                <div
                  key={t.id}
                  className="w-5 h-5 rounded-full flex items-center justify-center text-[9px] font-black text-stone-900"
                  style={{ backgroundColor: DIFFICULTY_COLORS[t.difficulty ?? 5] ?? "#fbbf24" }}
                >
                  {i + 1}
                </div>
              ))}
            </div>
          </div>

          {/* Two action buttons */}
          <div className="grid grid-cols-2 gap-1.5"
               style={{ borderBottom: "1.5px solid #d4870c60", borderLeft: "1.5px solid #d4870c60", borderRight: "1.5px solid #d4870c60", borderBottomLeftRadius: "12px", borderBottomRightRadius: "12px", padding: "0 8px 8px", background: "hsl(22,15%,14%)" }}>
            <button
              onClick={() => setShowRouteBuilder(true)}
              disabled={planningTrip}
              className="py-2.5 rounded-lg text-[11px] font-bold uppercase tracking-wider border border-stone-700 bg-stone-900/40 text-stone-300 hover:border-stone-500 hover:text-stone-100 transition-all flex items-center justify-center gap-1.5 disabled:opacity-50"
            >
              <svg viewBox="0 0 24 24" className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2.5">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                <polyline points="7 10 12 15 17 10"/>
                <line x1="12" y1="15" x2="12" y2="3"/>
              </svg>
              Build GPX
            </button>
            <button
              onClick={handlePlanTrip}
              disabled={planningTrip}
              className="py-2.5 rounded-lg text-[11px] font-black uppercase tracking-wider transition-all flex items-center justify-center gap-1.5 text-stone-900 disabled:opacity-50 shadow-lg shadow-amber-900/30"
              style={{ background: "linear-gradient(135deg, #d4870c 0%, #f0a832 50%, #d4870c 100%)" }}
            >
              {planningTrip ? (
                <span className="w-3.5 h-3.5 border-2 border-stone-900/50 border-t-stone-900 rounded-full animate-spin"></span>
              ) : (
                <svg viewBox="0 0 24 24" className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <polygon points="3 11 22 2 13 21 11 13 3 11"/>
                </svg>
              )}
              Plan Trip Nav
            </button>
          </div>
        </div>
      )}

      {/* Route Builder Sheet */}
      {showRouteBuilder && (
        <RouteBuilder
          selectedTrails={routeTrails}
          onReorder={setRouteTrails}
          onRemove={removeFromRoute}
          onClose={() => setShowRouteBuilder(false)}
        />
      )}

      {/* Full Trip Navigation */}
      {showNav && assembledRoute && (
        <NavigationView
          route={assembledRoute}
          onClose={() => setShowNav(false)}
        />
      )}
    </div>
  );
}
