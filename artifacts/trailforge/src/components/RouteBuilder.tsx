import { useState, useEffect } from "react";
import {
  parseGPX,
  buildCombinedGPX,
  downloadGPX,
  buildGoogleMapsUrl,
  buildAppleMapsUrl,
  buildWazeUrl,
  calcRouteDistanceKm,
  getTrailStart,
  type TrailRoute,
} from "@/lib/gpx";
import type { Trail } from "@/lib/supabase";

const DIFFICULTY_COLORS: Record<number, string> = {
  1: "#4ade80", 2: "#86efac", 3: "#a3e635", 4: "#bef264", 5: "#fbbf24",
  6: "#fb923c", 7: "#f97316", 8: "#ef4444", 9: "#dc2626", 10: "#7f1d1d",
};

function trailToRoute(trail: Trail): TrailRoute {
  return {
    id: trail.id,
    name: trail.name,
    waypoints: parseGPX(trail.gpx_data),
    distance_km: trail.distance_km,
    legal_status: trail.legal_status,
    difficulty: trail.difficulty,
  };
}

interface Props {
  selectedTrails: Trail[];
  onReorder: (trails: Trail[]) => void;
  onRemove: (id: string) => void;
  onClose: () => void;
}

export default function RouteBuilder({ selectedTrails, onReorder, onRemove, onClose }: Props) {
  const [downloading, setDownloading] = useState(false);
  const [gpxReady, setGpxReady] = useState(false);
  const [transitDistances, setTransitDistances] = useState<number[]>([]);

  const routes = selectedTrails.map(trailToRoute);
  const totalTrailKm = selectedTrails.reduce((s, t) => s + (t.distance_km ?? 0), 0);
  const totalWithTransit = calcRouteDistanceKm(routes);
  const transitKm = totalWithTransit - totalTrailKm;

  useEffect(() => {
    const dists: number[] = [];
    for (let i = 0; i < routes.length - 1; i++) {
      const end = routes[i].waypoints[routes[i].waypoints.length - 1];
      const start = routes[i + 1].waypoints[0];
      if (end && start) {
        const R = 6371;
        const dLat = ((start.lat - end.lat) * Math.PI) / 180;
        const dLon = ((start.lon - end.lon) * Math.PI) / 180;
        const a = Math.sin(dLat / 2) ** 2 + Math.cos((end.lat * Math.PI) / 180) * Math.cos((start.lat * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
        dists.push(R * 2 * Math.asin(Math.sqrt(a)));
      } else {
        dists.push(0);
      }
    }
    setTransitDistances(dists);
    setGpxReady(routes.every((r) => r.waypoints.length > 0));
  }, [selectedTrails]);

  const moveUp = (idx: number) => {
    if (idx === 0) return;
    const next = [...selectedTrails];
    [next[idx - 1], next[idx]] = [next[idx], next[idx - 1]];
    onReorder(next);
  };

  const moveDown = (idx: number) => {
    if (idx === selectedTrails.length - 1) return;
    const next = [...selectedTrails];
    [next[idx], next[idx + 1]] = [next[idx + 1], next[idx]];
    onReorder(next);
  };

  const handleDownloadGPX = () => {
    setDownloading(true);
    setTimeout(() => {
      const gpx = buildCombinedGPX(routes);
      const name = `TrailForge-Route-${new Date().toISOString().slice(0, 10)}.gpx`;
      downloadGPX(gpx, name);
      setDownloading(false);
    }, 300);
  };

  const handleGoogleMaps = () => {
    const url = buildGoogleMapsUrl(routes);
    window.open(url, "_blank");
  };

  const handleAppleMaps = () => {
    const url = buildAppleMapsUrl(routes);
    window.open(url, "_blank");
  };

  const handleWaze = () => {
    const url = buildWazeUrl(routes);
    window.open(url, "_blank");
  };

  const routeFilename = selectedTrails.map((t) => t.name.split(" ")[0]).join("-");

  return (
    <div className="fixed inset-0 z-50 flex flex-col" style={{ background: "rgba(0,0,0,0.85)", backdropFilter: "blur(4px)" }}>
      <div
        className="flex flex-col mt-auto rounded-t-2xl overflow-hidden"
        style={{ background: "hsl(22,15%,9%)", maxHeight: "92vh" }}
      >
        {/* Handle bar */}
        <div className="flex justify-center pt-3 pb-1 shrink-0">
          <div className="w-10 h-1 rounded-full bg-stone-600"></div>
        </div>

        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-[hsl(30,12%,16%)] shrink-0">
          <div>
            <h2 className="text-base font-bold text-amber-400 uppercase tracking-widest">Route Builder</h2>
            <p className="text-xs text-stone-500 mt-0.5">
              {selectedTrails.length} trail{selectedTrails.length !== 1 ? "s" : ""} · {totalTrailKm.toFixed(1)} km riding
            </p>
          </div>
          <button
            onClick={onClose}
            className="w-8 h-8 rounded-full bg-stone-800 flex items-center justify-center text-stone-400 hover:text-stone-200 transition-colors"
          >
            <svg viewBox="0 0 24 24" className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        {/* Stats Row */}
        <div className="grid grid-cols-3 divide-x divide-[hsl(30,12%,16%)] border-b border-[hsl(30,12%,16%)] shrink-0">
          <div className="py-3 text-center">
            <div className="text-lg font-bold text-amber-400">{totalTrailKm.toFixed(1)}</div>
            <div className="text-[10px] text-stone-500 uppercase tracking-wider">Trail km</div>
          </div>
          <div className="py-3 text-center">
            <div className="text-lg font-bold text-stone-300">{transitKm > 0 ? `+${transitKm.toFixed(1)}` : "—"}</div>
            <div className="text-[10px] text-stone-500 uppercase tracking-wider">Transit km</div>
          </div>
          <div className="py-3 text-center">
            <div className="text-lg font-bold text-stone-300">{totalWithTransit.toFixed(1)}</div>
            <div className="text-[10px] text-stone-500 uppercase tracking-wider">Total km</div>
          </div>
        </div>

        {/* Trail Order List */}
        <div className="overflow-y-auto flex-1 px-4 py-3 space-y-2">
          {selectedTrails.map((trail, idx) => {
            const diff = trail.difficulty ?? 5;
            const route = routes[idx];
            const start = getTrailStart(route.waypoints);
            const transitDist = transitDistances[idx];

            return (
              <div key={trail.id}>
                {/* Trail Card */}
                <div className="bg-[hsl(22,15%,13%)] border border-[hsl(30,12%,22%)] rounded-xl overflow-hidden">
                  <div className="flex items-center gap-2 p-3">
                    {/* Order Badge */}
                    <div className="w-7 h-7 rounded-full bg-amber-500 text-stone-900 flex items-center justify-center text-xs font-black shrink-0">
                      {idx + 1}
                    </div>

                    {/* Trail Info */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5 mb-0.5">
                        <span
                          className="w-4 h-4 rounded text-[10px] font-bold text-black flex items-center justify-center shrink-0"
                          style={{ backgroundColor: DIFFICULTY_COLORS[diff] ?? "#fbbf24" }}
                        >
                          {diff}
                        </span>
                        <span className="text-sm font-bold text-stone-100 truncate">{trail.name}</span>
                      </div>
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <span className="text-[10px] text-stone-500">{trail.distance_km?.toFixed(1)} km</span>
                        <span className="text-stone-700">·</span>
                        <span className={`text-[10px] ${trail.legal_status === "BOAT" ? "text-amber-400" : "text-green-400"}`}>
                          {trail.legal_status}
                        </span>
                        {start && (
                          <>
                            <span className="text-stone-700">·</span>
                            <span className="text-[10px] text-stone-600">
                              {start.lat.toFixed(4)}, {start.lon.toFixed(4)}
                            </span>
                          </>
                        )}
                      </div>
                    </div>

                    {/* Controls */}
                    <div className="flex flex-col gap-0.5">
                      <button
                        onClick={() => moveUp(idx)}
                        disabled={idx === 0}
                        className="w-6 h-6 rounded flex items-center justify-center text-stone-500 hover:text-stone-300 disabled:opacity-25 disabled:cursor-not-allowed transition-colors"
                      >
                        <svg viewBox="0 0 24 24" className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2.5">
                          <polyline points="18 15 12 9 6 15" />
                        </svg>
                      </button>
                      <button
                        onClick={() => moveDown(idx)}
                        disabled={idx === selectedTrails.length - 1}
                        className="w-6 h-6 rounded flex items-center justify-center text-stone-500 hover:text-stone-300 disabled:opacity-25 disabled:cursor-not-allowed transition-colors"
                      >
                        <svg viewBox="0 0 24 24" className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2.5">
                          <polyline points="6 9 12 15 18 9" />
                        </svg>
                      </button>
                    </div>
                    <button
                      onClick={() => onRemove(trail.id)}
                      className="w-7 h-7 rounded-full bg-stone-800/60 flex items-center justify-center text-stone-600 hover:text-red-400 hover:bg-red-900/20 transition-colors"
                    >
                      <svg viewBox="0 0 24 24" className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2">
                        <line x1="18" y1="6" x2="6" y2="18" />
                        <line x1="6" y1="6" x2="18" y2="18" />
                      </svg>
                    </button>
                  </div>
                </div>

                {/* Transit Connector */}
                {idx < selectedTrails.length - 1 && (
                  <div className="flex items-center gap-2 py-1.5 px-3">
                    <div className="flex flex-col items-center gap-0.5">
                      <div className="w-px h-2 bg-stone-700"></div>
                      <div className="w-px h-2 bg-stone-700"></div>
                    </div>
                    <div className="flex items-center gap-1.5 bg-[hsl(22,15%,12%)] border border-[hsl(30,12%,17%)] rounded-lg px-3 py-1.5 flex-1">
                      <svg viewBox="0 0 24 24" className="w-3.5 h-3.5 text-blue-400 shrink-0" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M3 12h18M13 6l6 6-6 6"/>
                      </svg>
                      <span className="text-[10px] text-stone-400">
                        Navigate between trails
                        {transitDist > 0 && (
                          <span className="text-blue-400 ml-1">~{transitDist.toFixed(1)} km road</span>
                        )}
                      </span>
                      <span className="ml-auto text-[10px] text-stone-600">via GPS nav</span>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* Action Buttons */}
        <div className="px-4 pb-6 pt-3 space-y-2 border-t border-[hsl(30,12%,16%)] shrink-0">
          {/* Download GPX */}
          <button
            onClick={handleDownloadGPX}
            disabled={downloading || !gpxReady}
            className="w-full py-3.5 rounded-xl font-bold text-sm uppercase tracking-widest transition-all flex items-center justify-center gap-2"
            style={{ background: gpxReady ? "linear-gradient(135deg, #d4870c 0%, #f0a832 50%, #d4870c 100%)" : "hsl(22,15%,16%)", color: gpxReady ? "#1a0e05" : "#6b7280" }}
          >
            {downloading ? (
              <>
                <span className="w-4 h-4 border-2 border-stone-900/50 border-t-stone-900 rounded-full animate-spin"></span>
                Generating GPX...
              </>
            ) : (
              <>
                <svg viewBox="0 0 24 24" className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                  <polyline points="7 10 12 15 17 10"/>
                  <line x1="12" y1="15" x2="12" y2="3"/>
                </svg>
                Download Combined GPX
              </>
            )}
          </button>

          {!gpxReady && (
            <p className="text-[10px] text-stone-600 text-center">GPX data unavailable for some trails</p>
          )}

          {/* Navigation Apps */}
          <div className="grid grid-cols-3 gap-2">
            <button
              onClick={handleGoogleMaps}
              className="py-3 rounded-xl text-xs font-semibold border border-[hsl(30,12%,22%)] bg-[hsl(22,15%,13%)] text-stone-300 hover:border-blue-500/40 hover:text-blue-300 transition-all flex flex-col items-center gap-1"
            >
              <svg viewBox="0 0 24 24" className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7z"/>
                <circle cx="12" cy="9" r="2.5"/>
              </svg>
              Google Maps
            </button>
            <button
              onClick={handleAppleMaps}
              className="py-3 rounded-xl text-xs font-semibold border border-[hsl(30,12%,22%)] bg-[hsl(22,15%,13%)] text-stone-300 hover:border-stone-400/40 hover:text-stone-200 transition-all flex flex-col items-center gap-1"
            >
              <svg viewBox="0 0 24 24" className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M12 2a10 10 0 1 0 10 10A10 10 0 0 0 12 2z"/>
                <path d="M12 8v4l3 3"/>
              </svg>
              Apple Maps
            </button>
            <button
              onClick={handleWaze}
              className="py-3 rounded-xl text-xs font-semibold border border-[hsl(30,12%,22%)] bg-[hsl(22,15%,13%)] text-stone-300 hover:border-purple-500/40 hover:text-purple-300 transition-all flex flex-col items-center gap-1"
            >
              <svg viewBox="0 0 24 24" className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="1.5">
                <circle cx="12" cy="10" r="7"/>
                <path d="M9.5 10a1 1 0 1 0 2 0 1 1 0 0 0-2 0M13.5 10a1 1 0 1 0 2 0 1 1 0 0 0-2 0M9 13.5s1 2 3 2 3-2 3-2"/>
                <path d="M12 17v4M8 21h8"/>
              </svg>
              Waze
            </button>
          </div>

          <p className="text-[10px] text-stone-600 text-center">
            Navigation routes between trail start points · Trails linked in order above
          </p>
        </div>
      </div>
    </div>
  );
}
