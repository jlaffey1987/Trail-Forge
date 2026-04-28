import { useEffect, useRef, useState, useCallback, useMemo } from "react";
import GpsRecorder from "@/components/GpsRecorder";
import LayersPanel, { type MapLayer, type BaseMap } from "@/components/LayersPanel";
import TrailDetailSheet from "@/components/TrailDetailSheet";
import MapTrailFilters, { type MapTrailFilterState } from "@/components/MapTrailFilters";
import AddTrailMenu, { type AddTrailChoice } from "@/components/contribute/AddTrailMenu";
import SaveTrailForm from "@/components/contribute/SaveTrailForm";
import UploadGpxFlow from "@/components/contribute/UploadGpxFlow";
import { useLeaflet } from "@/lib/useLeaflet";
import {
  addTrail,
  fetchTrailsInBbox,
  type Trail,
  type MapBbox,
} from "@/lib/supabase";
import {
  renderTrailLayer,
  type TrailLayerHandle,
  DIFFICULTY_BUCKETS,
  getTrailBbox,
  bboxesIntersect,
} from "@/lib/trailLayer";
import { useRouteTrails } from "@/lib/plannerRouteStore";

interface Waypoint {
  id: number;
  lat: number;
  lng: number;
}

declare global {
  interface Window {
    L: typeof import("leaflet");
  }
}

type MapMode = "explore" | "draw" | "record";

const TILE_URLS: Record<BaseMap, string> = {
  satellite:
    "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
  topo: "https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png",
  "os-outdoor": "", // filled dynamically with OS API key
};

const TILE_ATTRS: Record<BaseMap, string> = {
  satellite:
    "Tiles © Esri — Source: Esri, i-cubed, USDA, AEX, GeoEye, Getmapping, Aerogrid, IGN, IGP",
  topo:
    "Map data © OpenStreetMap contributors, SRTM | Map style © OpenTopoMap (CC-BY-SA)",
  "os-outdoor":
    "Contains OS data © Crown copyright and database right 2024",
};

export default function MapTab() {
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<import("leaflet").Map | null>(null);
  const markersRef = useRef<import("leaflet").Marker[]>([]);
  const drawPolylineRef = useRef<import("leaflet").Polyline | null>(null);
  const tileLayerRef = useRef<import("leaflet").TileLayer | null>(null);
  const layerPolylinesRef = useRef<Map<string, import("leaflet").Polyline[]>>(new Map());
  const trailLayerHandleRef = useRef<TrailLayerHandle | null>(null);
  const fetchSeqRef = useRef(0);
  const fetchDebounceRef = useRef<number | null>(null);

  const [mapMode, setMapMode] = useState<MapMode>("explore");
  const [waypoints, setWaypoints] = useState<Waypoint[]>([]);
  const [totalKm, setTotalKm] = useState(0);
  // Shared loader hook — also used by UploadGpxFlow's preview map so the upload
  // flow works even when the user opens it from My Trails before visiting Map.
  const leafletLoaded = useLeaflet();
  const [showLayers, setShowLayers] = useState(false);

  // Layer state
  const [layers, setLayers] = useState<MapLayer[]>([]);
  const [baseMap, setBaseMap] = useState<BaseMap>("satellite");
  const [osApiKey, setOsApiKey] = useState("");

  // Public-trails layer state
  const [allTrails, setAllTrails] = useState<Trail[]>([]);
  const [trailsLoading, setTrailsLoading] = useState(false);
  const [usedServerBbox, setUsedServerBbox] = useState<boolean | null>(null);
  const [filters, setFilters] = useState<MapTrailFilterState>({ difficulties: [], trailTypes: [] });
  const [showFilters, setShowFilters] = useState(false);
  const [showLegend, setShowLegend] = useState(true);
  const [selectedTrail, setSelectedTrail] = useState<Trail | null>(null);
  const [currentZoom, setCurrentZoom] = useState(7);
  const [, setCurrentBbox] = useState<MapBbox | null>(null);

  const [routeTrails] = useRouteTrails();
  const routeIdSet = useMemo(() => new Set(routeTrails.map((t) => t.id)), [routeTrails]);

  // "+ Add Trail" / contribute flows
  const [showAddMenu, setShowAddMenu] = useState(false);
  const [showUploadGpx, setShowUploadGpx] = useState(false);
  const [showDrawSave, setShowDrawSave] = useState(false);
  const [savedTrailToast, setSavedTrailToast] = useState<string | null>(null);

  const mapModeRef = useRef(mapMode);
  const waypointsRef = useRef(waypoints);
  mapModeRef.current = mapMode;
  waypointsRef.current = waypoints;

  // Leaflet is loaded by the `useLeaflet()` hook above.

  // ---------------------------------------------------------------------------
  // Bbox-debounced trail fetch
  // ---------------------------------------------------------------------------
  const fetchTrailsForCurrentView = useCallback(async () => {
    if (!mapRef.current) return;
    const map = mapRef.current;
    const b = map.getBounds();
    const bbox: MapBbox = {
      minLat: b.getSouth(),
      maxLat: b.getNorth(),
      minLng: b.getWest(),
      maxLng: b.getEast(),
    };
    setCurrentBbox(bbox);
    const seq = ++fetchSeqRef.current;
    setTrailsLoading(true);
    const { trails, usedBbox } = await fetchTrailsInBbox(bbox, {
      difficulties: filters.difficulties.length > 0 ? filters.difficulties : undefined,
      trailTypes: filters.trailTypes.length > 0 ? filters.trailTypes : undefined,
      limit: 200,
    });
    if (seq !== fetchSeqRef.current) return; // stale
    setUsedServerBbox(usedBbox);
    setAllTrails(trails);
    setTrailsLoading(false);
  }, [filters.difficulties, filters.trailTypes]);

  const scheduleFetch = useCallback(() => {
    if (fetchDebounceRef.current != null) {
      window.clearTimeout(fetchDebounceRef.current);
    }
    fetchDebounceRef.current = window.setTimeout(() => {
      fetchDebounceRef.current = null;
      void fetchTrailsForCurrentView();
    }, 350);
  }, [fetchTrailsForCurrentView]);

  // Init map
  useEffect(() => {
    if (!leafletLoaded || !mapContainerRef.current || mapRef.current) return;
    const L = window.L;
    const map = L.map(mapContainerRef.current, { center: [53.2, -1.8], zoom: 7, zoomControl: true });

    // Dedicated pane for the public-trails layer with a lower z-index than the
    // default overlayPane (400). Draw waypoints / recorded GPS lines render in
    // the default pane so they always appear on top of trail polylines.
    map.createPane("trailsPane");
    const trailsPane = map.getPane("trailsPane");
    if (trailsPane) trailsPane.style.zIndex = "380";

    const tileLayer = L.tileLayer(TILE_URLS.satellite, { attribution: TILE_ATTRS.satellite, maxZoom: 19 });
    tileLayer.addTo(map);
    tileLayerRef.current = tileLayer;

    map.on("click", (e: import("leaflet").LeafletMouseEvent) => {
      if (mapModeRef.current !== "draw") return;
      const L = window.L;
      const { lat, lng } = e.latlng;
      const id = Date.now();
      const svgMarker = L.divIcon({
        html: `<div style="width:20px;height:20px;background:#d4870c;border:2.5px solid #fff;border-radius:50% 50% 50% 0;transform:rotate(-45deg);box-shadow:0 2px 8px rgba(0,0,0,0.6);"></div>`,
        iconSize: [20, 20], iconAnchor: [10, 20], className: "",
      });
      const marker = L.marker([lat, lng], { icon: svgMarker }).addTo(map);
      markersRef.current.push(marker);
      const newWaypoints = [...waypointsRef.current, { id, lat, lng }];
      setWaypoints(newWaypoints);
      waypointsRef.current = newWaypoints;
      if (drawPolylineRef.current) drawPolylineRef.current.remove();
      if (newWaypoints.length >= 2) {
        const latlngs = newWaypoints.map((wp) => [wp.lat, wp.lng] as [number, number]);
        drawPolylineRef.current = L.polyline(latlngs, { color: "#f0a832", weight: 3.5, opacity: 0.85 }).addTo(map);
        let dist = 0;
        for (let i = 1; i < newWaypoints.length; i++) {
          dist += L.latLng(newWaypoints[i - 1].lat, newWaypoints[i - 1].lng).distanceTo(L.latLng(newWaypoints[i].lat, newWaypoints[i].lng));
        }
        setTotalKm(dist / 1000);
      }
    });

    // Re-fetch trails on viewport change (debounced)
    map.on("moveend zoomend", () => {
      setCurrentZoom(map.getZoom());
      scheduleFetch();
    });

    setCurrentZoom(map.getZoom());
    mapRef.current = map;
    // Initial fetch
    void fetchTrailsForCurrentView();
  }, [leafletLoaded, scheduleFetch, fetchTrailsForCurrentView]);

  // Re-fetch when filters change (so server-side filters are applied)
  useEffect(() => {
    if (!mapRef.current) return;
    void fetchTrailsForCurrentView();
  }, [fetchTrailsForCurrentView]);

  // Switch base map tile layer
  useEffect(() => {
    if (!mapRef.current || !tileLayerRef.current || !window.L) return;
    const L = window.L;
    const map = mapRef.current;

    tileLayerRef.current.remove();

    let url = TILE_URLS[baseMap];
    if (baseMap === "os-outdoor") {
      url = osApiKey
        ? `https://api.os.uk/maps/raster/v1/zxy/Outdoor_3857/{z}/{x}/{y}?key=${osApiKey}`
        : TILE_URLS.satellite; // fallback
    }

    const newTile = L.tileLayer(url, {
      attribution: TILE_ATTRS[baseMap],
      maxZoom: 20,
      subdomains: baseMap === "topo" ? ["a", "b", "c"] : undefined,
    } as Parameters<typeof L.tileLayer>[1]);

    newTile.addTo(map);
    tileLayerRef.current = newTile;
  }, [baseMap, osApiKey]);

  // ---------------------------------------------------------------------------
  // Trail layer rendering — visible in every mode so users can see public
  // trails while drawing or recording. In Draw / Record the polylines are
  // non-interactive so map clicks pass through to the waypoint / GPS handlers.
  // ---------------------------------------------------------------------------
  const visibleTrails = useMemo(() => {
    let trails = allTrails;
    // Apply client-side filters (cheap second pass — also covers fallback fetch).
    if (filters.difficulties.length > 0) {
      trails = trails.filter((t) => t.difficulty != null && filters.difficulties.includes(t.difficulty));
    }
    if (filters.trailTypes.length > 0) {
      trails = trails.filter((t) => t.legal_status != null && filters.trailTypes.includes(t.legal_status));
    }
    return trails;
  }, [allTrails, filters.difficulties, filters.trailTypes]);

  // Trails actually visible in viewport (always client-side bbox filter as safety net)
  const trailsForRender = useMemo(() => {
    if (!mapRef.current) return visibleTrails;
    try {
      const b = mapRef.current.getBounds();
      const viewport = {
        minLat: b.getSouth(),
        maxLat: b.getNorth(),
        minLng: b.getWest(),
        maxLng: b.getEast(),
      };
      return visibleTrails.filter((t) => {
        const tb = getTrailBbox(t);
        if (!tb) return false;
        return bboxesIntersect(tb, viewport);
      });
    } catch {
      return visibleTrails;
    }
    // currentZoom included so recompute when viewport changes.
  }, [visibleTrails, currentZoom]);

  // (Re)render trail layer whenever inputs change. The layer renders in every
  // mode; only Explore makes the polylines clickable.
  useEffect(() => {
    if (!mapRef.current || !window.L) return;
    trailLayerHandleRef.current?.clear();
    trailLayerHandleRef.current = null;

    if (trailsForRender.length === 0) return;

    const isExplore = mapMode === "explore";
    const handle = renderTrailLayer(mapRef.current, trailsForRender, {
      selectedIds: routeIdSet,
      selectedColor: "#f0a832",
      showLabels: false,
      shadow: false,
      simplifyForZoom: currentZoom,
      pane: "trailsPane",
      interactive: isExplore,
      onTrailClick: isExplore ? (trail) => setSelectedTrail(trail) : undefined,
    });
    trailLayerHandleRef.current = handle;
  }, [trailsForRender, mapMode, routeIdSet, currentZoom]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (fetchDebounceRef.current != null) window.clearTimeout(fetchDebounceRef.current);
      trailLayerHandleRef.current?.clear();
    };
  }, []);

  // Render / update overlay layers on map
  const renderLayers = useCallback((updatedLayers: MapLayer[]) => {
    if (!mapRef.current || !window.L) return;
    const L = window.L;
    const map = mapRef.current;
    const polylinesMap = layerPolylinesRef.current;

    // Remove layers that no longer exist
    const currentIds = new Set(updatedLayers.map((l) => l.id));
    for (const [id, pls] of polylinesMap.entries()) {
      if (!currentIds.has(id)) {
        pls.forEach((pl) => pl.remove());
        polylinesMap.delete(id);
      }
    }

    for (const layer of updatedLayers) {
      const existing = polylinesMap.get(layer.id);

      if (!layer.visible) {
        existing?.forEach((pl) => pl.remove());
        continue;
      }

      if (existing) {
        existing.forEach((pl) => pl.addTo(map));
        continue;
      }

      const pls: import("leaflet").Polyline[] = [];
      for (const seg of layer.polylines) {
        if (seg.length < 2) continue;
        const pl = L.polyline(seg, {
          color: layer.color,
          weight: layer.source === "import" ? 4 : 3,
          opacity: 0.85,
        }).addTo(map);
        pls.push(pl);
      }
      polylinesMap.set(layer.id, pls);

      if (pls.length > 0) {
        try {
          const group = L.featureGroup(pls);
          map.fitBounds(group.getBounds(), { padding: [40, 40] });
        } catch {
          // bounds error — ignore
        }
      }
    }
  }, []);

  const handleLayersChange = useCallback((updatedLayers: MapLayer[]) => {
    setLayers(updatedLayers);
    renderLayers(updatedLayers);
  }, [renderLayers]);

  useEffect(() => {
    renderLayers(layers);
  }, [layers, renderLayers]);

  const clearWaypoints = () => {
    markersRef.current.forEach((m) => m.remove());
    markersRef.current = [];
    if (drawPolylineRef.current) { drawPolylineRef.current.remove(); drawPolylineRef.current = null; }
    setWaypoints([]);
    setTotalKm(0);
  };

  const undoWaypoint = () => {
    if (markersRef.current.length === 0) return;
    markersRef.current.pop()?.remove();
    const newWaypoints = waypointsRef.current.slice(0, -1);
    setWaypoints(newWaypoints);
    waypointsRef.current = newWaypoints;
    if (drawPolylineRef.current) { drawPolylineRef.current.remove(); drawPolylineRef.current = null; }
    if (newWaypoints.length >= 2 && mapRef.current) {
      const L = window.L;
      const latlngs = newWaypoints.map((wp) => [wp.lat, wp.lng] as [number, number]);
      drawPolylineRef.current = L.polyline(latlngs, { color: "#f0a832", weight: 3.5, opacity: 0.85 }).addTo(mapRef.current);
      let dist = 0;
      for (let i = 1; i < newWaypoints.length; i++) {
        dist += L.latLng(newWaypoints[i - 1].lat, newWaypoints[i - 1].lng).distanceTo(L.latLng(newWaypoints[i].lat, newWaypoints[i].lng));
      }
      setTotalKm(dist / 1000);
    } else {
      setTotalKm(0);
    }
  };

  const activeLayerCount = layers.filter((l) => l.visible).length;
  const filterCount = filters.difficulties.length + filters.trailTypes.length;

  const handleAddChoice = (choice: AddTrailChoice) => {
    setShowAddMenu(false);
    if (choice === "upload") {
      setShowUploadGpx(true);
    } else if (choice === "record") {
      setMapMode("record");
    } else if (choice === "draw") {
      setMapMode("draw");
    }
  };

  // Deep-link handoff from other tabs (e.g. My Trails → "Record" / "Draw").
  // We read `?mode=upload|record|draw` once on mount, trigger the matching
  // contribute flow, then strip the param from the URL so a refresh doesn't
  // re-open the modal.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const mode = params.get("mode");
    if (mode === "upload" || mode === "record" || mode === "draw") {
      handleAddChoice(mode as AddTrailChoice);
      params.delete("mode");
      const qs = params.toString();
      const newUrl =
        window.location.pathname + (qs ? `?${qs}` : "") + window.location.hash;
      window.history.replaceState(null, "", newUrl);
    }
    // Run only on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const drawWaypoints = useMemo(
    () => waypoints.map((wp) => ({ lat: wp.lat, lon: wp.lng })),
    [waypoints],
  );

  const buildDrawnGpx = (): string => {
    const stamp = new Date().toISOString();
    const trkpts = waypoints
      .map((wp) => `      <trkpt lat="${wp.lat}" lon="${wp.lng}"></trkpt>`)
      .join("\n");
    return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="TrailForge" xmlns="http://www.topografix.com/GPX/1/1">
  <metadata><time>${stamp}</time></metadata>
  <trk>
    <trkseg>
${trkpts}
    </trkseg>
  </trk>
</gpx>`;
  };

  // Auto-clear save toast.
  useEffect(() => {
    if (!savedTrailToast) return;
    const t = window.setTimeout(() => setSavedTrailToast(null), 4000);
    return () => window.clearTimeout(t);
  }, [savedTrailToast]);

  return (
    <div className="flex flex-col h-full relative">

      {/* Top controls bar */}
      <div className="absolute top-0 left-0 right-0 z-[1000] flex items-center justify-between px-3 py-2 pointer-events-none">

        {/* Left: mode toggle */}
        <div className="pointer-events-auto flex items-center gap-1 bg-black/65 backdrop-blur rounded-xl px-1.5 py-1.5 border border-stone-700/50">
          <button
            onClick={() => setMapMode("explore")}
            className={`flex items-center gap-1 px-2 py-1.5 rounded-lg text-xs font-bold uppercase tracking-wider transition-all ${
              mapMode === "explore" ? "bg-stone-700 text-stone-100 shadow" : "text-stone-500 hover:text-stone-300"
            }`}
            data-testid="map-mode-explore"
          >
            <svg viewBox="0 0 24 24" className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="10"/><polygon points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76"/>
            </svg>
            Explore
          </button>
          <div className="w-px h-4 bg-stone-700"></div>
          <button
            onClick={() => setMapMode("draw")}
            className={`flex items-center gap-1 px-2 py-1.5 rounded-lg text-xs font-bold uppercase tracking-wider transition-all ${
              mapMode === "draw" ? "bg-amber-500 text-stone-900 shadow-lg shadow-amber-500/30" : "text-stone-500 hover:text-stone-300"
            }`}
            data-testid="map-mode-draw"
          >
            <svg viewBox="0 0 24 24" className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2.5">
              <path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/>
            </svg>
            Draw
          </button>
          <div className="w-px h-4 bg-stone-700"></div>
          <button
            onClick={() => setMapMode("record")}
            className={`flex items-center gap-1 px-2 py-1.5 rounded-lg text-xs font-bold uppercase tracking-wider transition-all ${
              mapMode === "record" ? "bg-red-600 text-white shadow-lg shadow-red-600/30" : "text-stone-500 hover:text-stone-300"
            }`}
            data-testid="map-mode-record"
          >
            <span className={`w-2 h-2 rounded-full ${mapMode === "record" ? "bg-white animate-pulse" : "bg-stone-500"}`}></span>
            Record
          </button>
        </div>

        {/* Right: draw tools + filters + layers + legend */}
        <div className="pointer-events-auto flex items-center gap-1.5">
          {mapMode === "draw" && waypoints.length > 0 && (
            <>
              <button
                onClick={undoWaypoint}
                className="p-1.5 rounded-lg bg-black/65 border border-stone-600/60 text-stone-300 backdrop-blur hover:bg-stone-700/60 transition-colors"
              >
                <svg viewBox="0 0 24 24" className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2">
                  <polyline points="9 14 4 9 9 4"/><path d="M20 20v-7a4 4 0 0 0-4-4H4"/>
                </svg>
              </button>
              <button
                onClick={clearWaypoints}
                className="p-1.5 rounded-lg bg-black/65 border border-red-600/50 text-red-400 backdrop-blur hover:bg-red-900/30 transition-colors"
              >
                <svg viewBox="0 0 24 24" className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2">
                  <polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>
                </svg>
              </button>
            </>
          )}

          {/* Filters button (only meaningful in Explore) */}
          {mapMode === "explore" && (
            <button
              onClick={() => setShowFilters(true)}
              className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl text-xs font-bold uppercase tracking-wider border backdrop-blur transition-all ${
                filterCount > 0
                  ? "bg-amber-500/20 border-amber-500/60 text-amber-300"
                  : "bg-black/65 border-stone-600/60 text-stone-300"
              }`}
              data-testid="map-filters-button"
            >
              <svg viewBox="0 0 24 24" className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2">
                <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/>
              </svg>
              Filters
              {filterCount > 0 && (
                <span className="bg-amber-500 text-stone-900 text-[9px] font-black w-4 h-4 rounded-full flex items-center justify-center">
                  {filterCount}
                </span>
              )}
            </button>
          )}

          {/* Layers button */}
          <button
            onClick={() => setShowLayers(true)}
            className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl text-xs font-bold uppercase tracking-wider border backdrop-blur transition-all ${
              activeLayerCount > 0
                ? "bg-amber-500/20 border-amber-500/60 text-amber-300"
                : "bg-black/65 border-stone-600/60 text-stone-300"
            }`}
            data-testid="map-layers-button"
          >
            <svg viewBox="0 0 24 24" className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2">
              <polygon points="12 2 2 7 12 12 22 7 12 2"/>
              <polyline points="2 17 12 22 22 17"/>
              <polyline points="2 12 12 17 22 12"/>
            </svg>
            Layers
            {activeLayerCount > 0 && (
              <span className="bg-amber-500 text-stone-900 text-[9px] font-black w-4 h-4 rounded-full flex items-center justify-center">
                {activeLayerCount}
              </span>
            )}
          </button>
        </div>
      </div>

      {/* Mode hints */}
      {mapMode === "draw" && (
        <div className="absolute top-12 left-1/2 -translate-x-1/2 z-[1000] bg-amber-500/90 text-stone-900 text-xs font-bold px-3 py-1.5 rounded-full shadow-lg pointer-events-none whitespace-nowrap">
          Tap map to add waypoints
        </div>
      )}
      {mapMode === "record" && (
        <div className="absolute top-12 left-1/2 -translate-x-1/2 z-[1000] bg-red-600/90 text-white text-xs font-bold px-3 py-1.5 rounded-full shadow-lg pointer-events-none whitespace-nowrap flex items-center gap-1.5">
          <span className="w-2 h-2 rounded-full bg-white animate-pulse"></span>
          GPS Record Mode — tap Start below
        </div>
      )}

      {/* Trail status pill (Explore mode) */}
      {mapMode === "explore" && (
        <div className="absolute top-12 left-1/2 -translate-x-1/2 z-[1000] pointer-events-none">
          <div className="bg-black/70 backdrop-blur border border-stone-700/60 text-[10px] font-bold uppercase tracking-wider px-3 py-1 rounded-full text-stone-200 flex items-center gap-1.5 shadow-lg">
            {trailsLoading ? (
              <>
                <span className="w-2.5 h-2.5 border border-amber-500/50 border-t-amber-500 rounded-full animate-spin"></span>
                Loading trails…
              </>
            ) : (
              <>
                <span className="w-1.5 h-1.5 rounded-full bg-amber-400"></span>
                <span data-testid="map-trail-count">{trailsForRender.length}</span> trail{trailsForRender.length !== 1 ? "s" : ""} in view
                {usedServerBbox === false && allTrails.length >= 200 && (
                  <span className="text-amber-400 ml-1" title="Apply the bbox migration for faster loads">⚠</span>
                )}
              </>
            )}
          </div>
        </div>
      )}

      {/* Active import-layer legend (TET/ACT/imports) */}
      {activeLayerCount > 0 && (
        <div className="absolute top-24 left-3 z-[999] flex flex-col gap-1">
          {layers.filter((l) => l.visible).map((l) => (
            <div key={l.id} className="flex items-center gap-1.5 bg-black/70 backdrop-blur rounded-lg px-2 py-1 text-[10px] font-medium text-stone-200">
              <div className="w-3 h-0.5 rounded-full" style={{ background: l.color }}></div>
              {l.name.length > 20 ? l.name.slice(0, 20) + "…" : l.name}
            </div>
          ))}
        </div>
      )}

      {/* Difficulty legend (Explore mode) */}
      {mapMode === "explore" && (
        <div className="absolute bottom-3 left-3 z-[999] pointer-events-auto">
          {showLegend ? (
            <div className="bg-black/75 backdrop-blur border border-stone-700/60 rounded-xl p-2 shadow-lg">
              <div className="flex items-center justify-between gap-2 mb-1.5 px-1">
                <span className="text-[9px] font-bold uppercase tracking-widest text-stone-400">Difficulty</span>
                <button
                  onClick={() => setShowLegend(false)}
                  className="text-stone-500 hover:text-stone-300 text-xs leading-none"
                  aria-label="Hide legend"
                >×</button>
              </div>
              <div className="flex flex-col gap-0.5" data-testid="difficulty-legend">
                {DIFFICULTY_BUCKETS.map((b) => (
                  <div key={b.label} className="flex items-center gap-2 px-1">
                    <div className="w-4 h-1 rounded-full" style={{ background: b.color }}></div>
                    <span className="text-[10px] text-stone-200 font-medium">{b.label}</span>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <button
              onClick={() => setShowLegend(true)}
              className="bg-black/70 backdrop-blur border border-stone-700/60 text-[10px] font-bold uppercase tracking-wider px-2.5 py-1.5 rounded-full text-stone-200 flex items-center gap-1.5"
              data-testid="show-legend-button"
            >
              <svg viewBox="0 0 24 24" className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth="2">
                <line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/>
                <line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/>
              </svg>
              Legend
            </button>
          )}
        </div>
      )}

      {/* Map */}
      <div
        ref={mapContainerRef}
        className="flex-1"
        style={{ cursor: mapMode === "draw" ? "crosshair" : "grab" }}
      >
        {!leafletLoaded && (
          <div className="w-full h-full flex items-center justify-center bg-[hsl(22,15%,8%)]">
            <div className="text-center">
              <div className="w-8 h-8 border-2 border-amber-500/30 border-t-amber-500 rounded-full animate-spin mx-auto mb-3"></div>
              <p className="text-sm text-stone-400">Loading satellite map...</p>
            </div>
          </div>
        )}
      </div>

      {/* Draw mode stats bar */}
      {mapMode === "draw" && (
        <div className="absolute bottom-0 left-0 right-0 z-[1000] bg-gradient-to-t from-black/80 to-transparent pt-6">
          <div className="flex items-center justify-between px-4 pb-2">
            <div className="flex items-center gap-4">
              <div>
                <div className="text-xs text-stone-500 uppercase tracking-wider">Distance</div>
                <div className="text-base font-bold text-amber-400">{totalKm > 0 ? `${totalKm.toFixed(1)} km` : "0.0 km"}</div>
              </div>
              <div className="w-px h-8 bg-stone-700"></div>
              <div>
                <div className="text-xs text-stone-500 uppercase tracking-wider">Waypoints</div>
                <div className="text-base font-bold text-amber-400">{waypoints.length}</div>
              </div>
              {totalKm > 0 && (
                <>
                  <div className="w-px h-8 bg-stone-700"></div>
                  <div>
                    <div className="text-xs text-stone-500 uppercase tracking-wider">Est. Time</div>
                    <div className="text-base font-bold text-amber-400">{Math.round((totalKm / 15) * 60)}m</div>
                  </div>
                </>
              )}
            </div>
            {waypoints.length >= 2 && (
              <button
                onClick={() => setShowDrawSave(true)}
                className="px-3 py-2 rounded-lg text-xs font-bold uppercase tracking-wider text-stone-900"
                style={{ background: "linear-gradient(135deg, #d4870c, #f0a832)" }}
                data-testid="map-save-drawn-trail"
              >
                Save Trail
              </button>
            )}
          </div>
        </div>
      )}

      {/* GPS Recorder */}
      {mapMode === "record" && (
        <GpsRecorder
          mapRef={mapRef}
          leafletLoaded={leafletLoaded}
          onSaved={() => {
            setSavedTrailToast("Trail saved");
            setMapMode("explore");
            void fetchTrailsForCurrentView();
          }}
        />
      )}

      {/* Layers Panel */}
      {showLayers && (
        <LayersPanel
          onClose={() => setShowLayers(false)}
          layers={layers}
          onLayersChange={handleLayersChange}
          baseMap={baseMap}
          onBaseMapChange={setBaseMap}
          osApiKey={osApiKey}
          onOsApiKeyChange={setOsApiKey}
        />
      )}

      {/* Trail filters */}
      <MapTrailFilters
        open={showFilters}
        filters={filters}
        onChange={setFilters}
        onClose={() => setShowFilters(false)}
        visibleCount={trailsForRender.length}
      />

      {/* Trail detail sheet */}
      {selectedTrail && (
        <TrailDetailSheet
          trail={selectedTrail}
          onClose={() => setSelectedTrail(null)}
        />
      )}

      {/* "+ Add Trail" floating button — only in Explore so it doesn't clash
          with the Draw stats bar or GPS recorder controls. */}
      {mapMode === "explore" && (
        <button
          onClick={() => setShowAddMenu(true)}
          className="absolute bottom-4 right-3 z-[1100] flex items-center gap-1.5 px-3.5 py-2.5 rounded-full font-bold text-xs uppercase tracking-widest text-stone-900 shadow-lg"
          style={{ background: "linear-gradient(135deg, #d4870c, #f0a832)" }}
          data-testid="map-add-trail"
        >
          <svg viewBox="0 0 24 24" className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2.5">
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
          Add Trail
        </button>
      )}

      {/* Save toast */}
      {savedTrailToast && (
        <div className="absolute top-24 left-1/2 -translate-x-1/2 z-[1500] bg-green-900/90 border border-green-500/40 text-green-200 text-xs font-bold px-3 py-2 rounded-full shadow-lg flex items-center gap-2">
          <svg viewBox="0 0 24 24" className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2.5">
            <polyline points="20 6 9 17 4 12" />
          </svg>
          {savedTrailToast}
        </div>
      )}

      {/* Add Trail chooser */}
      <AddTrailMenu
        open={showAddMenu}
        onClose={() => setShowAddMenu(false)}
        onChoose={handleAddChoice}
      />

      {/* Upload GPX flow */}
      <UploadGpxFlow
        open={showUploadGpx}
        onClose={() => setShowUploadGpx(false)}
        onSaved={() => {
          setSavedTrailToast("Trail uploaded");
          void fetchTrailsForCurrentView();
        }}
      />

      {/* Save drawn trail */}
      <SaveTrailForm
        open={showDrawSave}
        title="Save Drawn Trail"
        waypoints={drawWaypoints}
        gpxData={showDrawSave ? buildDrawnGpx() : ""}
        prefill={{ distanceKm: totalKm }}
        onCancel={() => setShowDrawSave(false)}
        onSave={async ({ input }) => {
          const trail = await addTrail(input);
          if (!trail) {
            return { ok: false, error: "Could not save trail. Are you signed in?" };
          }
          setShowDrawSave(false);
          clearWaypoints();
          setMapMode("explore");
          setSavedTrailToast("Trail saved");
          void fetchTrailsForCurrentView();
          return { ok: true };
        }}
      />
    </div>
  );
}
