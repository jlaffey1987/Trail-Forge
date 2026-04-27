import { useEffect, useRef, useState } from "react";
import {
  type AssembledRoute,
  type RouteSection,
  type GeoPoint,
  formatDistance,
  formatKm,
  formatDurationMin,
  maneuverArrow,
} from "@/lib/routing";
import { buildCombinedGPX, downloadGPX, type TrailRoute } from "@/lib/gpx";

declare global {
  interface Window {
    L: typeof import("leaflet");
  }
}

const ROAD_COLOR = "#3b82f6";
const TRAIL_COLOR = "#f97316";
const ROAD_DEEP = "#1d4ed8";

interface Props {
  route: AssembledRoute;
  onClose: () => void;
}

export default function NavigationView({ route, onClose }: Props) {
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<import("leaflet").Map | null>(null);
  const sectionLayersRef = useRef<Map<number, import("leaflet").Polyline | import("leaflet").Marker>>(new Map());
  const [leafletLoaded, setLeafletLoaded] = useState(false);
  const [activeSection, setActiveSection] = useState<number | null>(null);
  const [bottomTab, setBottomTab] = useState<"sections" | "turns">("sections");

  useEffect(() => {
    if (window.L) { setLeafletLoaded(true); return undefined; }
    if (!document.getElementById("leaflet-script")) {
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css";
      document.head.appendChild(link);
      const script = document.createElement("script");
      script.id = "leaflet-script";
      script.src = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js";
      script.onload = () => setLeafletLoaded(true);
      document.head.appendChild(script);
      return undefined;
    }
    const check = setInterval(() => {
      if (window.L) { setLeafletLoaded(true); clearInterval(check); }
    }, 100);
    return () => clearInterval(check);
  }, []);

  useEffect(() => {
    if (!leafletLoaded || !mapContainerRef.current || mapRef.current) return;
    const L = window.L;
    const map = L.map(mapContainerRef.current, { center: [54, -3], zoom: 6, zoomControl: false });
    L.control.zoom({ position: "topright" }).addTo(map);
    L.tileLayer(
      "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
      { attribution: "Tiles © Esri", maxZoom: 19 }
    ).addTo(map);
    mapRef.current = map;
  }, [leafletLoaded]);

  // Render route sections
  useEffect(() => {
    if (!mapRef.current || !window.L || !leafletLoaded) return;
    const L = window.L;
    const map = mapRef.current;

    // Clear existing
    sectionLayersRef.current.forEach((layer) => layer.remove());
    sectionLayersRef.current = new Map();

    const allBounds: [number, number][] = [];

    // Add markers for start and end
    const startMarker = L.marker([route.start.lat, route.start.lng], {
      icon: L.divIcon({
        html: `<div style="background:#10b981;width:24px;height:24px;border:3px solid #fff;border-radius:50%;box-shadow:0 2px 6px rgba(0,0,0,0.6);display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:900;color:#fff;">A</div>`,
        iconSize: [24, 24], iconAnchor: [12, 12], className: "",
      }),
    }).addTo(map);
    const endMarker = L.marker([route.end.lat, route.end.lng], {
      icon: L.divIcon({
        html: `<div style="background:#dc2626;width:24px;height:24px;border:3px solid #fff;border-radius:50%;box-shadow:0 2px 6px rgba(0,0,0,0.6);display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:900;color:#fff;">B</div>`,
        iconSize: [24, 24], iconAnchor: [12, 12], className: "",
      }),
    }).addTo(map);
    sectionLayersRef.current.set(-1, startMarker);
    sectionLayersRef.current.set(-2, endMarker);
    allBounds.push([route.start.lat, route.start.lng]);
    allBounds.push([route.end.lat, route.end.lng]);

    // Render each section
    route.sections.forEach((sec) => {
      const isActive = activeSection === sec.index;
      if (sec.kind === "road") {
        const latlngs = sec.route.polyline.map((p) => [p.lat, p.lng] as [number, number]);
        // Draw a thicker shadow line beneath
        const shadow = L.polyline(latlngs, {
          color: isActive ? ROAD_DEEP : "#1e3a8a",
          weight: isActive ? 9 : 7,
          opacity: 0.4,
        }).addTo(map);
        const main = L.polyline(latlngs, {
          color: ROAD_COLOR,
          weight: isActive ? 5 : 4,
          opacity: 0.95,
          dashArray: undefined,
        }).addTo(map);
        sectionLayersRef.current.set(sec.index * 10, shadow);
        sectionLayersRef.current.set(sec.index * 10 + 1, main);
        latlngs.forEach((c) => allBounds.push(c));
      } else {
        // Trail section
        const latlngs = sec.polyline.map((p) => [p.lat, p.lng] as [number, number]);
        const shadow = L.polyline(latlngs, {
          color: "#7c2d12",
          weight: isActive ? 9 : 7,
          opacity: 0.5,
        }).addTo(map);
        const main = L.polyline(latlngs, {
          color: TRAIL_COLOR,
          weight: isActive ? 6 : 5,
          opacity: 1,
          dashArray: "12 6",
        }).addTo(map);
        sectionLayersRef.current.set(sec.index * 10, shadow);
        sectionLayersRef.current.set(sec.index * 10 + 1, main);
        // Trail entry marker (numbered)
        const trailNum = route.sections.filter((s) => s.kind === "trail" && s.index <= sec.index).length;
        const entryMarker = L.marker([sec.entry.lat, sec.entry.lng], {
          icon: L.divIcon({
            html: `<div style="background:#f97316;width:22px;height:22px;border:2.5px solid #fff;border-radius:6px;box-shadow:0 2px 6px rgba(0,0,0,0.6);display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:900;color:#000;">${trailNum}</div>`,
            iconSize: [22, 22], iconAnchor: [11, 11], className: "",
          }),
        }).addTo(map);
        sectionLayersRef.current.set(sec.index * 10 + 2, entryMarker);
        latlngs.forEach((c) => allBounds.push(c));
      }
    });

    // Fit bounds to whole route
    if (allBounds.length > 0) {
      try {
        if (activeSection != null) {
          const sec = route.sections.find((s) => s.index === activeSection);
          if (sec) {
            const pts = sec.kind === "road" ? sec.route.polyline : sec.polyline;
            const ll = pts.map((p) => [p.lat, p.lng] as [number, number]);
            map.fitBounds(ll, { padding: [40, 40] });
            return;
          }
        }
        map.fitBounds(allBounds, { padding: [40, 40] });
      } catch {
        // ignore bounds errors
      }
    }
  }, [route, leafletLoaded, activeSection]);

  const handleDownloadFullGPX = () => {
    // Build a single GPX with all sections (road tracks + trail tracks)
    const trailRoutes: TrailRoute[] = route.sections.map((sec, i) => {
      if (sec.kind === "road") {
        return {
          id: `road-${i}`,
          name: sec.label,
          waypoints: sec.route.polyline.map((p) => ({ lat: p.lat, lon: p.lng })),
          distance_km: sec.route.distanceKm,
          legal_status: "Road",
          difficulty: 0,
        };
      }
      return {
        id: sec.trail.id,
        name: sec.trail.name,
        waypoints: sec.polyline.map((p) => ({ lat: p.lat, lon: p.lng })),
        distance_km: sec.distanceKm,
        legal_status: sec.trail.legal_status,
        difficulty: sec.trail.difficulty,
      };
    });
    const gpx = buildCombinedGPX(trailRoutes);
    const filename = `TrailForge-Trip-${new Date().toISOString().slice(0, 10)}.gpx`;
    downloadGPX(gpx, filename);
  };

  const trailSections = route.sections.filter((s): s is Extract<RouteSection, { kind: "trail" }> => s.kind === "trail");
  const roadSections = route.sections.filter((s): s is Extract<RouteSection, { kind: "road" }> => s.kind === "road");

  return (
    <div className="fixed inset-0 z-[2000] flex flex-col bg-[hsl(22,15%,7%)]">
      {/* Top stats bar */}
      <div className="shrink-0 bg-[hsl(22,15%,9%)] border-b border-[hsl(30,12%,16%)]">
        <div className="flex items-center justify-between px-3 py-2.5">
          <button
            onClick={onClose}
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-stone-800 text-stone-300 hover:bg-stone-700 transition-colors"
          >
            <svg viewBox="0 0 24 24" className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2.5">
              <line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/>
            </svg>
            <span className="text-xs font-bold">Back</span>
          </button>
          <div className="text-center">
            <div className="text-[10px] text-stone-500 uppercase tracking-widest">Trip Navigation</div>
            <div className="text-xs font-bold text-amber-400">
              {route.start.label?.split(",")[0] || "Start"} → {route.end.label?.split(",")[0] || "End"}
            </div>
          </div>
          <button
            onClick={handleDownloadFullGPX}
            className="px-2.5 py-1.5 rounded-lg bg-amber-500/20 border border-amber-500/40 text-amber-300 hover:bg-amber-500/30 transition-colors"
            title="Download full trip GPX"
          >
            <svg viewBox="0 0 24 24" className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2.5">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
              <polyline points="7 10 12 15 17 10"/>
              <line x1="12" y1="15" x2="12" y2="3"/>
            </svg>
          </button>
        </div>

        {/* Stats row */}
        <div className="grid grid-cols-4 divide-x divide-[hsl(30,12%,16%)] border-t border-[hsl(30,12%,14%)]">
          <div className="py-2 text-center">
            <div className="text-sm font-bold text-amber-400">{formatKm(route.totalDistanceKm)}</div>
            <div className="text-[9px] text-stone-500 uppercase tracking-wider">Total</div>
          </div>
          <div className="py-2 text-center">
            <div className="text-sm font-bold text-blue-400">{formatKm(route.totalRoadKm)}</div>
            <div className="text-[9px] text-stone-500 uppercase tracking-wider">Road</div>
          </div>
          <div className="py-2 text-center">
            <div className="text-sm font-bold text-orange-400">{formatKm(route.totalTrailKm)}</div>
            <div className="text-[9px] text-stone-500 uppercase tracking-wider">Trail</div>
          </div>
          <div className="py-2 text-center">
            <div className="text-sm font-bold text-stone-200">{formatDurationMin(route.totalDurationMin)}</div>
            <div className="text-[9px] text-stone-500 uppercase tracking-wider">Est. Time</div>
          </div>
        </div>
      </div>

      {/* Warnings if any */}
      {(route.skippedTrails.length > 0 || route.failedRoadSegments > 0) && (
        <div className="shrink-0 bg-amber-900/30 border-b border-amber-600/40 px-3 py-2 flex items-start gap-2">
          <svg viewBox="0 0 24 24" className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
            <line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
          </svg>
          <div className="flex-1 text-[11px] text-amber-200 leading-tight">
            {route.skippedTrails.length > 0 && (
              <p>Skipped {route.skippedTrails.length} trail{route.skippedTrails.length !== 1 ? "s" : ""} with missing GPX: {route.skippedTrails.join(", ")}</p>
            )}
            {route.failedRoadSegments > 0 && (
              <p>Could not compute {route.failedRoadSegments} road segment{route.failedRoadSegments !== 1 ? "s" : ""} (try again — public OSRM may be busy)</p>
            )}
          </div>
        </div>
      )}

      {/* Map */}
      <div className="relative" style={{ height: "45vh" }}>
        <div ref={mapContainerRef} className="absolute inset-0 bg-stone-900" />
        {!leafletLoaded && (
          <div className="absolute inset-0 flex items-center justify-center bg-[hsl(22,15%,8%)]">
            <div className="text-center">
              <div className="w-8 h-8 border-2 border-amber-500/30 border-t-amber-500 rounded-full animate-spin mx-auto mb-2"></div>
              <p className="text-xs text-stone-400">Loading navigation map...</p>
            </div>
          </div>
        )}

        {/* Active section overlay */}
        {activeSection != null && (() => {
          const sec = route.sections.find((s) => s.index === activeSection);
          if (!sec) return null;
          return (
            <div className="absolute top-2 left-2 right-2 z-[500]">
              <div
                className="rounded-lg p-2 backdrop-blur shadow-lg flex items-center gap-2"
                style={{
                  background: sec.kind === "road" ? "rgba(59,130,246,0.95)" : "rgba(249,115,22,0.95)",
                  color: "#fff",
                }}
              >
                <div className="w-7 h-7 rounded-md bg-white/20 flex items-center justify-center text-[11px] font-black">
                  {sec.kind === "road" ? "RD" : `T${trailSections.findIndex((t) => t.index === sec.index) + 1}`}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-xs font-bold truncate">
                    {sec.kind === "road" ? sec.label : sec.trail.name}
                  </div>
                  <div className="text-[10px] opacity-80">
                    {sec.kind === "road"
                      ? `${formatKm(sec.route.distanceKm)} · ${formatDurationMin(sec.route.durationMin)} · ${sec.route.steps.length} turns`
                      : `${formatKm(sec.distanceKm)} · Difficulty ${sec.trail.difficulty} · ${sec.trail.legal_status}`}
                  </div>
                </div>
                <button onClick={() => setActiveSection(null)} className="text-white/80 hover:text-white text-lg leading-none">×</button>
              </div>
            </div>
          );
        })()}
      </div>

      {/* Tab switcher */}
      <div className="shrink-0 flex border-b border-[hsl(30,12%,16%)] bg-[hsl(22,15%,9%)]">
        <button
          onClick={() => setBottomTab("sections")}
          className={`flex-1 py-2.5 text-xs font-bold uppercase tracking-wider transition-all ${
            bottomTab === "sections" ? "text-amber-400 border-b-2 border-amber-400" : "text-stone-500"
          }`}
        >
          Sections ({route.sections.length})
        </button>
        <button
          onClick={() => setBottomTab("turns")}
          className={`flex-1 py-2.5 text-xs font-bold uppercase tracking-wider transition-all ${
            bottomTab === "turns" ? "text-amber-400 border-b-2 border-amber-400" : "text-stone-500"
          }`}
        >
          Turn-by-Turn ({roadSections.reduce((s, r) => s + r.route.steps.length, 0)})
        </button>
      </div>

      {/* Bottom panel */}
      <div className="flex-1 overflow-y-auto bg-[hsl(22,15%,8%)]">
        {bottomTab === "sections" ? (
          <SectionsList route={route} activeSection={activeSection} onSelect={setActiveSection} />
        ) : (
          <TurnByTurnList route={route} onSelectSection={setActiveSection} />
        )}
      </div>
    </div>
  );
}

// ====================================================================
// Sections list (shows road & trail breakdown with key stats per section)
// ====================================================================
function SectionsList({
  route,
  activeSection,
  onSelect,
}: {
  route: AssembledRoute;
  activeSection: number | null;
  onSelect: (idx: number | null) => void;
}) {
  const trailSections = route.sections.filter((s) => s.kind === "trail");
  return (
    <div className="px-3 py-3 space-y-1.5">
      {/* Start node */}
      <div className="flex items-center gap-3 py-2">
        <div className="w-7 h-7 rounded-full bg-green-500 text-white flex items-center justify-center text-xs font-black shrink-0">A</div>
        <div className="flex-1 min-w-0">
          <div className="text-xs font-bold text-green-400">START</div>
          <div className="text-[10px] text-stone-400 truncate">{route.start.label || `${route.start.lat.toFixed(4)}, ${route.start.lng.toFixed(4)}`}</div>
        </div>
      </div>

      {route.sections.map((sec) => {
        const isActive = activeSection === sec.index;
        if (sec.kind === "road") {
          return (
            <button
              key={sec.index}
              onClick={() => onSelect(isActive ? null : sec.index)}
              className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg border transition-all ${
                isActive ? "border-blue-500/60 bg-blue-500/10" : "border-[hsl(30,12%,18%)] bg-[hsl(22,15%,11%)] hover:border-stone-600"
              }`}
            >
              <div className="w-7 h-7 rounded-md bg-blue-500/20 text-blue-400 flex items-center justify-center shrink-0">
                <svg viewBox="0 0 24 24" className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <path d="M9 5l7 7-7 7"/>
                </svg>
              </div>
              <div className="flex-1 min-w-0 text-left">
                <div className="text-xs font-bold text-stone-200">Road · {formatKm(sec.route.distanceKm)}</div>
                <div className="text-[10px] text-stone-500">
                  {formatDurationMin(sec.route.durationMin)} · {sec.route.steps.length} turns
                </div>
              </div>
              <svg viewBox="0 0 24 24" className={`w-4 h-4 transition-transform ${isActive ? "rotate-90" : ""} text-stone-500`} fill="none" stroke="currentColor" strokeWidth="2">
                <polyline points="9 18 15 12 9 6"/>
              </svg>
            </button>
          );
        }
        const tNum = trailSections.findIndex((t) => t.index === sec.index) + 1;
        return (
          <button
            key={sec.index}
            onClick={() => onSelect(isActive ? null : sec.index)}
            className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg border transition-all ${
              isActive ? "border-orange-500/60 bg-orange-500/10" : "border-orange-500/20 bg-orange-900/10 hover:border-orange-500/40"
            }`}
          >
            <div className="w-7 h-7 rounded-md bg-orange-500 text-stone-900 flex items-center justify-center text-xs font-black shrink-0">
              {tNum}
            </div>
            <div className="flex-1 min-w-0 text-left">
              <div className="text-xs font-bold text-orange-300 truncate">{sec.trail.name}</div>
              <div className="text-[10px] text-stone-400">
                Trail · {formatKm(sec.distanceKm)} · Difficulty {sec.trail.difficulty} · {sec.trail.legal_status}
              </div>
            </div>
            <svg viewBox="0 0 24 24" className={`w-4 h-4 transition-transform ${isActive ? "rotate-90" : ""} text-stone-500`} fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="9 18 15 12 9 6"/>
            </svg>
          </button>
        );
      })}

      {/* End node */}
      <div className="flex items-center gap-3 py-2">
        <div className="w-7 h-7 rounded-full bg-red-500 text-white flex items-center justify-center text-xs font-black shrink-0">B</div>
        <div className="flex-1 min-w-0">
          <div className="text-xs font-bold text-red-400">DESTINATION</div>
          <div className="text-[10px] text-stone-400 truncate">{route.end.label || `${route.end.lat.toFixed(4)}, ${route.end.lng.toFixed(4)}`}</div>
        </div>
      </div>
    </div>
  );
}

// ====================================================================
// Turn-by-Turn list (all maneuvers across all sections)
// ====================================================================
function TurnByTurnList({
  route,
  onSelectSection,
}: {
  route: AssembledRoute;
  onSelectSection: (idx: number) => void;
}) {
  const trailSections = route.sections.filter((s) => s.kind === "trail");
  return (
    <div className="px-2 py-2 space-y-3">
      {route.sections.map((sec) => {
        if (sec.kind === "road") {
          return (
            <div key={sec.index} className="rounded-lg overflow-hidden border border-blue-500/20 bg-blue-500/5">
              <button
                onClick={() => onSelectSection(sec.index)}
                className="w-full px-3 py-2 bg-blue-500/15 border-b border-blue-500/20 flex items-center gap-2"
              >
                <svg viewBox="0 0 24 24" className="w-4 h-4 text-blue-400" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <circle cx="12" cy="12" r="10"/>
                  <path d="M12 6v6l4 2"/>
                </svg>
                <span className="text-[11px] font-bold text-blue-300 uppercase tracking-wider">
                  Road · {formatKm(sec.route.distanceKm)} · {formatDurationMin(sec.route.durationMin)}
                </span>
              </button>
              <ul className="divide-y divide-blue-500/10">
                {sec.route.steps.map((step, i) => (
                  <li key={i} className="px-3 py-2 flex items-start gap-3">
                    <div className="w-7 h-7 rounded-md bg-blue-500/15 text-blue-300 flex items-center justify-center shrink-0 mt-0.5">
                      <svg viewBox="0 0 24 24" className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                        <path d={maneuverArrow(step.maneuver, step.modifier)} />
                      </svg>
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-xs text-stone-200 font-medium">{step.instruction}</div>
                      <div className="text-[10px] text-stone-500 mt-0.5">
                        {formatDistance(step.distanceM)} · {Math.round(step.durationS / 60)} min
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          );
        }
        const tNum = trailSections.findIndex((t) => t.index === sec.index) + 1;
        return (
          <div key={sec.index} className="rounded-lg overflow-hidden border border-orange-500/30 bg-orange-500/5">
            <button
              onClick={() => onSelectSection(sec.index)}
              className="w-full px-3 py-2.5 bg-orange-500/15 border-b border-orange-500/20 flex items-center gap-2"
            >
              <div className="w-6 h-6 rounded bg-orange-500 text-stone-900 flex items-center justify-center text-[10px] font-black">
                {tNum}
              </div>
              <span className="text-[11px] font-bold text-orange-300 uppercase tracking-wider truncate">
                Trail · {sec.trail.name}
              </span>
            </button>
            <div className="px-3 py-3 flex items-start gap-3">
              <div className="w-7 h-7 rounded-md bg-orange-500/20 text-orange-300 flex items-center justify-center shrink-0">
                <svg viewBox="0 0 24 24" className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2">
                  <polygon points="12 2 22 8.5 22 15.5 12 22 2 15.5 2 8.5 12 2"/>
                  <line x1="12" y1="22" x2="12" y2="15.5"/>
                </svg>
              </div>
              <div className="flex-1">
                <div className="text-xs text-stone-200 font-medium">
                  Follow the GPX trail off-road
                </div>
                <div className="text-[10px] text-stone-500 mt-0.5">
                  {formatKm(sec.distanceKm)} · Difficulty {sec.trail.difficulty} · {sec.trail.legal_status} · {sec.polyline.length} GPS points
                </div>
                <div className="mt-2 flex items-center gap-1.5 text-[10px] text-orange-300">
                  <span className="w-1.5 h-1.5 rounded-full bg-orange-400"></span>
                  Phone GPS will guide you along the recorded route
                </div>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// Re-export GeoPoint for convenience
export type { GeoPoint };
