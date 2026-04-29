import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation } from "wouter";
import { searchTrails, saveTrail, type Trail } from "@/lib/supabase";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import RouteBuilder from "@/components/RouteBuilder";
import NavigationView from "@/components/NavigationView";
import PlannerMap from "@/components/PlannerMap";
import TrailDetailSheet from "@/components/TrailDetailSheet";
import {
  geocode,
  assembleMultiModalRoute,
  type GeoPoint,
  type AssembledRoute,
} from "@/lib/routing";
import { useRouteTrails } from "@/lib/plannerRouteStore";

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
  const { isSignedIn, userId } = useCurrentUser();
  const [, setLocation] = useLocation();
  const [signInPromptForTrail, setSignInPromptForTrail] = useState<string | null>(null);
  const [startLocation, setStartLocation] = useState("");
  const [endLocation, setEndLocation] = useState("");
  const [difficulty, setDifficulty] = useState<number[]>([]);
  const [overlays, setOverlays] = useState({ boats: false, greenLanes: false });
  const [selectedBikes, setSelectedBikes] = useState<string[]>([]);
  const [results, setResults] = useState<Trail[]>([]);
  const [searching, setSearching] = useState(false);
  const [savedIds, setSavedIds] = useState<Set<string>>(new Set());
  const [saveStatus, setSaveStatus] = useState<Record<string, "saving" | "saved" | "error">>({});

  // Route linking state — backed by a shared store so trails added from the
  // Map tab also appear here.
  const [routeTrails, setRouteTrails] = useRouteTrails();
  const [showRouteBuilder, setShowRouteBuilder] = useState(false);

  // Currently-open trail detail sheet (opened by tapping a search-result
  // card's name). Tracked separately from the result list so prev/next
  // arrows in the sheet can walk the search results in order.
  const [detailTrail, setDetailTrail] = useState<Trail | null>(null);

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

  // Geocode request sequence tokens (per field) to discard stale responses
  const startSeqRef = useRef(0);
  const endSeqRef = useRef(0);
  // Ref for the start address input so we can focus it after the Map tab
  // hands off via "Build Route".
  const startInputRef = useRef<HTMLInputElement | null>(null);

  // Mount-effect handoff from the Map tab's "Build Route" button. App.tsx
  // sets `?build=1` before switching to this tab; if a route is loaded,
  // highlight the address inputs, scroll the form into view, and focus the
  // start input so the user can type immediately. Then strip the param.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    if (params.get("build") !== "1") return;
    const cleanup = () => {
      params.delete("build");
      const qs = params.toString();
      const newUrl =
        window.location.pathname +
        (qs ? `?${qs}` : "") +
        window.location.hash;
      window.history.replaceState(null, "", newUrl);
    };
    if (routeTrails.length === 0) {
      // Nothing to plan — silently drop the param.
      cleanup();
      return;
    }
    setHighlightInputs(true);
    setPlanError(null);
    // Scroll the address inputs into view and focus the first empty one.
    requestAnimationFrame(() => {
      const container = document.querySelector(".overflow-y-auto");
      if (container) container.scrollTo({ top: 0, behavior: "smooth" });
      const target = startInputRef.current;
      if (target && !startLocation.trim()) target.focus();
    });
    const t = window.setTimeout(() => setHighlightInputs(false), 3000);
    cleanup();
    return () => window.clearTimeout(t);
    // Run only on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auto-geocode an input on blur so the map can pin it immediately.
  // Uses a per-field sequence guard so out-of-order responses can't overwrite a newer query.
  const handleAddressBlur = async (which: "start" | "end") => {
    const value = which === "start" ? startLocation.trim() : endLocation.trim();
    if (!value) return;
    const cached = which === "start" ? geocodedStart : geocodedEnd;
    if (cached && cached.q === value) return;
    const seq = which === "start" ? ++startSeqRef.current : ++endSeqRef.current;
    const pt = await geocode(value);
    if (!pt) return;
    // Discard if a newer request was issued or the user has since changed the input
    const currentSeq = which === "start" ? startSeqRef.current : endSeqRef.current;
    const currentValue = which === "start" ? startLocation.trim() : endLocation.trim();
    if (seq !== currentSeq || currentValue !== value) return;
    if (which === "start") setGeocodedStart({ q: value, pt });
    else setGeocodedEnd({ q: value, pt });
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

    // Eagerly geocode any addresses so map pins appear on first results render (with sequence guard)
    const tasks: Promise<void>[] = [];
    const startVal = startLocation.trim();
    const endVal = endLocation.trim();
    if (startVal && (!geocodedStart || geocodedStart.q !== startVal)) {
      const seq = ++startSeqRef.current;
      tasks.push(geocode(startVal).then((pt) => {
        if (pt && seq === startSeqRef.current && startLocation.trim() === startVal) {
          setGeocodedStart({ q: startVal, pt });
        }
      }));
    }
    if (endVal && (!geocodedEnd || geocodedEnd.q !== endVal)) {
      const seq = ++endSeqRef.current;
      tasks.push(geocode(endVal).then((pt) => {
        if (pt && seq === endSeqRef.current && endLocation.trim() === endVal) {
          setGeocodedEnd({ q: endVal, pt });
        }
      }));
    }
    await Promise.all(tasks);
  };

  const handleSave = async (trail: Trail) => {
    if (!isSignedIn || !userId) {
      setSignInPromptForTrail(trail.name);
      return;
    }
    setSaveStatus((p) => ({ ...p, [trail.id]: "saving" }));
    const ok = await saveTrail(trail.id, { userId, sessionId: null });
    if (ok) {
      setSavedIds((prev) => new Set([...prev, trail.id]));
      setSaveStatus((p) => ({ ...p, [trail.id]: "saved" }));
    } else {
      setSaveStatus((p) => ({ ...p, [trail.id]: "error" }));
    }
  };

  // Route trail linking
  const isInRoute = (id: string) => routeTrails.some((t) => t.id === id);

  const toggleRouteTrail = useCallback((trail: Trail) => {
    if (trail.verification_status === "ai-approximated") {
      // Approximated trails are reference-only — never used in navigation.
      setPlanError(
        `"${trail.name}" is an AI-approximated route — reference only, cannot be used for navigation. A moderator must verify it first.`,
      );
      return;
    }
    setRouteTrails((prev) => {
      if (prev.some((t) => t.id === trail.id)) return prev.filter((t) => t.id !== trail.id);
      return [...prev, trail];
    });
  }, []);

  // Memoized inputs to PlannerMap so it doesn't rebuild layers on unrelated re-renders
  const routeIdSet = useMemo(() => new Set(routeTrails.map((t) => t.id)), [routeTrails]);
  // Pins only when the cached geocoded query matches the current trimmed input value
  const startPin = useMemo(() => {
    return geocodedStart && geocodedStart.q === startLocation.trim() ? geocodedStart.pt : null;
  }, [geocodedStart, startLocation]);
  const endPin = useMemo(() => {
    return geocodedEnd && geocodedEnd.q === endLocation.trim() ? geocodedEnd.pt : null;
  }, [geocodedEnd, endLocation]);

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

    // Hard block: AI-approximated routes are reference-only — never let
    // them slip into a turn-by-turn route. (toggleRouteTrail already
    // refuses, but defend in depth in case a trail's verification status
    // changes after it was added.)
    const approximated = routeTrails.find((t) => t.verification_status === "ai-approximated");
    if (approximated) {
      setPlanError(
        `"${approximated.name}" is AI-approximated and reference only. Remove it from the route or wait for moderator verification before planning navigation.`,
      );
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
        {/* Hero band — biking POV photo with dark gradient overlay so the
            title stays legible. Uses the existing ride-640 / ride-1280 pair
            via <picture>+srcset. Eager-loaded so it doesn't pop in on first
            paint. Scrolls away with the rest of the page (not sticky). */}
        <div
          className="relative w-full overflow-hidden"
          style={{ height: "210px" }}
          data-testid="planner-hero"
        >
          <picture>
            <source media="(min-width: 520px)" srcSet="/ride-1280.jpg" />
            <img
              src="/ride-640.jpg"
              srcSet="/ride-640.jpg 640w, /ride-1280.jpg 1280w"
              sizes="(min-width: 520px) 1280px, 640px"
              alt=""
              loading="eager"
              fetchPriority="high"
              decoding="async"
              className="absolute inset-0 w-full h-full object-cover"
              style={{ objectPosition: "center 55%" }}
            />
          </picture>
          {/* Top vignette pulls focus to the title; bottom gradient melts
              into the page background hsl(22 15% 8%) so the seam against
              the form area below is invisible. */}
          <div
            aria-hidden
            className="absolute inset-0"
            style={{
              background:
                "linear-gradient(180deg, rgba(15,10,5,0.55) 0%, rgba(15,10,5,0.20) 35%, rgba(23,17,10,0.65) 70%, hsl(22,15%,8%) 100%)",
            }}
          />
          <div className="absolute inset-0 flex flex-col justify-end px-4 pb-4">
            <h1
              className="text-3xl font-black tracking-tight text-white uppercase leading-none"
              style={{
                letterSpacing: "0.04em",
                textShadow: "0 2px 14px rgba(0,0,0,0.7), 0 1px 2px rgba(0,0,0,0.9)",
              }}
            >
              Trail <span className="text-amber-400">Planner</span>
            </h1>
            <p
              className="text-[11px] text-stone-200/95 mt-1.5 max-w-xs"
              style={{ textShadow: "0 1px 6px rgba(0,0,0,0.85)" }}
            >
              Address-to-address trip with road + trail navigation
            </p>
          </div>
          {/* Hairline warm divider where the hero meets the form. */}
          <div
            aria-hidden
            className="absolute left-0 right-0 bottom-0 h-px"
            style={{
              background:
                "linear-gradient(90deg, transparent 0%, rgba(240,168,50,0.5) 50%, transparent 100%)",
            }}
          />
        </div>

        <div className="px-4 pt-4 space-y-3.5 pb-4">
          {/* Location Inputs — wrapped in a soft warm-tinted panel so the
              first interactive surface flows naturally out of the hero. */}
          <div
            className={`space-y-2 transition-all rounded-2xl p-3 ${highlightInputs ? "animate-pulse" : ""}`}
            style={{
              background: "linear-gradient(180deg, rgba(34,24,14,0.55) 0%, rgba(22,16,10,0.35) 100%)",
              border: "1px solid rgba(240,168,50,0.18)",
              boxShadow: "inset 0 1px 0 rgba(255,255,255,0.04)",
            }}
          >
            <div className="relative">
              <div className="absolute left-3 top-1/2 -translate-y-1/2 w-2 h-2 rounded-full bg-green-500"></div>
              <input
                ref={startInputRef}
                type="text"
                placeholder="Start address (e.g. 9 High Street, Stranraer)"
                value={startLocation}
                onChange={(e) => { setStartLocation(e.target.value); setPlanError(null); }}
                onBlur={() => handleAddressBlur("start")}
                data-testid="planner-start-address"
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
                onBlur={() => handleAddressBlur("end")}
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
          <div className="bg-[hsl(22,15%,11%)] border border-[hsl(34,18%,24%)] rounded-xl p-3.5">
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
          <div className="bg-[hsl(22,15%,11%)] border border-[hsl(34,18%,24%)] rounded-xl p-3.5">
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
          <div className="bg-[hsl(22,15%,11%)] border border-[hsl(34,18%,24%)] rounded-xl p-3.5">
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

        {/* Trail Discovery Map — shown once we have search results OR a geocoded address */}
        {(results.length > 0 || startPin || endPin) && (
          <div className="px-4 pb-3">
            <PlannerMap
              start={startPin}
              end={endPin}
              trails={results}
              selectedIds={routeIdSet}
              onToggle={toggleRouteTrail}
            />
          </div>
        )}

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
                        <button
                          type="button"
                          onClick={() => setDetailTrail(trail)}
                          className="flex-1 text-left hover:text-amber-300 transition-colors"
                          aria-label={`View details for ${trail.name}`}
                          data-testid={`planner-card-open-${trail.id}`}
                          title="View trail details"
                        >
                          <div className="flex items-center gap-1.5 mb-0.5">
                            {inRoute && (
                              <span className="w-5 h-5 rounded-full bg-amber-500 text-stone-900 flex items-center justify-center text-[10px] font-black shrink-0">
                                {routeIndex + 1}
                              </span>
                            )}
                            <h3 className="text-sm font-bold text-stone-100 leading-tight">{trail.name}</h3>
                          </div>
                          <p className="text-xs text-stone-500">{trail.terrain || "Off-road"}</p>
                        </button>
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
            <div className="flex items-center gap-1.5 shrink-0">
              {routeTrails.slice(0, 3).map((t, i) => (
                <div
                  key={t.id}
                  className="w-5 h-5 rounded-full flex items-center justify-center text-[9px] font-black text-stone-900"
                  style={{ backgroundColor: DIFFICULTY_COLORS[t.difficulty ?? 5] ?? "#fbbf24" }}
                >
                  {i + 1}
                </div>
              ))}
              <button
                type="button"
                onClick={() => {
                  if (planningTrip) return;
                  if (routeTrails.length > 1 && !window.confirm(`Clear all ${routeTrails.length} trails from your route?`)) return;
                  setRouteTrails([]);
                  setPlanError(null);
                }}
                disabled={planningTrip}
                aria-label="Clear all trails from route"
                title="Clear all trails"
                className="ml-1 w-7 h-7 rounded-md flex items-center justify-center border border-stone-700 bg-stone-900/60 text-stone-400 hover:border-red-500/60 hover:text-red-400 hover:bg-red-900/20 transition-all disabled:opacity-50"
              >
                <svg viewBox="0 0 24 24" className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="3 6 5 6 21 6"/>
                  <path d="M19 6l-1.5 14a2 2 0 0 1-2 1.8H8.5a2 2 0 0 1-2-1.8L5 6"/>
                  <path d="M10 11v6M14 11v6"/>
                  <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>
                </svg>
              </button>
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

      {/* Trail detail sheet — opened by tapping a result card's name. The
          prev/next arrows on the sheet's header walk the search results in
          order so the rider can compare trails without bouncing back to
          the list. */}
      {detailTrail && (() => {
        const idx = results.findIndex((t) => t.id === detailTrail.id);
        const prevTrail = idx > 0 ? results[idx - 1] : null;
        const nextTrail = idx >= 0 && idx < results.length - 1 ? results[idx + 1] : null;
        return (
          <TrailDetailSheet
            trail={detailTrail}
            onClose={() => setDetailTrail(null)}
            prevTrail={prevTrail}
            nextTrail={nextTrail}
            onNavigate={setDetailTrail}
          />
        );
      })()}

      {/* Sign-in required prompt for Save action */}
      {signInPromptForTrail && (
        <div
          className="fixed inset-0 z-[2500] flex items-center justify-center px-4"
          style={{ background: "rgba(0,0,0,0.7)", backdropFilter: "blur(4px)" }}
          data-testid="planner-sign-in-prompt"
        >
          <div className="w-full max-w-sm bg-[hsl(22,15%,11%)] border border-amber-500/30 rounded-2xl p-5">
            <div className="flex items-center gap-2.5 mb-3">
              <div className="w-9 h-9 rounded-lg bg-amber-500/20 border border-amber-500/40 flex items-center justify-center">
                <svg viewBox="0 0 24 24" className="w-5 h-5 text-amber-400" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
                </svg>
              </div>
              <h2 className="text-base font-bold text-stone-100">Sign in to save</h2>
            </div>
            <p className="text-sm text-stone-300 leading-relaxed">
              Create a free account to save{" "}
              <span className="font-bold text-amber-400">{signInPromptForTrail}</span>{" "}
              and access your trails on any device.
            </p>
            <div className="mt-5 flex gap-2">
              <button
                onClick={() => setSignInPromptForTrail(null)}
                className="flex-1 py-2.5 rounded-lg text-xs font-semibold text-stone-300 border border-stone-700 hover:bg-stone-800/60 transition-colors"
                data-testid="planner-sign-in-cancel"
              >
                Not now
              </button>
              <button
                onClick={() => {
                  setSignInPromptForTrail(null);
                  setLocation("/sign-in");
                }}
                className="flex-1 py-2.5 rounded-lg text-xs font-bold uppercase tracking-wider text-stone-900"
                style={{ background: "linear-gradient(135deg, #d4870c, #f0a832)" }}
                data-testid="planner-sign-in-confirm"
              >
                Sign in
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
