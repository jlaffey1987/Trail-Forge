import { useEffect, useMemo, useRef, useState } from "react";
import { type Trail } from "@/lib/supabase";
import { type GeoPoint } from "@/lib/routing";
import { renderTrailLayer, type TrailLayerHandle } from "@/lib/trailLayer";

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
  const markerLayersRef = useRef<import("leaflet").Layer[]>([]);
  const trailLayerRef = useRef<TrailLayerHandle | null>(null);
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

  // Init map
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
      markerLayersRef.current = [];
      trailLayerRef.current?.clear();
      trailLayerRef.current = null;
    };
  }, []);

  // Trigger size recalc when collapsed/expanded toggles
  useEffect(() => {
    if (mapRef.current && expanded) {
      setTimeout(() => mapRef.current?.invalidateSize(), 100);
    }
  }, [expanded]);

  const selectedIdSet = useMemo(() => new Set(selectedIds), [selectedIds]);

  // Render markers + trails
  useEffect(() => {
    if (!mapRef.current || !window.L) return;
    const L = window.L;
    const map = mapRef.current;

    // Clear previous start/end markers + connection
    markerLayersRef.current.forEach((l) => l.remove());
    markerLayersRef.current = [];
    trailLayerRef.current?.clear();
    trailLayerRef.current = null;

    const allBounds: [number, number][] = [];

    // Start marker
    if (start) {
      const m = L.marker([start.lat, start.lng], {
        icon: L.divIcon({
          html: `<div style="background:#10b981;width:28px;height:28px;border:3px solid #fff;border-radius:50%;box-shadow:0 2px 8px rgba(0,0,0,0.7);display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:900;color:#fff;">A</div>`,
          iconSize: [28, 28], iconAnchor: [14, 14], className: "",
        }),
      }).addTo(map).bindPopup(`<b>Start</b><br>${esc(start.label)}`);
      markerLayersRef.current.push(m);
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
      markerLayersRef.current.push(m);
      allBounds.push([end.lat, end.lng]);
    }

    // Connection line start->end (faint)
    if (start && end) {
      const conn = L.polyline(
        [[start.lat, start.lng], [end.lat, end.lng]],
        { color: "#94a3b8", weight: 1.5, opacity: 0.4, dashArray: "4 6" }
      ).addTo(map);
      markerLayersRef.current.push(conn);
    }

    // Trails — uses the shared renderer (parse cache is shared with MapTab)
    const handle = renderTrailLayer(map, trails, {
      selectedIds: selectedIdSet,
      selectedColor: "#f0a832",
      showLabels: true,
      shadow: true,
      onTrailClick: onToggle,
    });
    trailLayerRef.current = handle;
    for (const c of handle.bounds) allBounds.push(c);

    if (allBounds.length > 1) {
      try {
        map.fitBounds(allBounds, { padding: [40, 40], maxZoom: 13 });
      } catch {/* ignore */}
    } else if (allBounds.length === 1) {
      map.setView(allBounds[0], 12);
    }
  }, [start, end, trails, selectedIdSet, onToggle, leafletLoaded]);

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
