import { useEffect, useRef, useState, useCallback, useMemo } from "react";
import { useLocation, useSearch } from "wouter";
import GpsRecorder from "@/components/GpsRecorder";
import LayersPanel, { type MapLayer, type BaseMap } from "@/components/LayersPanel";
import TrailDetailSheet from "@/components/TrailDetailSheet";
import ClusterTrailListSheet from "@/components/ClusterTrailListSheet";
import MapTrailFilters, { type MapTrailFilterState } from "@/components/MapTrailFilters";
import AddTrailMenu, { type AddTrailChoice } from "@/components/contribute/AddTrailMenu";
import SaveTrailForm from "@/components/contribute/SaveTrailForm";
import UploadGpxFlow from "@/components/contribute/UploadGpxFlow";
import MapRoutePanel from "@/components/MapRoutePanel";
import MapTrailSearch from "@/components/MapTrailSearch";
import LoadingBackdrop from "@/components/LoadingBackdrop";
import { getTrailLatLngs, invalidateTrailGeometryCache } from "@/lib/trailLayer";
import { useLeaflet } from "@/lib/useLeaflet";
import {
  addTrail,
  fetchTrailsInBbox,
  fetchTrailGpxByIds,
  type Trail,
  type MapBbox,
} from "@/lib/supabase";
import { mapBboxStore } from "@/lib/mapBboxStore";
import {
  renderTrailLayer,
  renderTrailClusters,
  clusterTrails,
  type TrailLayerHandle,
  type ClusterLayerHandle,
  type TrailCluster,
  DIFFICULTY_BUCKETS,
  CLUSTER_ZOOM_THRESHOLD,
  getTrailBbox,
  bboxesIntersect,
} from "@/lib/trailLayer";
import {
  setRouteTrails as setPlannerRouteTrails,
} from "@/lib/plannerRouteStore";
import {
  useMapSelection,
  addSelectedTrail,
  removeSelectedTrail,
  setSelectedTrails,
  clearSelection,
} from "@/lib/mapSelectionStore";
import {
  HYBRID_LABEL_TILE_URL,
  HYBRID_LABEL_TILE_ATTRIBUTION,
  assembleMultiModalRoute,
  orderTrailsNearestNeighbour,
  reverseGeocode,
  type GeoPoint,
  type AssembledRoute,
} from "@/lib/routing";
import {
  GROUPS_MEMBERSHIP_CHANGED_EVENT,
  fetchGroupTrails,
} from "@/lib/groups";

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
  const [, setLocation] = useLocation();
  const queryString = useSearch();
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<import("leaflet").Map | null>(null);
  const markersRef = useRef<import("leaflet").Marker[]>([]);
  const drawPolylineRef = useRef<import("leaflet").Polyline | null>(null);
  const tileLayerRef = useRef<import("leaflet").TileLayer | null>(null);
  // Hybrid place-label overlay shown only over the satellite base. Removed
  // when topo / OS Outdoor are active (those styles ship their own labels).
  const labelLayerRef = useRef<import("leaflet").TileLayer | null>(null);
  const mapResizeCleanupRef = useRef<(() => void) | null>(null);
  const layerPolylinesRef = useRef<Map<string, import("leaflet").Polyline[]>>(new Map());
  const trailLayerHandleRef = useRef<TrailLayerHandle | null>(null);
  const clusterLayerHandleRef = useRef<ClusterLayerHandle | null>(null);
  const fetchSeqRef = useRef(0);
  const fetchDebounceRef = useRef<number | null>(null);

  const [mapMode, setMapMode] = useState<MapMode>("explore");
  const [waypoints, setWaypoints] = useState<Waypoint[]>([]);
  const [totalKm, setTotalKm] = useState(0);
  const [selectedWaypointId, setSelectedWaypointId] = useState<number | null>(null);
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
  const [highlightedTrailId, setHighlightedTrailId] = useState<string | null>(null);
  // The list the selected trail was opened from. We capture this at click
  // time so the prev/next arrows in TrailDetailSheet stay scoped to the
  // surface the rider came from (cluster list, route panel, or the visible
  // map). Falls back to the visible-trails set as a sensible default.
  const [selectedTrailContext, setSelectedTrailContext] = useState<Trail[]>([]);
  const [activeCluster, setActiveCluster] = useState<TrailCluster | null>(null);
  const [currentZoom, setCurrentZoom] = useState(7);
  const [, setCurrentBbox] = useState<MapBbox | null>(null);

  const routeTrails = useMapSelection();
  const routeIdSet = useMemo(() => new Set(routeTrails.map((t) => t.id)), [routeTrails]);
  const highlightIdSet = useMemo(() => {
    const s = new Set(routeIdSet);
    if (highlightedTrailId) s.add(highlightedTrailId);
    return s;
  }, [routeIdSet, highlightedTrailId]);
  const routeConnectorsRef = useRef<import("leaflet").Polyline[]>([]);

  // "+ Add Trail" / contribute flows
  const [showAddMenu, setShowAddMenu] = useState(false);
  const [showUploadGpx, setShowUploadGpx] = useState(false);
  const [showDrawSave, setShowDrawSave] = useState(false);
  const [savedTrailToast, setSavedTrailToast] = useState<string | null>(null);

  // Build-from-selection flow state
  const [showStartChooser, setShowStartChooser] = useState(false);
  const [building, setBuilding] = useState(false);
  const [buildProgress, setBuildProgress] = useState<{ step: number; total: number; label: string } | null>(null);
  const [buildError, setBuildError] = useState<string | null>(null);

  const groupFilterId = useMemo(() => {
    const params = new URLSearchParams(queryString);
    return params.get("group") ?? null;
  }, [queryString]);

  const groupFilterName = useMemo(() => {
    if (!groupFilterId) return null;
    for (const t of allTrails) {
      const g = t.shared_groups?.find((g) => g.id === groupFilterId);
      if (g) return g.name;
    }
    return null;
  }, [groupFilterId, allTrails]);

  const clearGroupFilter = useCallback(() => {
    const params = new URLSearchParams(queryString);
    params.delete("group");
    const qs = params.toString();
    setLocation(`/map${qs ? `?${qs}` : ""}`, { replace: true });
  }, [queryString, setLocation]);

  const mapModeRef = useRef(mapMode);
  const waypointsRef = useRef(waypoints);
  const selectedWaypointIdRef = useRef<number | null>(null);
  mapModeRef.current = mapMode;
  waypointsRef.current = waypoints;
  selectedWaypointIdRef.current = selectedWaypointId;

  const createDrawMarker = useCallback((wp: Waypoint, index: number, total: number, map: import("leaflet").Map): import("leaflet").Marker => {
    const L = window.L;
    const isSelected = wp.id === selectedWaypointIdRef.current;
    const isFirst = index === 0;
    const isLast = index === total - 1;
    const label = isFirst ? "A" : isLast && total > 1 ? "B" : `${index + 1}`;
    const bg = isSelected ? "#3b82f6" : "#d4870c";
    const border = isSelected ? "#93c5fd" : "#fff";
    const size = isSelected ? 28 : 22;
    const html = `<div style="width:${size}px;height:${size}px;background:${bg};border:2.5px solid ${border};border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:${size > 24 ? 11 : 9}px;font-weight:900;color:#fff;box-shadow:0 2px 8px rgba(0,0,0,0.6);cursor:grab;user-select:none;touch-action:none;">${label}</div>`;
    const marker = L.marker([wp.lat, wp.lng], {
      icon: L.divIcon({ html, iconSize: [size, size], iconAnchor: [size / 2, size / 2], className: "" }),
      draggable: true,
      zIndexOffset: isSelected ? 1000 : 0,
    }).addTo(map);

    marker.dragging?.disable();

    let longPressTimer: ReturnType<typeof setTimeout> | null = null;
    let didLongPress = false;
    let startX = 0;
    let startY = 0;
    const MOVE_THRESHOLD = 10;

    const startLongPress = (e: PointerEvent) => {
      didLongPress = false;
      startX = e.clientX;
      startY = e.clientY;
      longPressTimer = setTimeout(() => {
        didLongPress = true;
        marker.dragging?.enable();
        const el = marker.getElement();
        if (el) el.style.cursor = "grabbing";
      }, 400);
    };
    const cancelLongPress = () => {
      if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
    };
    const handlePointerMove = (e: PointerEvent) => {
      if (!longPressTimer) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      if (dx * dx + dy * dy > MOVE_THRESHOLD * MOVE_THRESHOLD) {
        cancelLongPress();
      }
    };
    const handleClick = () => {
      if (didLongPress) { didLongPress = false; return; }
      setSelectedWaypointId((prev) => prev === wp.id ? null : wp.id);
    };

    marker.on("click", handleClick);
    const el = marker.getElement();
    if (el) {
      el.addEventListener("pointerdown", startLongPress);
      el.addEventListener("pointerup", cancelLongPress);
      el.addEventListener("pointercancel", cancelLongPress);
      el.addEventListener("pointermove", handlePointerMove);
    }

    marker.on("dragend", () => {
      marker.dragging?.disable();
      const markerEl = marker.getElement();
      if (markerEl) markerEl.style.cursor = "grab";
      const pos = marker.getLatLng();
      const updatedWaypoints = waypointsRef.current.map((w) =>
        w.id === wp.id ? { ...w, lat: pos.lat, lng: pos.lng } : w
      );
      setWaypoints(updatedWaypoints);
      waypointsRef.current = updatedWaypoints;
      redrawPolyline(updatedWaypoints);
    });

    return marker;
  }, []);

  const redrawPolyline = useCallback((wps: Waypoint[]) => {
    if (drawPolylineRef.current) { drawPolylineRef.current.remove(); drawPolylineRef.current = null; }
    if (wps.length >= 2 && mapRef.current) {
      const L = window.L;
      const latlngs = wps.map((wp) => [wp.lat, wp.lng] as [number, number]);
      drawPolylineRef.current = L.polyline(latlngs, { color: "#f0a832", weight: 3.5, opacity: 0.85 }).addTo(mapRef.current);
      let dist = 0;
      for (let i = 1; i < wps.length; i++) {
        dist += L.latLng(wps[i - 1].lat, wps[i - 1].lng).distanceTo(L.latLng(wps[i].lat, wps[i].lng));
      }
      setTotalKm(dist / 1000);
    } else {
      setTotalKm(0);
    }
  }, []);

  const redrawAllMarkers = useCallback((wps: Waypoint[]) => {
    if (!mapRef.current) return;
    markersRef.current.forEach((m) => m.remove());
    markersRef.current = [];
    wps.forEach((wp, i) => {
      const marker = createDrawMarker(wp, i, wps.length, mapRef.current!);
      markersRef.current.push(marker);
    });
  }, [createDrawMarker]);

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
    mapBboxStore.set(bbox);
    const seq = ++fetchSeqRef.current;
    setTrailsLoading(true);
    const [{ trails, usedBbox }, groupTrails] = await Promise.all([
      fetchTrailsInBbox(bbox, {
        difficulties: filters.difficulties.length > 0 ? filters.difficulties : undefined,
        trailTypes: filters.trailTypes.length > 0 ? filters.trailTypes : undefined,
        limit: 200,
      }),
      fetchGroupTrails({
        minLat: bbox.minLat,
        maxLat: bbox.maxLat,
        minLng: bbox.minLng,
        maxLng: bbox.maxLng,
      }),
    ]);
    if (seq !== fetchSeqRef.current) return; // stale
    setUsedServerBbox(usedBbox);
    // Merge public + group-shared trails. Group trails win on collision so
    // the `shared_groups` decoration is preserved when the same trail is
    // both public and shared into a group the user belongs to.
    const merged = new Map<string, Trail>();
    for (const t of trails) merged.set(t.id, t);
    for (const t of groupTrails) merged.set(t.id, t);
    setAllTrails(Array.from(merged.values()));
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

    // Hybrid place-labels overlay rendered on top of the satellite imagery
    // so the rider can see town/road names without losing the satellite view.
    const labelLayer = L.tileLayer(HYBRID_LABEL_TILE_URL, {
      attribution: HYBRID_LABEL_TILE_ATTRIBUTION,
      opacity: 0.95,
      maxZoom: 19,
      pane: "shadowPane",
    });
    labelLayer.addTo(map);
    labelLayerRef.current = labelLayer;

    map.on("click", (e: import("leaflet").LeafletMouseEvent) => {
      if (mapModeRef.current !== "draw") return;
      const { lat, lng } = e.latlng;
      const id = Date.now();
      const newWaypoints = [...waypointsRef.current, { id, lat, lng }];
      setWaypoints(newWaypoints);
      waypointsRef.current = newWaypoints;
      setSelectedWaypointId(null);
      redrawPolyline(newWaypoints);
      redrawAllMarkers(newWaypoints);
    });

    // Re-fetch trails on viewport change (debounced)
    map.on("moveend zoomend", () => {
      setCurrentZoom(map.getZoom());
      scheduleFetch();
    });

    setCurrentZoom(map.getZoom());
    mapRef.current = map;

    // Leaflet measures the container exactly once at init. If the page
    // layout settles AFTER mount (bottom nav reflow, header safe-area
    // padding application, font swap, address-bar collapse on mobile
    // Chrome) the map keeps the original — usually smaller — size and
    // never re-expands, leaving a grey strip at the bottom that the
    // tester reported as "the map page never goes full screen."
    // Two-pronged fix:
    //   1. Schedule a few invalidateSize() calls after init so the map
    //      catches up to whatever the final layout is.
    //   2. Watch the container with a ResizeObserver and invalidateSize
    //      on every size change for the lifetime of this map instance.
    const invalidate = () => {
      try { map.invalidateSize(false); } catch { /* map disposed */ }
    };
    const initTimers = [
      window.setTimeout(invalidate, 0),
      window.setTimeout(invalidate, 100),
      window.setTimeout(invalidate, 400),
      window.setTimeout(invalidate, 1200),
    ];
    let resizeObs: ResizeObserver | undefined;
    if (typeof ResizeObserver !== "undefined" && mapContainerRef.current) {
      resizeObs = new ResizeObserver(() => invalidate());
      resizeObs.observe(mapContainerRef.current);
    }
    window.addEventListener("resize", invalidate);
    window.addEventListener("orientationchange", invalidate);
    mapResizeCleanupRef.current = () => {
      initTimers.forEach((t) => window.clearTimeout(t));
      resizeObs?.disconnect();
      window.removeEventListener("resize", invalidate);
      window.removeEventListener("orientationchange", invalidate);
    };

    // Initial fetch
    void fetchTrailsForCurrentView();
  }, [leafletLoaded, scheduleFetch, fetchTrailsForCurrentView]);

  // Tear down resize listeners when the MapTab unmounts.
  useEffect(() => {
    return () => {
      mapResizeCleanupRef.current?.();
      mapResizeCleanupRef.current = null;
    };
  }, []);

  // Re-fetch when filters change (so server-side filters are applied)
  useEffect(() => {
    if (!mapRef.current) return;
    void fetchTrailsForCurrentView();
  }, [fetchTrailsForCurrentView]);

  // Invalidate the trail cache as soon as group membership changes (member
  // removed, ownership transferred, invite accepted/declined, or share
  // assignments updated). Without this, a user removed from a group could
  // still see that group's private trails until they panned/zoomed.
  useEffect(() => {
    if (!mapRef.current) return;
    const handler = () => {
      // Drop any selected trail in case it was a group-shared private trail
      // we no longer have access to; the next fetch will repopulate.
      setSelectedTrail((prev) => (prev && !prev.is_public ? null : prev));
      void fetchTrailsForCurrentView();
    };
    window.addEventListener(GROUPS_MEMBERSHIP_CHANGED_EVENT, handler);
    return () =>
      window.removeEventListener(GROUPS_MEMBERSHIP_CHANGED_EVENT, handler);
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

    // Only pass `subdomains` when the URL actually uses {s}. Passing
    // `undefined` would *override* Leaflet's default ('abc') and trip
    // `_getSubdomain` reading `.length` on undefined the next time the
    // layer is re-added (e.g. when MapTab is remounted via tab navigation).
    const tileOptions: Parameters<typeof L.tileLayer>[1] = {
      attribution: TILE_ATTRS[baseMap],
      maxZoom: 20,
    };
    if (baseMap === "topo") {
      (tileOptions as { subdomains: string[] }).subdomains = ["a", "b", "c"];
    }
    const newTile = L.tileLayer(url, tileOptions);

    newTile.addTo(map);
    tileLayerRef.current = newTile;

    // Show the hybrid place-labels overlay on satellite (and as a graceful
    // fallback when OS Outdoor falls back to satellite). Hide on topo and
    // genuine OS Outdoor since both already include their own labels.
    const wantLabels = baseMap === "satellite" || (baseMap === "os-outdoor" && !osApiKey);
    if (wantLabels) {
      if (!labelLayerRef.current) {
        const labels = L.tileLayer(HYBRID_LABEL_TILE_URL, {
          attribution: HYBRID_LABEL_TILE_ATTRIBUTION,
          opacity: 0.95,
          maxZoom: 19,
          pane: "shadowPane",
        });
        labels.addTo(map);
        labelLayerRef.current = labels;
      } else if (!map.hasLayer(labelLayerRef.current)) {
        labelLayerRef.current.addTo(map);
      }
    } else if (labelLayerRef.current) {
      labelLayerRef.current.remove();
      labelLayerRef.current = null;
    }
  }, [baseMap, osApiKey]);

  // ---------------------------------------------------------------------------
  // Trail layer rendering — visible in every mode so users can see public
  // trails while drawing or recording. In Draw / Record the polylines are
  // non-interactive so map clicks pass through to the waypoint / GPS handlers.
  // ---------------------------------------------------------------------------
  const visibleTrails = useMemo(() => {
    let trails = allTrails;
    if (groupFilterId) {
      trails = trails.filter(
        (t) => t.shared_groups?.some((g) => g.id === groupFilterId),
      );
    }
    if (filters.difficulties.length > 0) {
      trails = trails.filter((t) => t.difficulty != null && filters.difficulties.includes(t.difficulty));
    }
    if (filters.trailTypes.length > 0) {
      trails = trails.filter((t) => t.legal_status != null && filters.trailTypes.includes(t.legal_status));
    }
    return trails;
  }, [allTrails, groupFilterId, filters.difficulties, filters.trailTypes]);

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

  // Shared "zoom into the cluster bbox" used both for single-trail cluster
  // taps and the "Zoom to area" button in the multi-trail cluster sheet.
  const zoomToCluster = useCallback((cluster: TrailCluster) => {
    if (!mapRef.current || !window.L) return;
    const map = mapRef.current;
    try {
      const L = window.L;
      const bounds = L.latLngBounds(
        [cluster.bbox.minLat, cluster.bbox.minLng],
        [cluster.bbox.maxLat, cluster.bbox.maxLng],
      );
      if (cluster.count === 1) {
        map.fitBounds(bounds, { padding: [40, 40], maxZoom: 14 });
        return;
      }
      // Multi-trail clusters: zoom into the cluster bbox, but cap at one
      // level past the threshold so users can keep drilling in.
      const targetMax = Math.max(
        CLUSTER_ZOOM_THRESHOLD,
        Math.min(CLUSTER_ZOOM_THRESHOLD + 2, currentZoom + 3),
      );
      map.fitBounds(bounds, { padding: [40, 40], maxZoom: targetMax });
    } catch {
      // fitBounds can throw on degenerate bboxes — fall back to a simple
      // setView at the cluster centroid.
      map.setView(
        [cluster.lat, cluster.lng],
        Math.min(CLUSTER_ZOOM_THRESHOLD + 1, currentZoom + 3),
      );
    }
  }, [currentZoom]);

  // Trails belonging to the currently open cluster sheet (resolved from the
  // cluster's `trailIds` against the current viewport trail list). Recomputed
  // on every render so filter / fetch updates flow through without needing
  // to re-open the sheet.
  const clusterTrailsForSheet = useMemo<Trail[]>(() => {
    if (!activeCluster) return [];
    const ids = new Set(activeCluster.trailIds);
    const byId = new Map<string, Trail>();
    for (const t of allTrails) byId.set(t.id, t);
    const out: Trail[] = [];
    for (const id of ids) {
      const t = byId.get(id);
      if (t) out.push(t);
    }
    return out;
  }, [activeCluster, allTrails]);

  // (Re)render trail layer whenever inputs change. Below the cluster zoom
  // threshold we render aggregated cluster markers instead of every polyline
  // so the country / region view stays readable. The polyline layer renders
  // in every mode; only Explore makes the polylines clickable.
  useEffect(() => {
    if (!mapRef.current || !window.L) return;
    trailLayerHandleRef.current?.clear();
    trailLayerHandleRef.current = null;
    clusterLayerHandleRef.current?.clear();
    clusterLayerHandleRef.current = null;

    if (trailsForRender.length === 0) return;

    const isExplore = mapMode === "explore";
    const map = mapRef.current;

    if (currentZoom < CLUSTER_ZOOM_THRESHOLD) {
      const clusters = clusterTrails(trailsForRender, currentZoom);
      const handle = renderTrailClusters(map, clusters, {
        pane: "trailsPane",
        interactive: isExplore,
        onClusterClick: isExplore
          ? (cluster: TrailCluster) => {
              // Single-trail clusters: zoom straight to the trail bbox —
              // a list-of-one would be a pointless extra tap.
              if (cluster.count === 1) {
                zoomToCluster(cluster);
                return;
              }
              // Multi-trail clusters: open a bottom sheet listing the
              // member trails so users can jump straight into one without
              // hunting through the post-zoom polylines. The "Zoom to
              // area" button in the sheet preserves the old behavior.
              setActiveCluster(cluster);
            }
          : undefined,
      });
      clusterLayerHandleRef.current = handle;
      return;
    }

    const handle = renderTrailLayer(map, trailsForRender, {
      selectedIds: highlightIdSet,
      selectedColor: "#f0a832",
      showLabels: false,
      shadow: false,
      simplifyForZoom: currentZoom,
      pane: "trailsPane",
      interactive: isExplore,
      onTrailClick: isExplore
        ? (trail) => {
            // Direct map-popup tap — context is the visible trail set.
            setSelectedTrailContext(trailsForRender);
            setSelectedTrail(trail);
          }
        : undefined,
      // Highlight trails that are visible only because the viewer belongs
      // to one of the listed groups. Non-shared (public) trails render as
      // before — see lib/trailLayer.ts.
      showSharedGroupBadges: true,
    });
    trailLayerHandleRef.current = handle;
  }, [trailsForRender, mapMode, highlightIdSet, currentZoom, zoomToCluster]);

  // Render dashed connector polylines between consecutive trails in the
  // planner route so the user can preview the order they've chosen on the
  // map. Endpoints come from each trail's GPX (end of N → start of N+1).
  useEffect(() => {
    if (!mapRef.current || !window.L) return;
    const L = window.L;
    const map = mapRef.current;

    // Clear previous connectors
    routeConnectorsRef.current.forEach((pl) => {
      try { pl.remove(); } catch { /**/ }
    });
    routeConnectorsRef.current = [];

    if (routeTrails.length < 2) return;

    const newLines: import("leaflet").Polyline[] = [];
    try {
      for (let i = 0; i < routeTrails.length - 1; i++) {
        // Prefer simplified_path / path_geojson — bbox responses no longer
        // include gpx_data, and route-connector lines only need the trail
        // endpoints. Falls back to parseGPX(gpx_data) automatically when
        // the simplified columns aren't populated yet.
        const fromLatLngs = getTrailLatLngs(routeTrails[i]);
        const toLatLngs = getTrailLatLngs(routeTrails[i + 1]);
        if (fromLatLngs.length < 1 || toLatLngs.length < 1) continue;
        const fromEndPt = fromLatLngs[fromLatLngs.length - 1];
        const toStartPt = toLatLngs[0];
        if (
          !Number.isFinite(fromEndPt[0]) || !Number.isFinite(fromEndPt[1]) ||
          !Number.isFinite(toStartPt[0]) || !Number.isFinite(toStartPt[1])
        ) continue;
        const pl = L.polyline(
          [
            [fromEndPt[0], fromEndPt[1]],
            [toStartPt[0], toStartPt[1]],
          ],
          {
            color: "#f0a832",
            weight: 3,
            opacity: 0.85,
            dashArray: "8,8",
            pane: "trailsPane",
            interactive: false,
          },
        ).addTo(map);
        newLines.push(pl);
      }
    } catch (err) {
      // Defensive: never let a malformed GPX in the route store break the map.
      // eslint-disable-next-line no-console
      console.error("[MapTab] route connector render failed:", err);
    }
    routeConnectorsRef.current = newLines;
  }, [routeTrails]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (fetchDebounceRef.current != null) window.clearTimeout(fetchDebounceRef.current);
      trailLayerHandleRef.current?.clear();
      clusterLayerHandleRef.current?.clear();
      routeConnectorsRef.current.forEach((pl) => pl.remove());
      routeConnectorsRef.current = [];
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
    waypointsRef.current = [];
    setTotalKm(0);
    setSelectedWaypointId(null);
  };

  const undoWaypoint = () => {
    if (waypointsRef.current.length === 0) return;
    const newWaypoints = waypointsRef.current.slice(0, -1);
    setWaypoints(newWaypoints);
    waypointsRef.current = newWaypoints;
    setSelectedWaypointId(null);
    redrawPolyline(newWaypoints);
    redrawAllMarkers(newWaypoints);
  };

  const removeWaypoint = useCallback((wpId: number) => {
    const newWaypoints = waypointsRef.current.filter((w) => w.id !== wpId);
    setWaypoints(newWaypoints);
    waypointsRef.current = newWaypoints;
    setSelectedWaypointId(null);
    redrawPolyline(newWaypoints);
    redrawAllMarkers(newWaypoints);
  }, [redrawPolyline, redrawAllMarkers]);

  const prevSelectedRef = useRef<number | null>(null);
  useEffect(() => {
    if (mapMode !== "draw") return;
    if (prevSelectedRef.current === selectedWaypointId) return;
    prevSelectedRef.current = selectedWaypointId;
    if (waypoints.length > 0) redrawAllMarkers(waypoints);
  }, [selectedWaypointId, mapMode, waypoints, redrawAllMarkers]);

  const selectedWaypoint = useMemo(
    () => selectedWaypointId != null ? waypoints.find((w) => w.id === selectedWaypointId) ?? null : null,
    [waypoints, selectedWaypointId],
  );

  const activeLayerCount = layers.filter((l) => l.visible).length;
  const filterCount = filters.difficulties.length + filters.trailTypes.length;

  const handleToggleSearchTrail = useCallback((trail: Trail) => {
    if (routeIdSet.has(trail.id)) {
      removeSelectedTrail(trail.id);
    } else {
      addSelectedTrail(trail);
    }
  }, [routeIdSet]);

  const handleFlyToTrail = useCallback((trail: Trail) => {
    if (!mapRef.current || !window.L) return;
    const L = window.L;
    const bbox = getTrailBbox(trail);
    if (bbox) {
      mapRef.current.fitBounds(
        L.latLngBounds([bbox.minLat, bbox.minLng], [bbox.maxLat, bbox.maxLng]),
        { padding: [60, 60], maxZoom: 14 },
      );
    }
    setHighlightedTrailId(trail.id);
    setSelectedTrailContext([trail]);
    setSelectedTrail(trail);
  }, []);

  const handlePlanInPlanner = useCallback(() => {
    if (routeTrails.length === 0) return;
    setPlannerRouteTrails(routeTrails);
    const params = new URLSearchParams(window.location.search);
    params.set("build", "1");
    setLocation(`/?${params.toString()}`);
  }, [routeTrails, setLocation]);

  const handleBuildRoute = useCallback(() => {
    if (routeTrails.length === 0) return;
    if (routeTrails.length < 2) {
      setBuildError("Add at least 2 trails to build a route.");
      setTimeout(() => setBuildError(null), 4000);
      return;
    }
    const approx = routeTrails.find((t) => t.verification_status === "ai-approximated");
    if (approx) {
      setBuildError(`"${approx.name}" is AI-approximated and can't be navigated. Remove it first.`);
      setTimeout(() => setBuildError(null), 5000);
      return;
    }
    setShowStartChooser(true);
  }, [routeTrails]);

  const doBuildFromSelection = useCallback(async (useGps: boolean) => {
    setShowStartChooser(false);
    setBuilding(true);
    setBuildError(null);
    setBuildProgress({ step: 0, total: 100, label: "Preparing…" });

    try {
      let startPt: GeoPoint | null = null;

      if (useGps) {
        setBuildProgress({ step: 5, total: 100, label: "Getting your location…" });
        try {
          const pos = await new Promise<GeolocationPosition>((resolve, reject) =>
            navigator.geolocation.getCurrentPosition(resolve, reject, {
              enableHighAccuracy: true,
              timeout: 10000,
              maximumAge: 60000,
            }),
          );
          const place = await reverseGeocode(pos.coords.latitude, pos.coords.longitude);
          startPt = place ?? {
            lat: pos.coords.latitude,
            lng: pos.coords.longitude,
            label: `${pos.coords.latitude.toFixed(5)}, ${pos.coords.longitude.toFixed(5)}`,
          };
        } catch {
          setBuildError("Couldn't get your location — using first trail as start instead.");
        }
      }

      setBuildProgress({ step: 10, total: 100, label: "Loading trail data…" });
      const missingGpxIds = routeTrails.filter((t) => t.gpx_data == null).map((t) => t.id);
      let hydratedTrails = routeTrails;
      if (missingGpxIds.length > 0) {
        const gpxMap = await fetchTrailGpxByIds(missingGpxIds);
        hydratedTrails = routeTrails.map((t) => {
          if (t.gpx_data != null) return t;
          const g = gpxMap.get(t.id);
          if (g != null) {
            invalidateTrailGeometryCache(t.id);
            return { ...t, gpx_data: g };
          }
          return t;
        });
      }

      let pinnedFirst: Trail | null = null;
      if (!startPt) {
        for (const candidate of hydratedTrails) {
          const pts = getTrailLatLngs(candidate);
          if (pts.length >= 2) {
            startPt = { lat: pts[0][0], lng: pts[0][1] };
            pinnedFirst = candidate;
            break;
          }
        }
        if (!startPt) {
          setBuildError("None of the selected trails have GPS geometry.");
          setBuilding(false);
          setBuildProgress(null);
          return;
        }
      }

      setBuildProgress({ step: 15, total: 100, label: "Optimizing trail order…" });
      const toOrder = pinnedFirst
        ? hydratedTrails.filter((t) => t.id !== pinnedFirst!.id)
        : hydratedTrails;
      const trailExitPt = pinnedFirst
        ? (() => {
            const pts = getTrailLatLngs(pinnedFirst);
            return { lat: pts[pts.length - 1][0], lng: pts[pts.length - 1][1] } as GeoPoint;
          })()
        : startPt;
      const sorted = pinnedFirst
        ? [pinnedFirst, ...orderTrailsNearestNeighbour(trailExitPt, toOrder)]
        : orderTrailsNearestNeighbour(startPt, hydratedTrails);

      const entries = sorted.map((t) => ({ kind: "trail" as const, trail: t }));

      setBuildProgress({ step: 20, total: 100, label: "Building route…" });
      const route = await assembleMultiModalRoute(
        startPt,
        null,
        entries,
        (step, total, label) => {
          const pct = 20 + Math.round((step / total) * 75);
          setBuildProgress({ step: pct, total: 100, label });
        },
      );

      if (route.sections.length === 0) {
        setBuildError("Could not build a route. Check your trails have valid GPS data.");
        setBuilding(false);
        setBuildProgress(null);
        return;
      }

      const warnings: string[] = [];
      if (route.skippedTrails.length > 0) {
        warnings.push(`Skipped ${route.skippedTrails.length} trail${route.skippedTrails.length > 1 ? "s" : ""} with missing GPS data: ${route.skippedTrails.join(", ")}`);
      }
      if (route.failedRoadSegments > 0) {
        warnings.push(`${route.failedRoadSegments} road connector${route.failedRoadSegments > 1 ? "s" : ""} could not be routed and ${route.failedRoadSegments > 1 ? "were" : "was"} omitted.`);
      }
      if (warnings.length > 0) {
        setBuildError(warnings.join(" • "));
        setTimeout(() => setBuildError(null), 8000);
      }

      const routeJson = JSON.stringify(route);
      try {
        sessionStorage.setItem("trailforge_selection_route", routeJson);
      } catch {
        // sessionStorage full or unavailable — fall through
      }

      const params = new URLSearchParams(window.location.search);
      params.set("fromSelection", "1");
      setLocation(`/?${params.toString()}`);
    } catch {
      setBuildError("Network error while building route. Please try again.");
    }
    setBuilding(false);
    setBuildProgress(null);
  }, [routeTrails, setLocation]);

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
              {selectedWaypoint && (
                <button
                  onClick={() => removeWaypoint(selectedWaypoint.id)}
                  className="p-1.5 rounded-lg bg-black/65 border border-blue-500/60 text-blue-400 backdrop-blur hover:bg-blue-900/30 transition-colors"
                  title="Remove selected point"
                >
                  <svg viewBox="0 0 24 24" className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2">
                    <circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/>
                  </svg>
                </button>
              )}
              <button
                onClick={undoWaypoint}
                className="p-1.5 rounded-lg bg-black/65 border border-stone-600/60 text-stone-300 backdrop-blur hover:bg-stone-700/60 transition-colors"
                title="Undo last point"
              >
                <svg viewBox="0 0 24 24" className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2">
                  <polyline points="9 14 4 9 9 4"/><path d="M20 20v-7a4 4 0 0 0-4-4H4"/>
                </svg>
              </button>
              <button
                onClick={clearWaypoints}
                className="p-1.5 rounded-lg bg-black/65 border border-red-600/50 text-red-400 backdrop-blur hover:bg-red-900/30 transition-colors"
                title="Clear all points"
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
              <span className="hidden sm:inline">Filters</span>
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
            <span className="hidden sm:inline">Layers</span>
            {activeLayerCount > 0 && (
              <span className="bg-amber-500 text-stone-900 text-[9px] font-black w-4 h-4 rounded-full flex items-center justify-center">
                {activeLayerCount}
              </span>
            )}
          </button>
        </div>
      </div>

      {/* Trail search (Explore mode) */}
      {mapMode === "explore" && (
        <MapTrailSearch
          routeIdSet={routeIdSet}
          onToggleTrail={handleToggleSearchTrail}
          onFlyTo={handleFlyToTrail}
        />
      )}

      {/* Mode hints */}
      {mapMode === "draw" && (
        <div className="absolute top-12 left-1/2 -translate-x-1/2 z-[1000] bg-amber-500/90 text-stone-900 text-xs font-bold px-3 py-1.5 rounded-full shadow-lg pointer-events-none whitespace-nowrap">
          {selectedWaypoint ? "Tap point to deselect · Hold to drag" : "Tap map to add · Tap point to select · Hold to drag"}
        </div>
      )}
      {mapMode === "record" && (
        <div className="absolute top-12 left-1/2 -translate-x-1/2 z-[1000] bg-red-600/90 text-white text-xs font-bold px-3 py-1.5 rounded-full shadow-lg pointer-events-none whitespace-nowrap flex items-center gap-1.5">
          <span className="w-2 h-2 rounded-full bg-white animate-pulse"></span>
          GPS Record Mode — tap Start below
        </div>
      )}

      {/* Group filter banner */}
      {groupFilterId && (
        <div
          className="absolute top-12 left-1/2 -translate-x-1/2 z-[1001] pointer-events-auto"
          data-testid="map-group-filter-banner"
        >
          <div className="flex items-center gap-2 bg-amber-900/90 backdrop-blur border border-amber-500/50 text-amber-100 text-[11px] font-bold px-3 py-1.5 rounded-full shadow-lg">
            <svg viewBox="0 0 24 24" className="w-3.5 h-3.5 shrink-0" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>
              <circle cx="9" cy="7" r="4"/>
              <path d="M23 21v-2a4 4 0 0 0-3-3.87"/>
              <path d="M16 3.13a4 4 0 0 1 0 7.75"/>
            </svg>
            <span className="truncate max-w-[180px]">
              {groupFilterName ?? "Group"} trails only
            </span>
            <button
              type="button"
              onClick={clearGroupFilter}
              className="shrink-0 w-4 h-4 rounded-full bg-amber-200/30 hover:bg-amber-200/50 flex items-center justify-center text-amber-100 transition-colors"
              aria-label="Clear group filter"
              data-testid="map-group-filter-clear"
            >
              <svg viewBox="0 0 24 24" className="w-2.5 h-2.5" fill="none" stroke="currentColor" strokeWidth="3">
                <line x1="18" y1="6" x2="6" y2="18"/>
                <line x1="6" y1="6" x2="18" y2="18"/>
              </svg>
            </button>
          </div>
        </div>
      )}

      {/* Trail status pill (Explore mode). Shifts down when the search bar
          and/or the Map Route Panel are showing so they don't overlap. */}
      {mapMode === "explore" && (
        <div
          className={`absolute left-1/2 -translate-x-1/2 z-[1000] pointer-events-none ${
            routeTrails.length > 0 ? "top-[7.5rem]" : groupFilterId ? "top-[5.5rem]" : "top-[3.5rem]"
          }`}
        >
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
                {currentZoom < CLUSTER_ZOOM_THRESHOLD && trailsForRender.length > 0 && (
                  <span className="text-stone-400 ml-1" data-testid="map-cluster-hint">
                    · clustered, zoom in for detail
                  </span>
                )}
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

      {/* Map Route Panel — only in Explore so it doesn't fight Draw / Record
          stats. Positioned below the search bar. */}
      {mapMode === "explore" && (
        <MapRoutePanel
          trails={routeTrails}
          onReorder={(next) => setSelectedTrails(next)}
          onRemove={(id) => removeSelectedTrail(id)}
          onClear={() => clearSelection()}
          onBuildRoute={handleBuildRoute}
          onPlanInPlanner={handlePlanInPlanner}
          onSelectTrail={(trail) => {
            setSelectedTrailContext(routeTrails);
            setSelectedTrail(trail);
          }}
          building={building}
          buildError={buildError}
        />
      )}

      {/* Start chooser dialog */}
      {showStartChooser && (
        <div className="absolute inset-0 z-[2000] flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div
            className="mx-4 w-full max-w-sm rounded-2xl shadow-2xl overflow-hidden"
            style={{
              background: "hsl(22,15%,11%)",
              border: "1.5px solid rgba(212,135,12,0.5)",
            }}
            data-testid="start-chooser"
          >
            <div className="px-4 pt-4 pb-3">
              <h3 className="text-base font-black text-stone-100 uppercase tracking-wider">
                Build Route
              </h3>
              <p className="text-[11px] text-stone-400 mt-1">
                {routeTrails.length} trails will be auto-ordered by geography and connected with road segments.
              </p>
            </div>
            <div className="px-4 pb-4 space-y-2">
              <button
                type="button"
                onClick={() => void doBuildFromSelection(true)}
                className="w-full flex items-center gap-3 px-3 py-3 rounded-xl border border-stone-700/60 bg-[hsl(22,15%,13%)] hover:border-amber-500/40 transition-colors text-left"
                data-testid="start-chooser-gps"
              >
                <div className="w-9 h-9 rounded-lg bg-amber-500/15 flex items-center justify-center shrink-0">
                  <svg viewBox="0 0 24 24" className="w-5 h-5 text-amber-400" fill="none" stroke="currentColor" strokeWidth="2">
                    <circle cx="12" cy="12" r="3" />
                    <line x1="12" y1="2" x2="12" y2="5" />
                    <line x1="12" y1="19" x2="12" y2="22" />
                    <line x1="2" y1="12" x2="5" y2="12" />
                    <line x1="19" y1="12" x2="22" y2="12" />
                  </svg>
                </div>
                <div>
                  <div className="text-[12px] font-bold text-stone-100">Start from my location</div>
                  <div className="text-[10px] text-stone-500">Orders trails nearest to where you are now</div>
                </div>
              </button>
              <button
                type="button"
                onClick={() => void doBuildFromSelection(false)}
                className="w-full flex items-center gap-3 px-3 py-3 rounded-xl border border-stone-700/60 bg-[hsl(22,15%,13%)] hover:border-amber-500/40 transition-colors text-left"
                data-testid="start-chooser-first"
              >
                <div className="w-9 h-9 rounded-lg bg-amber-500/15 flex items-center justify-center shrink-0">
                  <svg viewBox="0 0 24 24" className="w-5 h-5 text-amber-400" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z" />
                    <circle cx="12" cy="10" r="3" />
                  </svg>
                </div>
                <div>
                  <div className="text-[12px] font-bold text-stone-100">Start from first trail</div>
                  <div className="text-[10px] text-stone-500">Route begins at the nearest trail's entry point</div>
                </div>
              </button>
              <button
                type="button"
                onClick={() => setShowStartChooser(false)}
                className="w-full py-2 text-[11px] font-bold uppercase tracking-wider text-stone-500 hover:text-stone-300 transition-colors"
                data-testid="start-chooser-cancel"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Build progress overlay */}
      {building && buildProgress && (
        <div className="absolute inset-0 z-[2000] flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div
            className="mx-4 w-full max-w-xs rounded-2xl shadow-2xl p-5"
            style={{
              background: "hsl(22,15%,11%)",
              border: "1.5px solid rgba(212,135,12,0.5)",
            }}
            data-testid="build-progress"
          >
            <div className="flex flex-col items-center gap-3">
              <span className="w-8 h-8 border-2 border-amber-500/30 border-t-amber-500 rounded-full animate-spin" />
              <div className="text-center">
                <div className="text-[12px] font-bold text-stone-100">{buildProgress.label}</div>
                <div className="text-[10px] text-stone-500 mt-1">
                  {buildProgress.step} / {buildProgress.total}
                </div>
              </div>
              <div className="w-full bg-stone-800 rounded-full h-1.5 overflow-hidden">
                <div
                  className="h-full rounded-full transition-all duration-300"
                  style={{
                    width: `${Math.round((buildProgress.step / buildProgress.total) * 100)}%`,
                    background: "linear-gradient(90deg, #d4870c, #f0a832)",
                  }}
                />
              </div>
            </div>
          </div>
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
        className="flex-1 w-full"
        style={{ cursor: mapMode === "draw" ? "crosshair" : "grab", minHeight: 0 }}
      >
        {!leafletLoaded && (
          <LoadingBackdrop
            variant="ride2"
            label="Loading satellite map…"
            testId="map-loading-backdrop"
          />
        )}
      </div>

      {/* Draw mode stats bar — pinned to the bottom of the map area, with
          safe-area padding so the Save button stays clear of the device's
          home indicator / gesture bar on real phones. The Save button is
          rendered prominently so it's always easy to find. */}
      {mapMode === "draw" && (
        <div
          className="absolute bottom-0 left-0 right-0 z-[1000] bg-gradient-to-t from-black/85 via-black/70 to-transparent pt-6"
          style={{ paddingBottom: "calc(env(safe-area-inset-bottom, 0px) + 0.5rem)" }}
        >
          {selectedWaypoint ? (
            <div className="flex items-center justify-between gap-2 px-3">
              <div className="flex items-center gap-2 min-w-0">
                <div className="w-7 h-7 rounded-full bg-blue-500 border-2 border-blue-300 flex items-center justify-center text-[10px] font-black text-white shrink-0">
                  {(() => { const idx = waypoints.findIndex((w) => w.id === selectedWaypoint.id); return idx === 0 ? "A" : idx === waypoints.length - 1 && waypoints.length > 1 ? "B" : `${idx + 1}`; })()}
                </div>
                <div className="min-w-0">
                  <div className="text-[10px] text-stone-400 uppercase tracking-wider leading-tight">Point {waypoints.findIndex((w) => w.id === selectedWaypoint.id) + 1} of {waypoints.length}</div>
                  <div className="text-xs text-stone-300 leading-tight">{selectedWaypoint.lat.toFixed(5)}, {selectedWaypoint.lng.toFixed(5)}</div>
                </div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <button
                  onClick={() => removeWaypoint(selectedWaypoint.id)}
                  className="flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-xs font-bold uppercase tracking-wider bg-red-600/80 text-white border border-red-500/60 shadow-lg"
                >
                  <svg viewBox="0 0 24 24" className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2.5">
                    <circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/>
                  </svg>
                  Remove
                </button>
                <button
                  onClick={() => setSelectedWaypointId(null)}
                  className="px-2.5 py-2 rounded-xl text-xs font-bold uppercase tracking-wider bg-stone-700/80 text-stone-300 border border-stone-600/60"
                >
                  Done
                </button>
              </div>
            </div>
          ) : (
            <div className="flex items-center justify-between gap-2 px-3">
              <div className="flex items-center gap-3 min-w-0">
                <div className="min-w-0">
                  <div className="text-[10px] text-stone-500 uppercase tracking-wider leading-tight">Distance</div>
                  <div className="text-sm font-bold text-amber-400 leading-tight">{totalKm > 0 ? `${totalKm.toFixed(1)} km` : "0.0 km"}</div>
                </div>
                <div className="w-px h-7 bg-stone-700 shrink-0"></div>
                <div className="min-w-0">
                  <div className="text-[10px] text-stone-500 uppercase tracking-wider leading-tight">Points</div>
                  <div className="text-sm font-bold text-amber-400 leading-tight">{waypoints.length}</div>
                </div>
                {totalKm > 0 && (
                  <>
                    <div className="w-px h-7 bg-stone-700 shrink-0"></div>
                    <div className="min-w-0">
                      <div className="text-[10px] text-stone-500 uppercase tracking-wider leading-tight">Time</div>
                      <div className="text-sm font-bold text-amber-400 leading-tight">{Math.round((totalKm / 15) * 60)}m</div>
                    </div>
                  </>
                )}
              </div>
              {waypoints.length >= 2 ? (
                <button
                  onClick={() => setShowDrawSave(true)}
                  className="shrink-0 flex items-center gap-1.5 px-4 py-2.5 rounded-xl text-sm font-bold uppercase tracking-wider text-stone-900 shadow-lg shadow-amber-900/40 ring-2 ring-amber-300/40"
                  style={{ background: "linear-gradient(135deg, #d4870c, #f0a832)" }}
                  data-testid="map-save-drawn-trail"
                >
                  <svg viewBox="0 0 24 24" className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2.5">
                    <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/>
                    <polyline points="17 21 17 13 7 13 7 21"/>
                    <polyline points="7 3 7 8 15 8"/>
                  </svg>
                  Save Trail
                </button>
              ) : (
                <span className="shrink-0 text-[10px] text-stone-500 uppercase tracking-wider px-2 text-right leading-tight">
                  Tap map to add<br />at least 2 points
                </span>
              )}
            </div>
          )}
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
      {selectedTrail && (() => {
        // Resolve prev/next from whichever surface this trail was opened
        // from (cluster list, route panel, or visible map). The context
        // is captured at click time so it stays stable as the rider
        // arrows through neighbours.
        const ctx = selectedTrailContext;
        const idx = ctx.findIndex((t) => t.id === selectedTrail.id);
        const prevTrail = idx > 0 ? ctx[idx - 1] : null;
        const nextTrail = idx >= 0 && idx < ctx.length - 1 ? ctx[idx + 1] : null;
        return (
          <TrailDetailSheet
            trail={selectedTrail}
            onClose={() => { setSelectedTrail(null); setHighlightedTrailId(null); }}
            prevTrail={prevTrail}
            nextTrail={nextTrail}
            onNavigate={setSelectedTrail}
            onToggleRoute={handleToggleSearchTrail}
            routeIds={routeIdSet}
          />
        );
      })()}

      {/* Cluster trail list sheet — only for multi-trail clusters. Lets the
          user jump straight to a member trail's detail sheet, or fall back
          to the original "zoom into the cluster bbox" behavior. */}
      {activeCluster && (
        <ClusterTrailListSheet
          trails={clusterTrailsForSheet}
          onSelectTrail={(trail) => {
            setSelectedTrailContext(clusterTrailsForSheet);
            setActiveCluster(null);
            setSelectedTrail(trail);
          }}
          onZoomToArea={() => {
            const c = activeCluster;
            setActiveCluster(null);
            zoomToCluster(c);
          }}
          onClose={() => setActiveCluster(null)}
          onToggleTrail={handleToggleSearchTrail}
          selectedIds={routeIdSet}
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
        onSave={async ({ input, selectedGroupIds }) => {
          // Pass selectedGroupIds straight through — POST /trails creates
          // the trail row and the matching trail_shares rows in one
          // handler (and rolls back the trail row if shares fail), so a
          // failed share can never leave behind an orphan private trail.
          const trail = await addTrail({ ...input, group_ids: selectedGroupIds });
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
