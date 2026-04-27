import { useEffect, useMemo, useRef, useState } from "react";
import { type Trail } from "@/lib/supabase";
import { parseGPX, type Waypoint } from "@/lib/gpx";
import { type GeoPoint } from "@/lib/routing";

// Escape user-controlled text before injecting into Leaflet divIcon HTML
function esc(s: string | null | undefined): string {
  if (s == null) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

declare global {
  interface Window {
    L: typeof import("leaflet");
  }
}

const DIFFICULTY_COLORS: Record<number, string> = {
  1: "#4ade80", 2: "#86efac", 3: "#a3e635", 4: "#bef264", 5: "#fbbf24",
  6: "#fb923c", 7: "#f97316", 8: "#ef4444", 9: "#dc2626", 10: "#7f1d1d",
};

interface Props {
  start: GeoPoint | null;
  end: GeoPoint | null;
  trails: Trail[];
  selectedIds: Set<string>;
  onToggle: (trail: Trail) => void;
}

export default function PlannerMap({ start, end, trails, selectedIds, onToggle }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<import("leaflet").Map | null>(null);
  const layersRef = useRef<import("leaflet").Layer[]>([]);
  const [leafletLoaded, setLeafletLoaded] = useState(false);
  const [expanded, setExpanded] = useState(true);

  // Load Leaflet
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

  // Init map (container is always mounted; collapse just hides via CSS so the map stays valid)
  useEffect(() => {
    if (!leafletLoaded || !containerRef.current || mapRef.current) return;
    const L = window.L;
    const map = L.map(containerRef.current, { center: [54, -3], zoom: 6, zoomControl: true });
    L.tileLayer(
      "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
      { attribution: "Tiles © Esri", maxZoom: 19 }
    ).addTo(map);
    mapRef.current = map;
  }, [leafletLoaded]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (mapRef.current) {
        try { mapRef.current.remove(); } catch { /* ignore */ }
        mapRef.current = null;
      }
      layersRef.current = [];
    };
  }, []);

  // Trigger size recalc when collapsed/expanded toggles
  useEffect(() => {
    if (mapRef.current && expanded) {
      setTimeout(() => mapRef.current?.invalidateSize(), 100);
    }
  }, [expanded]);

  // Cache parsed GPX per trail id to avoid re-parsing on every selection toggle
  const parsedGpxCache = useRef<Map<string, Waypoint[]>>(new Map());
  const trailGpxData = useMemo(() => {
    return trails.map((t) => {
      let wps = parsedGpxCache.current.get(t.id);
      if (!wps) {
        wps = parseGPX(t.gpx_data);
        parsedGpxCache.current.set(t.id, wps);
      }
      return { trail: t, wps };
    });
  }, [trails]);

  // Render markers + trails
  useEffect(() => {
    if (!mapRef.current || !window.L) return;
    const L = window.L;
    const map = mapRef.current;

    // Clear previous
    layersRef.current.forEach((l) => l.remove());
    layersRef.current = [];

    const allBounds: [number, number][] = [];

    // Start marker
    if (start) {
      const m = L.marker([start.lat, start.lng], {
        icon: L.divIcon({
          html: `<div style="background:#10b981;width:28px;height:28px;border:3px solid #fff;border-radius:50%;box-shadow:0 2px 8px rgba(0,0,0,0.7);display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:900;color:#fff;">A</div>`,
          iconSize: [28, 28], iconAnchor: [14, 14], className: "",
        }),
      }).addTo(map).bindPopup(`<b>Start</b><br>${esc(start.label)}`);
      layersRef.current.push(m);
      allBounds.push([start.lat, start.lng]);
    }

    // End marker
    if (end) {
      const m = L.marker([end.lat, end.lng], {
        icon: L.divIcon({
          html: `<div style="background:#dc2626;width:28px;height:28px;border:3px solid #fff;border-radius:50%;box-shadow:0 2px 8px rgba(0,0,0,0.7);display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:900;color:#fff;">B</div>`,
          iconSize: [28, 28], iconAnchor: [14, 14], className: "",
        }),
      }).addTo(map).bindPopup(`<b>Destination</b><br>${esc(end.label)}`);
      layersRef.current.push(m);
      allBounds.push([end.lat, end.lng]);
    }

    // Connection line start->end (faint)
    if (start && end) {
      const conn = L.polyline(
        [[start.lat, start.lng], [end.lat, end.lng]],
        { color: "#94a3b8", weight: 1.5, opacity: 0.4, dashArray: "4 6" }
      ).addTo(map);
      layersRef.current.push(conn);
    }

    // Trails (use cached parsed GPX)
    trailGpxData.forEach(({ trail, wps }, idx) => {
      if (wps.length < 2) return;
      const isSelected = selectedIds.has(trail.id);
      const routeIdx = isSelected ? Array.from(selectedIds).indexOf(trail.id) + 1 : null;
      const diffColor = DIFFICULTY_COLORS[trail.difficulty ?? 5] ?? "#fbbf24";
      const latlngs: [number, number][] = wps.map((w) => [w.lat, w.lon]);

      // Underlay shadow
      const shadow = L.polyline(latlngs, {
        color: "#000",
        weight: isSelected ? 8 : 6,
        opacity: 0.5,
      }).addTo(map);
      layersRef.current.push(shadow);

      // Main polyline
      const main = L.polyline(latlngs, {
        color: isSelected ? "#f0a832" : diffColor,
        weight: isSelected ? 5 : 3.5,
        opacity: isSelected ? 1 : 0.85,
        dashArray: isSelected ? undefined : "8 4",
      }).addTo(map);
      main.on("click", () => onToggle(trail));
      layersRef.current.push(main);

      // Marker at trail midpoint
      const mid = latlngs[Math.floor(latlngs.length / 2)];
      const marker = L.marker(mid, {
        icon: L.divIcon({
          html: `<div style="
              background:${isSelected ? "#f0a832" : "rgba(20,15,10,0.85)"};
              border:2px solid ${isSelected ? "#fff" : diffColor};
              border-radius:6px;
              padding:3px 6px;
              display:flex;align-items:center;gap:4px;
              box-shadow:0 2px 6px rgba(0,0,0,0.7);
              white-space:nowrap;
              cursor:pointer;
              font-family:system-ui,sans-serif;
              transform:translate(-50%,-50%);
            ">
              <span style="
                background:${isSelected ? "#0a0a0a" : diffColor};
                color:${isSelected ? "#f0a832" : "#000"};
                width:16px;height:16px;border-radius:3px;
                font-size:9px;font-weight:900;
                display:flex;align-items:center;justify-content:center;
              ">${routeIdx ?? trail.difficulty ?? "?"}</span>
              <span style="
                color:${isSelected ? "#0a0a0a" : "#fff"};
                font-size:10px;font-weight:700;
                max-width:120px;overflow:hidden;text-overflow:ellipsis;
              ">${esc(trail.name)}</span>
              ${isSelected ? '<span style="color:#0a0a0a;font-weight:900;font-size:11px;">✓</span>' : '<span style="color:#fbbf24;font-weight:900;font-size:11px;">+</span>'}
            </div>`,
          iconSize: [0, 0], iconAnchor: [0, 0], className: "",
        }),
      }).addTo(map);
      marker.on("click", () => onToggle(trail));
      layersRef.current.push(marker);

      latlngs.forEach((c) => allBounds.push(c));
      void idx;
    });

    if (allBounds.length > 1) {
      try {
        map.fitBounds(allBounds, { padding: [40, 40], maxZoom: 13 });
      } catch {/* ignore */}
    } else if (allBounds.length === 1) {
      map.setView(allBounds[0], 12);
    }
  }, [start, end, trails, selectedIds, onToggle, leafletLoaded]);

  if (!start && !end && trails.length === 0) return null;

  return (
    <div className="bg-[hsl(22,15%,11%)] border border-[hsl(30,12%,20%)] rounded-xl overflow-hidden">
      <button
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center justify-between px-3 py-2.5 bg-gradient-to-r from-amber-900/30 to-stone-900/40 border-b border-amber-500/20"
      >
        <div className="flex items-center gap-2">
          <svg viewBox="0 0 24 24" className="w-4 h-4 text-amber-400" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/>
            <circle cx="12" cy="10" r="3"/>
          </svg>
          <span className="text-xs font-bold text-amber-300 uppercase tracking-wider">
            Trail Discovery Map
          </span>
          <span className="text-[10px] text-stone-400">
            · {trails.length} trail{trails.length !== 1 ? "s" : ""}
            {selectedIds.size > 0 ? ` · ${selectedIds.size} added` : ""}
          </span>
        </div>
        <svg viewBox="0 0 24 24" className={`w-4 h-4 text-stone-400 transition-transform ${expanded ? "rotate-180" : ""}`} fill="none" stroke="currentColor" strokeWidth="2.5">
          <polyline points="6 9 12 15 18 9"/>
        </svg>
      </button>

      {/* Container always mounted; collapse just hides via display:none so map stays valid */}
      <div style={{ display: expanded ? "block" : "none" }}>
        <div className="relative" style={{ height: "320px" }}>
          <div ref={containerRef} className="absolute inset-0 bg-stone-900" />
          {!leafletLoaded && (
            <div className="absolute inset-0 flex items-center justify-center bg-[hsl(22,15%,8%)]">
              <div className="text-center">
                <div className="w-7 h-7 border-2 border-amber-500/30 border-t-amber-500 rounded-full animate-spin mx-auto mb-2"></div>
                <p className="text-[11px] text-stone-400">Loading map...</p>
              </div>
            </div>
          )}
          {(!start || !end) && leafletLoaded && (
            <div className="absolute top-2 left-2 right-2 z-[500] bg-amber-900/80 border border-amber-500/40 rounded-lg px-2.5 py-1.5 backdrop-blur">
              <p className="text-[10px] text-amber-200 font-medium">
                {!start && !end ? "Add start & destination above to pin them on the map" :
                 !start ? "Add start address to pin point A" : "Add destination to pin point B"}
              </p>
            </div>
          )}
        </div>

        {/* Legend / hint */}
        <div className="px-3 py-2 bg-[hsl(22,15%,9%)] border-t border-[hsl(30,12%,18%)] flex items-center gap-3 flex-wrap">
          <div className="flex items-center gap-1.5">
            <div className="w-3 h-3 rounded-full bg-green-500 border border-white/60"></div>
            <span className="text-[10px] text-stone-400">Start</span>
          </div>
          <div className="flex items-center gap-1.5">
            <div className="w-3 h-3 rounded-full bg-red-600 border border-white/60"></div>
            <span className="text-[10px] text-stone-400">End</span>
          </div>
          <div className="flex items-center gap-1.5">
            <div className="w-4 h-1 rounded-full" style={{ background: "#f0a832" }}></div>
            <span className="text-[10px] text-amber-300">In route</span>
          </div>
          <div className="flex items-center gap-1.5 ml-auto">
            <span className="text-[10px] text-stone-500 italic">Tap any trail to add</span>
          </div>
        </div>
      </div>
    </div>
  );
}
