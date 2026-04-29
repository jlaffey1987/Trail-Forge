import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type Trail } from "@/lib/supabase";
import { type GeoPoint } from "@/lib/routing";
import {
  renderTrailLayer,
  type TrailLayerHandle,
  renderTrailClusters,
  clusterTrails,
  CLUSTER_ZOOM_THRESHOLD,
  type ClusterLayerHandle,
  type TrailCluster,
  getTrailBbox,
} from "@/lib/trailLayer";

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
  // Callback ref so the init effect re-fires the moment the container actually
  // mounts. The component does an early return when nothing to show, so the
  // container only appears after the first search — we cannot rely on a plain
  // useRef being populated by the time `leafletLoaded` flips to true.
  const [containerEl, setContainerEl] = useState<HTMLDivElement | null>(null);
  const setContainerRef = useCallback((el: HTMLDivElement | null) => {
    setContainerEl(el);
  }, []);
  // Map instance lives in state (not a ref) so the markers/trails effect can
  // re-run when the map is (re-)created — refs don't trigger re-renders.
  const [map, setMap] = useState<import("leaflet").Map | null>(null);
  const markerLayersRef = useRef<import("leaflet").Layer[]>([]);
  const trailLayerRef = useRef<TrailLayerHandle | null>(null);
  const clusterLayerRef = useRef<ClusterLayerHandle | null>(null);
  const [leafletLoaded, setLeafletLoaded] = useState(false);
  const [expanded, setExpanded] = useState(true);
  // Tracks the live map zoom so the trail layer can switch between cluster
  // markers (low zoom) and full polylines (high zoom) the same way MapTab
  // does. Initialized to the map's starting zoom in the init effect.
  const [currentZoom, setCurrentZoom] = useState<number>(6);

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

  // Init map — also tears down when the container unmounts (e.g. parent's
  // early return fires after results are cleared) so a future re-mount can
  // bind a fresh map instance.
  useEffect(() => {
    if (!leafletLoaded || !containerEl) return;
    const L = window.L;
    const instance = L.map(containerEl, { center: [54, -3], zoom: 6, zoomControl: true });
    L.tileLayer(
      "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
      { attribution: "Tiles © Esri", maxZoom: 19 }
    ).addTo(instance);
    setMap(instance);
    setCurrentZoom(instance.getZoom());
    const onZoom = () => setCurrentZoom(instance.getZoom());
    instance.on("zoomend", onZoom);
    return () => {
      try { instance.off("zoomend", onZoom); } catch { /* ignore */ }
      try { instance.remove(); } catch { /* ignore */ }
      markerLayersRef.current = [];
      trailLayerRef.current?.clear();
      trailLayerRef.current = null;
      clusterLayerRef.current?.clear();
      clusterLayerRef.current = null;
      setMap(null);
    };
  }, [leafletLoaded, containerEl]);

  // Trigger size recalc when collapsed/expanded toggles
  useEffect(() => {
    if (map && expanded) {
      setTimeout(() => map.invalidateSize(), 100);
    }
  }, [expanded, map]);

  const selectedIdSet = useMemo(() => new Set(selectedIds), [selectedIds]);

  // Start/end markers + initial fit-to-content. Intentionally NOT dependent
  // on `currentZoom` so user-driven zooming (e.g. drilling into a cluster)
  // doesn't immediately refit and snap back out.
  useEffect(() => {
    if (!map || !window.L) return;
    const L = window.L;

    markerLayersRef.current.forEach((l) => l.remove());
    markerLayersRef.current = [];

    const allBounds: [number, number][] = [];

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

    if (start && end) {
      const conn = L.polyline(
        [[start.lat, start.lng], [end.lat, end.lng]],
        { color: "#94a3b8", weight: 1.5, opacity: 0.4, dashArray: "4 6" }
      ).addTo(map);
      markerLayersRef.current.push(conn);
    }

    // Include each trail's bbox corners so fitBounds frames the discovered
    // trails too — same outcome as the previous renderer's polyline bounds
    // but without depending on whether we render polylines or clusters.
    for (const t of trails) {
      const bbox = getTrailBbox(t);
      if (!bbox) continue;
      allBounds.push([bbox.minLat, bbox.minLng]);
      allBounds.push([bbox.maxLat, bbox.maxLng]);
    }

    if (allBounds.length > 1) {
      try {
        map.fitBounds(allBounds, { padding: [40, 40], maxZoom: 13 });
      } catch {/* ignore */}
    } else if (allBounds.length === 1) {
      map.setView(allBounds[0], 12);
    }
  }, [start, end, trails, map]);

  // Render trail layer — clusters at low zoom, polylines higher up. Selected
  // route trails always render as polylines on top so the user can see the
  // route they've already built even when other trails are clustered.
  useEffect(() => {
    if (!map || !window.L) return;
    const L = window.L;

    trailLayerRef.current?.clear();
    trailLayerRef.current = null;
    clusterLayerRef.current?.clear();
    clusterLayerRef.current = null;

    if (trails.length === 0) return;

    if (currentZoom < CLUSTER_ZOOM_THRESHOLD) {
      // Cluster only the trails the user hasn't picked yet — selected route
      // trails stay drawn as polylines so the in-progress route is always
      // visible at any zoom.
      const unselected = selectedIdSet.size > 0
        ? trails.filter((t) => !selectedIdSet.has(t.id))
        : trails;
      const selectedTrails = selectedIdSet.size > 0
        ? trails.filter((t) => selectedIdSet.has(t.id))
        : [];

      const clusters = clusterTrails(unselected, currentZoom);
      const cHandle = renderTrailClusters(map, clusters, {
        onClusterClick: (cluster: TrailCluster) => {
          // Drill into the cluster's bbox. Single-trail clusters zoom
          // straight to the trail; multi-trail clusters cap at one level
          // past the threshold so the user can keep drilling further.
          try {
            const bounds = L.latLngBounds(
              [cluster.bbox.minLat, cluster.bbox.minLng],
              [cluster.bbox.maxLat, cluster.bbox.maxLng],
            );
            if (cluster.count === 1) {
              map.fitBounds(bounds, { padding: [40, 40], maxZoom: 14 });
              return;
            }
            const z = map.getZoom();
            const targetMax = Math.max(
              CLUSTER_ZOOM_THRESHOLD,
              Math.min(CLUSTER_ZOOM_THRESHOLD + 2, z + 3),
            );
            map.fitBounds(bounds, { padding: [40, 40], maxZoom: targetMax });
          } catch {
            map.setView(
              [cluster.lat, cluster.lng],
              Math.min(CLUSTER_ZOOM_THRESHOLD + 1, map.getZoom() + 3),
            );
          }
        },
      });
      clusterLayerRef.current = cHandle;

      if (selectedTrails.length > 0) {
        const tHandle = renderTrailLayer(map, selectedTrails, {
          selectedIds: selectedIdSet,
          selectedColor: "#f0a832",
          showLabels: true,
          shadow: true,
          onTrailClick: onToggle,
        });
        trailLayerRef.current = tHandle;
      }
      return;
    }

    // Higher zoom: original polyline rendering for every trail.
    const handle = renderTrailLayer(map, trails, {
      selectedIds: selectedIdSet,
      selectedColor: "#f0a832",
      showLabels: true,
      shadow: true,
      onTrailClick: onToggle,
    });
    trailLayerRef.current = handle;
  }, [trails, selectedIdSet, onToggle, map, currentZoom]);

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
          <div ref={setContainerRef} className="absolute inset-0 bg-stone-900" />
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
          {leafletLoaded && currentZoom < CLUSTER_ZOOM_THRESHOLD && trails.length > 0 && (
            <div className="absolute bottom-2 left-2 z-[500] bg-stone-900/80 border border-stone-700/60 rounded-md px-2 py-1 backdrop-blur">
              <p className="text-[10px] text-stone-300 font-medium">
                Zoom in or tap a cluster to see individual trails
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
