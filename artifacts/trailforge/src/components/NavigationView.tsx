import { useEffect, useRef, useState, useCallback } from "react";
import {
  type AssembledRoute,
  type RouteSection,
  type GeoPoint,
  formatDistance,
  formatKm,
  formatDurationMin,
  maneuverArrow,
  haversineM,
  getRoadRoute,
  HYBRID_LABEL_TILE_URL,
  HYBRID_LABEL_TILE_ATTRIBUTION,
} from "@/lib/routing";
import { buildCombinedGPX, downloadGPX, type TrailRoute } from "@/lib/gpx";
import type { Trail } from "@/lib/supabase";
import { getTrailLatLngs } from "@/lib/trailLayer";
import {
  markCompleted,
  unmarkCompleted,
  useCompletionState,
} from "@/lib/completionsStore";
import { useHeading } from "@/lib/useHeading";
import {
  type RerouteState,
  initialRerouteState,
  isOffRoute,
  shouldAutoReroute,
  canAttemptReroute,
  findRerouteTarget,
  attemptReroute,
  spliceReroutedSection,
  updateRerouteStateOnAttempt,
  updateRerouteStateOnSuccess,
  updateRerouteStateOnFailure,
  OFF_ROUTE_THRESHOLD_M,
} from "@/lib/navigationReroute";

type MapMode = "heading-up" | "north-up";
type LockState = "locked" | "unlocked";
const MAP_MODE_KEY = "trailforge-nav-map-mode";

// Find nearest section to a user position; returns { section, distanceM }
function findNearestSection(route: AssembledRoute, user: GeoPoint): { section: RouteSection; distanceM: number } | null {
  let best: { section: RouteSection; distanceM: number } | null = null;
  for (const sec of route.sections) {
    let pts: GeoPoint[];
    if (sec.kind === "road") pts = sec.route.polyline;
    else if (sec.kind === "trail") pts = sec.polyline;
    else pts = [sec.point]; // waypoint — single anchor point
    // Sample at most 30 evenly-spaced points to keep it fast
    const stride = Math.max(1, Math.floor(pts.length / 30));
    let minD = Infinity;
    for (let i = 0; i < pts.length; i += stride) {
      const d = haversineM(user, pts[i]);
      if (d < minD) minD = d;
    }
    if (!best || minD < best.distanceM) best = { section: sec, distanceM: minD };
  }
  return best;
}

// For a road section, find the index of the next upcoming step relative to user position.
// We pick the step whose location is closest to user, then return that step or step+1 if user has passed it.
function findNextRoadStep(section: Extract<RouteSection, { kind: "road" }>, user: GeoPoint): { stepIndex: number; distanceToStepM: number } | null {
  const steps = section.route.steps;
  if (steps.length === 0) return null;
  let bestIdx = 0;
  let bestDist = Infinity;
  for (let i = 0; i < steps.length; i++) {
    const d = haversineM(user, steps[i].location);
    if (d < bestDist) { bestDist = d; bestIdx = i; }
  }
  // If we're within 30m of the best step, treat it as the active maneuver; else it's still upcoming
  const distanceToStepM = bestDist;
  return { stepIndex: bestIdx, distanceToStepM };
}

declare global {
  interface Window {
    L: typeof import("leaflet");
  }
}

const ROAD_COLOR = "#3b82f6";
const TRAIL_COLOR = "#f97316";
const ROAD_DEEP = "#1d4ed8";

/** Result returned by the removal callback the parent supplies. */
export type RemoveTrailSectionResult =
  | { ok: true }
  | { ok: false; error: string };

/** Result returned by the swap callback the parent supplies. Same
 * contract as the removal callback — `ok:false` means the previous
 * route stays on screen and the planner's selection is unchanged. */
export type SwapTrailSectionResult =
  | { ok: true }
  | { ok: false; error: string };

interface Props {
  route: AssembledRoute;
  onClose: () => void;
  nearbyTrails?: Trail[];
  onRemoveTrailSection?: (
    trailId: string,
    onProgress: (step: number, total: number, label: string) => void,
  ) => Promise<RemoveTrailSectionResult>;
  onFetchSwapAlternates?: (trailId: string) => Promise<Trail[]>;
  onSwapTrailSection?: (
    oldTrailId: string,
    newTrail: Trail,
    onProgress: (step: number, total: number, label: string) => void,
  ) => Promise<SwapTrailSectionResult>;
}

export default function NavigationView({
  route,
  onClose,
  nearbyTrails,
  onRemoveTrailSection,
  onFetchSwapAlternates,
  onSwapTrailSection,
}: Props) {
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<import("leaflet").Map | null>(null);
  const sectionLayersRef = useRef<Map<number, import("leaflet").Polyline | import("leaflet").Marker>>(new Map());
  const nearbyLayersRef = useRef<import("leaflet").Polyline[]>([]);
  const userMarkerRef = useRef<import("leaflet").Marker | null>(null);
  const userAccuracyRef = useRef<import("leaflet").Circle | null>(null);
  const watchIdRef = useRef<number | null>(null);
  const [leafletLoaded, setLeafletLoaded] = useState(false);
  const [activeSection, setActiveSection] = useState<number | null>(null);
  const [bottomTab, setBottomTab] = useState<"sections" | "turns">("sections");

  // Live GPS state
  const [riding, setRiding] = useState(false);
  const [userPos, setUserPos] = useState<(GeoPoint & { accuracyM: number; speedMs: number | null; headingDeg: number | null }) | null>(null);
  const [geoError, setGeoError] = useState<string | null>(null);

  // Trail-section removal state. `pendingRemoval` shows the inline
  // "Drop this trail?" confirm prompt; `removing` shows the in-place
  // re-routing progress. We snapshot whether the rider was using live
  // GPS before re-routing so we can resume on the new route afterwards
  // (per the task's "pause during re-route, resume against new route"
  // requirement).
  const [pendingRemoval, setPendingRemoval] = useState<{ trailId: string; trailName: string } | null>(null);
  const [removing, setRemoving] = useState<{
    trailId: string;
    trailName: string;
    progress: { pct: number; label: string };
    wasRiding: boolean;
  } | null>(null);
  const [removalError, setRemovalError] = useState<string | null>(null);

  // Swap flow state. The picker fetches asynchronously, so
  // `swapAlternates === null` means "loading"; `[]` means "loaded but
  // no candidates". `swapping` mirrors the `removing` shape so the
  // overlay's spinner UI is symmetric between the two flows.
  const [swapPickerFor, setSwapPickerFor] = useState<{
    trailId: string;
    trailName: string;
  } | null>(null);
  const [swapAlternates, setSwapAlternates] = useState<Trail[] | null>(null);
  const [swapping, setSwapping] = useState<{
    trailId: string;
    trailName: string;
    newTrailName: string;
    progress: { pct: number; label: string };
    wasRiding: boolean;
  } | null>(null);
  const [swapError, setSwapError] = useState<string | null>(null);

  const [mapMode, setMapMode] = useState<MapMode>(() => {
    try {
      const stored = localStorage.getItem(MAP_MODE_KEY);
      if (stored === "north-up" || stored === "heading-up") return stored;
    } catch { /* ignore */ }
    return "heading-up";
  });
  const [mapLock, setMapLock] = useState<LockState>("locked");
  const mapRotationRef = useRef(0);
  const programmaticPanRef = useRef(false);

  const [rerouteState, setRerouteState] = useState<RerouteState>(initialRerouteState);
  const [rerouteToast, setRerouteToast] = useState<string | null>(null);
  const rerouteToastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [liveRoute, setLiveRoute] = useState<AssembledRoute>(route);
  useEffect(() => {
    setLiveRoute(route);
    setRerouteState(initialRerouteState());
  }, [route]);

  const activeRoute = liveRoute;

  const { heading: smoothedHeading, requestCompassPermission } = useHeading(
    userPos?.headingDeg ?? null,
    riding,
  );

  // Computed nav state from current user position
  const nearestInfo = userPos ? findNearestSection(activeRoute, userPos) : null;
  const currentSection = nearestInfo?.section ?? null;
  const offRouteM = nearestInfo?.distanceM ?? null;
  const nextRoadStepInfo = currentSection?.kind === "road" && userPos
    ? findNextRoadStep(currentSection, userPos)
    : null;
  const nextRoadStep = nextRoadStepInfo && currentSection?.kind === "road"
    ? currentSection.route.steps[nextRoadStepInfo.stepIndex]
    : null;

  useEffect(() => {
    if (window.L) { setLeafletLoaded(true); return undefined; }
    let cancelled = false;
    void (async () => {
      await import("leaflet/dist/leaflet.css");
      const L = await import("leaflet");
      window.L = L.default ?? L;
      if (!cancelled) setLeafletLoaded(true);
    })();
    return () => { cancelled = true; };
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
    // Hybrid place-label overlay so the rider can read town/road names
    // while navigating on the satellite base layer.
    L.tileLayer(HYBRID_LABEL_TILE_URL, {
      attribution: HYBRID_LABEL_TILE_ATTRIBUTION,
      opacity: 0.95,
      maxZoom: 19,
      pane: "shadowPane",
    }).addTo(map);
    mapRef.current = map;

    map.on("dragstart", () => {
      if (!programmaticPanRef.current) {
        setMapLock("unlocked");
      }
    });
  }, [leafletLoaded]);

  // Cleanup map on unmount
  useEffect(() => {
    return () => {
      if (watchIdRef.current != null && navigator.geolocation) {
        navigator.geolocation.clearWatch(watchIdRef.current);
        watchIdRef.current = null;
      }
      if (mapRef.current) {
        try { mapRef.current.remove(); } catch { /* ignore */ }
        mapRef.current = null;
      }
      sectionLayersRef.current.clear();
      nearbyLayersRef.current.forEach((layer) => { try { layer.remove(); } catch { /* ignore */ } });
      nearbyLayersRef.current = [];
      userMarkerRef.current = null;
      userAccuracyRef.current = null;
      if (rerouteToastTimerRef.current) {
        clearTimeout(rerouteToastTimerRef.current);
        rerouteToastTimerRef.current = null;
      }
    };
  }, []);

  // Geolocation watcher (only active while riding)
  useEffect(() => {
    if (!riding) {
      if (watchIdRef.current != null && navigator.geolocation) {
        navigator.geolocation.clearWatch(watchIdRef.current);
        watchIdRef.current = null;
      }
      return;
    }
    if (!navigator.geolocation) {
      setGeoError("Geolocation is not supported on this device.");
      setRiding(false);
      return;
    }
    setGeoError(null);
    const id = navigator.geolocation.watchPosition(
      (pos) => {
        setUserPos({
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          accuracyM: pos.coords.accuracy,
          speedMs: pos.coords.speed,
          headingDeg: pos.coords.heading,
        });
      },
      (err) => {
        if (err.code === err.PERMISSION_DENIED) {
          setGeoError("Location permission denied. Enable location access in your browser settings.");
        } else if (err.code === err.POSITION_UNAVAILABLE) {
          setGeoError("Location signal unavailable. Move to an area with better GPS reception.");
        } else if (err.code === err.TIMEOUT) {
          setGeoError("Location request timed out. Trying again...");
        } else {
          setGeoError("Could not get your location.");
        }
      },
      { enableHighAccuracy: true, maximumAge: 1500, timeout: 10000 }
    );
    watchIdRef.current = id;
    return () => {
      if (watchIdRef.current != null && navigator.geolocation) {
        navigator.geolocation.clearWatch(watchIdRef.current);
        watchIdRef.current = null;
      }
    };
  }, [riding]);

  const handleCompassTap = useCallback(() => {
    if (mapMode === "heading-up" && mapLock === "unlocked") {
      setMapLock("locked");
      if (userPos && mapRef.current) {
        programmaticPanRef.current = true;
        mapRef.current.setView([userPos.lat, userPos.lng], mapRef.current.getZoom(), { animate: true });
        setTimeout(() => { programmaticPanRef.current = false; }, 500);
      }
      return;
    }

    const next: MapMode = mapMode === "heading-up" ? "north-up" : "heading-up";
    setMapMode(next);
    setMapLock("locked");
    try { localStorage.setItem(MAP_MODE_KEY, next); } catch { /* ignore */ }
    if (next === "north-up" && mapContainerRef.current) {
      mapRotationRef.current = 0;
      mapContainerRef.current.style.transform = "rotate(0deg)";
    }
    if (next === "heading-up" && userPos && mapRef.current) {
      programmaticPanRef.current = true;
      mapRef.current.setView([userPos.lat, userPos.lng], mapRef.current.getZoom(), { animate: true });
      setTimeout(() => { programmaticPanRef.current = false; }, 500);
    }
  }, [mapMode, mapLock, userPos]);

  useEffect(() => {
    if (!riding || !mapContainerRef.current) return;
    if (mapMode !== "heading-up" || mapLock !== "locked") {
      if (mapMode === "north-up") {
        mapRotationRef.current = 0;
        mapContainerRef.current.style.transform = "rotate(0deg)";
      }
      return;
    }

    let raf: number;
    let running = true;
    const el = mapContainerRef.current;

    const animate = () => {
      if (!running) return;
      const target = -smoothedHeading;
      const current = mapRotationRef.current;
      let diff = target - current;
      if (diff > 180) diff -= 360;
      if (diff < -180) diff += 360;
      const next = current + diff * 0.12;
      mapRotationRef.current = ((next % 360) + 360) % 360;
      el.style.transform = `rotate(${mapRotationRef.current}deg)`;

      raf = requestAnimationFrame(animate);
    };

    raf = requestAnimationFrame(animate);
    return () => {
      running = false;
      cancelAnimationFrame(raf);
    };
  }, [riding, mapMode, mapLock, smoothedHeading]);

  // Update user marker and auto-pan map when riding
  useEffect(() => {
    if (!mapRef.current || !window.L) return;
    const L = window.L;
    const map = mapRef.current;

    if (!riding || !userPos) {
      if (userMarkerRef.current) { userMarkerRef.current.remove(); userMarkerRef.current = null; }
      if (userAccuracyRef.current) { userAccuracyRef.current.remove(); userAccuracyRef.current = null; }
      return;
    }

    if (!userAccuracyRef.current) {
      userAccuracyRef.current = L.circle([userPos.lat, userPos.lng], {
        radius: userPos.accuracyM,
        color: "#3b82f6",
        weight: 1,
        fillColor: "#3b82f6",
        fillOpacity: 0.12,
      }).addTo(map);
    } else {
      userAccuracyRef.current.setLatLng([userPos.lat, userPos.lng]);
      userAccuracyRef.current.setRadius(userPos.accuracyM);
    }

    const bikeHeadingDeg = smoothedHeading;
    const bikeHtml = `<div data-bike-rotate style="position:relative;width:40px;height:40px;display:flex;align-items:center;justify-content:center;transform:rotate(${bikeHeadingDeg}deg);transition:transform 0.15s linear;">
      <div style="position:absolute;inset:2px;background:rgba(59,130,246,0.25);border-radius:50%;animation:pulse 1.6s ease-out infinite;"></div>
      <svg viewBox="0 0 40 40" width="40" height="40" style="position:relative;filter:drop-shadow(0 2px 4px rgba(0,0,0,0.7));">
        <polygon points="20,4 28,18 26,20 22,20 22,30 18,30 18,20 14,20 12,18" fill="#3b82f6" stroke="#fff" stroke-width="2" stroke-linejoin="round"/>
        <circle cx="18" cy="32" r="3.5" fill="#1d4ed8" stroke="#fff" stroke-width="1.5"/>
        <circle cx="22" cy="32" r="3.5" fill="#1d4ed8" stroke="#fff" stroke-width="1.5"/>
        <rect x="17" y="10" width="6" height="4" rx="1" fill="#60a5fa"/>
      </svg>
    </div>
    <style>@keyframes pulse{0%{transform:scale(0.8);opacity:0.6}100%{transform:scale(2.2);opacity:0}}</style>`;

    if (!userMarkerRef.current) {
      userMarkerRef.current = L.marker([userPos.lat, userPos.lng], {
        icon: L.divIcon({
          html: bikeHtml, iconSize: [40, 40], iconAnchor: [20, 20], className: "user-marker-bike",
        }),
        zIndexOffset: 1000,
      }).addTo(map);
    } else {
      userMarkerRef.current.setLatLng([userPos.lat, userPos.lng]);
      const existingRotateEl = userMarkerRef.current.getElement()?.querySelector("[data-bike-rotate]") as HTMLElement | null;
      if (existingRotateEl) {
        existingRotateEl.style.transform = `rotate(${bikeHeadingDeg}deg)`;
      }
    }

    const mapSize = map.getSize();
    const targetPoint = L.point(mapSize.x / 2, mapSize.y * 0.65);
    const targetLatLng = map.containerPointToLatLng(targetPoint);
    const offsetLat = userPos.lat - targetLatLng.lat;
    const offsetLng = userPos.lng - targetLatLng.lng;
    const panTarget: [number, number] = [userPos.lat + offsetLat * 0.25, userPos.lng + offsetLng * 0.25];

    if (mapLock === "locked") {
      const center = map.getCenter();
      const dist = haversineM({ lat: center.lat, lng: center.lng }, userPos);
      if (dist > 100) {
        programmaticPanRef.current = true;
        map.setView(
          mapMode === "heading-up" ? panTarget : [userPos.lat, userPos.lng],
          Math.max(map.getZoom(), 15),
          { animate: true },
        );
        setTimeout(() => { programmaticPanRef.current = false; }, 500);
      }
    }
  }, [userPos, riding, mapMode, mapLock, smoothedHeading]);

  const showRerouteToast = useCallback((msg: string, durationMs = 3000) => {
    if (rerouteToastTimerRef.current) clearTimeout(rerouteToastTimerRef.current);
    setRerouteToast(msg);
    rerouteToastTimerRef.current = setTimeout(() => setRerouteToast(null), durationMs);
  }, []);

  useEffect(() => {
    if (!riding || !userPos) return;

    const { offRoute, nearestSection } = isOffRoute(userPos, activeRoute);
    if (!offRoute) {
      if (rerouteState.consecutiveFailures > 0 || rerouteState.givenUp) {
        setRerouteState(initialRerouteState());
      }
      return;
    }

    const { shouldReroute } = shouldAutoReroute(nearestSection, offRoute);
    if (!shouldReroute) return;

    if (!canAttemptReroute(rerouteState, Date.now())) return;

    const roadSection = nearestSection as Extract<RouteSection, { kind: "road" }>;
    const target = findRerouteTarget(roadSection, activeRoute);
    if (!target) return;

    setRerouteState((prev) => updateRerouteStateOnAttempt(prev, Date.now()));
    showRerouteToast("Recalculating…", 15000);

    void (async () => {
      const result = await attemptReroute(userPos, target, getRoadRoute);
      if (result.success && result.newRoute) {
        const updated = spliceReroutedSection(activeRoute, roadSection, result.newRoute, userPos);
        setLiveRoute(updated);
        setRerouteState((prev) => updateRerouteStateOnSuccess(prev));
        showRerouteToast("Re-routed", 3000);
      } else {
        setRerouteState((prev) => {
          const next = updateRerouteStateOnFailure(prev);
          if (next.givenUp) {
            showRerouteToast("Couldn't recalculate — check signal", 6000);
          } else {
            showRerouteToast("Re-route failed — retrying soon", 3000);
          }
          return next;
        });
      }
    })();
  }, [userPos, riding, activeRoute, rerouteState, showRerouteToast]);

  // Render route sections
  useEffect(() => {
    if (!mapRef.current || !window.L || !leafletLoaded) return;
    const L = window.L;
    const map = mapRef.current;

    sectionLayersRef.current.forEach((layer) => layer.remove());
    sectionLayersRef.current = new Map();

    const allBounds: [number, number][] = [];

    const startMarker = L.marker([activeRoute.start.lat, activeRoute.start.lng], {
      icon: L.divIcon({
        html: `<div style="background:#10b981;width:24px;height:24px;border:3px solid #fff;border-radius:50%;box-shadow:0 2px 6px rgba(0,0,0,0.6);display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:900;color:#fff;">A</div>`,
        iconSize: [24, 24], iconAnchor: [12, 12], className: "",
      }),
    }).addTo(map);
    const endMarker = L.marker([activeRoute.end.lat, activeRoute.end.lng], {
      icon: L.divIcon({
        html: `<div style="background:#dc2626;width:24px;height:24px;border:3px solid #fff;border-radius:50%;box-shadow:0 2px 6px rgba(0,0,0,0.6);display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:900;color:#fff;">B</div>`,
        iconSize: [24, 24], iconAnchor: [12, 12], className: "",
      }),
    }).addTo(map);
    sectionLayersRef.current.set(-1, startMarker);
    sectionLayersRef.current.set(-2, endMarker);
    allBounds.push([activeRoute.start.lat, activeRoute.start.lng]);
    allBounds.push([activeRoute.end.lat, activeRoute.end.lng]);

    activeRoute.sections.forEach((sec) => {
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
      } else if (sec.kind === "waypoint") {
        // Custom rider stop — fuel / campsite / generic. No polyline; the
        // road sections on either side already draw the path. We just drop
        // a coloured pin so the rider can see where the stop sits along
        // their route.
        const wp = sec.waypoint;
        const color = wp.kind === "fuel" ? "#3b82f6" : wp.kind === "campsite" ? "#22c55e" : "#f0a832";
        const glyph =
          wp.kind === "fuel"
            ? '<path d="M3 12V5a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v14H3v-7zM13 8h2a2 2 0 0 1 2 2v6a2 2 0 0 0 2 2 2 2 0 0 0 2-2v-6l-3-3"/>'
            : wp.kind === "campsite"
              ? '<path d="M3 20 12 4l9 16H3z M12 4v16"/>'
              : '<path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/>';
        const html = `<div style="width:28px;height:28px;border-radius:50%;background:${color};border:3px solid ${isActive ? "#fff" : "#f0a832"};display:flex;align-items:center;justify-content:center;box-shadow:0 2px 8px rgba(0,0,0,0.7);">
          <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">${glyph}</svg>
        </div>`;
        const wpMarker = L.marker([sec.point.lat, sec.point.lng], {
          icon: L.divIcon({
            html,
            iconSize: [28, 28],
            iconAnchor: [14, 14],
            className: "",
          }),
          zIndexOffset: 900,
        }).addTo(map);
        wpMarker.bindPopup(`<b>${wp.name}</b><br><span style="font-size:10px;color:#888">Stop · ${wp.kind}</span>`);
        sectionLayersRef.current.set(sec.index * 10, wpMarker);
        allBounds.push([sec.point.lat, sec.point.lng]);
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
        // Tapping the trail polyline opens the active-section overlay
        // for it — same gesture the rider already uses on the Sections
        // list, so removal is one tap away from the map view too.
        const openOverlay = () => setActiveSection(sec.index);
        main.on("click", openOverlay);
        shadow.on("click", openOverlay);
        sectionLayersRef.current.set(sec.index * 10, shadow);
        sectionLayersRef.current.set(sec.index * 10 + 1, main);
        // Trail entry marker (numbered)
        const trailNum = activeRoute.sections.filter((s) => s.kind === "trail" && s.index <= sec.index).length;
        const entryMarker = L.marker([sec.entry.lat, sec.entry.lng], {
          icon: L.divIcon({
            html: `<div style="background:#f97316;width:22px;height:22px;border:2.5px solid #fff;border-radius:6px;box-shadow:0 2px 6px rgba(0,0,0,0.6);display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:900;color:#000;">${trailNum}</div>`,
            iconSize: [22, 22], iconAnchor: [11, 11], className: "",
          }),
        }).addTo(map);
        entryMarker.on("click", openOverlay);
        sectionLayersRef.current.set(sec.index * 10 + 2, entryMarker);
        latlngs.forEach((c) => allBounds.push(c));
      }
    });

    // Fit bounds to whole route
    if (allBounds.length > 0) {
      try {
        if (activeSection != null) {
          const sec = activeRoute.sections.find((s) => s.index === activeSection);
          if (sec) {
            let pts: GeoPoint[];
            if (sec.kind === "road") pts = sec.route.polyline;
            else if (sec.kind === "trail") pts = sec.polyline;
            else pts = [sec.point];
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
  }, [activeRoute, leafletLoaded, activeSection]);

  useEffect(() => {
    if (!mapRef.current || !window.L || !leafletLoaded) return;
    const L = window.L;
    const map = mapRef.current;

    nearbyLayersRef.current.forEach((layer) => layer.remove());
    nearbyLayersRef.current = [];

    if (!nearbyTrails || nearbyTrails.length === 0) return;

    const NEARBY_COLOR = "#f97316";

    for (const trail of nearbyTrails) {
      const latlngs = getTrailLatLngs(trail);
      if (latlngs.length < 2) continue;

      const line = L.polyline(latlngs, {
        color: NEARBY_COLOR,
        weight: 3,
        opacity: 0.25,
        dashArray: "6 8",
        interactive: true,
      }).addTo(map);

      const popupEl = document.createElement("div");
      const nameEl = document.createElement("b");
      nameEl.style.color = "#f97316";
      nameEl.textContent = trail.name;
      popupEl.appendChild(nameEl);
      const infoEl = document.createElement("span");
      infoEl.style.fontSize = "11px";
      infoEl.style.color = "#aaa";
      const parts: string[] = [];
      if (trail.distance_km) parts.push(trail.distance_km.toFixed(1) + " km");
      if (trail.difficulty) parts.push("Diff " + trail.difficulty);
      if (parts.length > 0) {
        popupEl.appendChild(document.createElement("br"));
        infoEl.textContent = parts.join(" · ");
        popupEl.appendChild(infoEl);
      }
      line.bindPopup(popupEl);

      nearbyLayersRef.current.push(line);
    }
  }, [nearbyTrails, leafletLoaded]);

  // Kick off in-place removal of a trail section. Pauses live GPS while
  // the route is recomputed and resumes it against the new route on
  // success. On failure the previous route stays on screen and a
  // dismissible error banner explains why so the rider can retry.
  const handleConfirmRemove = async (trailId: string, trailName: string) => {
    if (!onRemoveTrailSection) return;
    if (removing || swapping) return;
    setPendingRemoval(null);
    setRemovalError(null);
    const wasRiding = riding;
    if (wasRiding) setRiding(false);
    setRemoving({
      trailId,
      trailName,
      progress: { pct: 0, label: "Re-routing your trip..." },
      wasRiding,
    });
    try {
      const result = await onRemoveTrailSection(trailId, (step, total, label) => {
        const pct = total > 0 ? Math.round((step / total) * 100) : 0;
        setRemoving((prev) =>
          prev && prev.trailId === trailId
            ? { ...prev, progress: { pct, label } }
            : prev,
        );
      });
      setRemoving(null);
      if (result.ok) {
        // The new route arrives via the `route` prop on the next
        // render; clear the overlay (the section index is gone) and
        // resume riding if the rider had GPS on.
        setActiveSection(null);
        if (wasRiding) setRiding(true);
      } else {
        setRemovalError(result.error);
        if (wasRiding) setRiding(true);
      }
    } catch (err) {
      setRemoving(null);
      setRemovalError(
        err instanceof Error
          ? err.message
          : "Something went wrong while re-routing. Please try again.",
      );
      if (wasRiding) setRiding(true);
    }
  };

  // Open the alternates picker for the given trail and start fetching
  // candidates. We snapshot the trail name so the picker header reads
  // "Swap <name>" even after the picker is dismissed mid-fetch.
  const handleOpenSwapPicker = async (trailId: string, trailName: string) => {
    if (!onFetchSwapAlternates) return;
    if (removing || swapping) return;
    setSwapError(null);
    setSwapPickerFor({ trailId, trailName });
    setSwapAlternates(null);
    try {
      const alts = await onFetchSwapAlternates(trailId);
      // Drop stale results if the rider closed the picker (or opened a
      // different one) while this fetch was in flight.
      setSwapPickerFor((current) => {
        if (current?.trailId !== trailId) return current;
        setSwapAlternates(alts);
        return current;
      });
    } catch {
      setSwapPickerFor((current) => {
        if (current?.trailId !== trailId) return current;
        setSwapAlternates([]);
        setSwapError("Couldn't load nearby trails. Check your connection.");
        return current;
      });
    }
  };

  // Substitute the active trail with the picked alternate. Same
  // GPS-pause / restore-on-failure contract as removal.
  const handleConfirmSwap = async (
    oldTrailId: string,
    oldTrailName: string,
    newTrail: Trail,
  ) => {
    if (!onSwapTrailSection) return;
    if (removing || swapping) return;
    setSwapPickerFor(null);
    setSwapAlternates(null);
    setSwapError(null);
    const wasRiding = riding;
    if (wasRiding) setRiding(false);
    setSwapping({
      trailId: oldTrailId,
      trailName: oldTrailName,
      newTrailName: newTrail.name,
      progress: { pct: 0, label: `Routing via ${newTrail.name}…` },
      wasRiding,
    });
    try {
      const result = await onSwapTrailSection(
        oldTrailId,
        newTrail,
        (step, total, label) => {
          const pct = total > 0 ? Math.round((step / total) * 100) : 0;
          setSwapping((prev) =>
            prev && prev.trailId === oldTrailId
              ? { ...prev, progress: { pct, label } }
              : prev,
          );
        },
      );
      setSwapping(null);
      if (result.ok) {
        // The active section index belonged to the OLD trail and is
        // gone now — drop the overlay and let the rider tap the new
        // trail on the map if they want to inspect it.
        setActiveSection(null);
        if (wasRiding) setRiding(true);
      } else {
        setSwapError(result.error);
        if (wasRiding) setRiding(true);
      }
    } catch (err) {
      setSwapping(null);
      setSwapError(
        err instanceof Error
          ? err.message
          : "Something went wrong while swapping. Please try again.",
      );
      if (wasRiding) setRiding(true);
    }
  };

  const handleDownloadFullGPX = () => {
    // Build a single GPX with all sections (road tracks + trail tracks).
    // Waypoint sections are zero-length stops, so we skip them in the GPX
    // export — the surrounding road sections already include the path that
    // passes through the waypoint coordinate.
    const trailRoutes: TrailRoute[] = activeRoute.sections
      .map((sec, i): TrailRoute | null => {
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
        if (sec.kind === "waypoint") return null;
        return {
          id: sec.trail.id,
          name: sec.trail.name,
          waypoints: sec.polyline.map((p) => ({ lat: p.lat, lon: p.lng })),
          distance_km: sec.distanceKm,
          legal_status: sec.trail.legal_status,
          difficulty: sec.trail.difficulty,
        };
      })
      .filter((r): r is TrailRoute => r !== null);
    const gpx = buildCombinedGPX(trailRoutes);
    const filename = `TrailForge-Trip-${new Date().toISOString().slice(0, 10)}.gpx`;
    downloadGPX(gpx, filename);
  };

  const trailSections = activeRoute.sections.filter((s): s is Extract<RouteSection, { kind: "trail" }> => s.kind === "trail");
  const roadSections = activeRoute.sections.filter((s): s is Extract<RouteSection, { kind: "road" }> => s.kind === "road");

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
              {activeRoute.start.label?.split(",")[0] || "Start"} → {activeRoute.end.label?.split(",")[0] || "End"}
            </div>
          </div>
          <div className="flex items-center gap-1.5">
            <button
              onClick={() => {
                if (!riding) {
                  void requestCompassPermission();
                  setMapLock("locked");
                }
                setRiding((v) => !v);
              }}
              className={`px-2.5 py-1.5 rounded-lg border transition-all flex items-center gap-1.5 ${
                riding
                  ? "bg-red-500/25 border-red-500/60 text-red-300 hover:bg-red-500/35"
                  : "bg-green-500/20 border-green-500/50 text-green-300 hover:bg-green-500/30"
              }`}
              title={riding ? "Stop live navigation" : "Start live GPS navigation"}
            >
              {riding ? (
                <>
                  <span className="w-2.5 h-2.5 rounded-sm bg-red-400"></span>
                  <span className="text-[10px] font-black uppercase tracking-wider">Stop</span>
                </>
              ) : (
                <>
                  <svg viewBox="0 0 24 24" className="w-3.5 h-3.5" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>
                  <span className="text-[10px] font-black uppercase tracking-wider">Ride</span>
                </>
              )}
            </button>
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
        </div>

        {/* Stats row */}
        <div className="grid grid-cols-4 divide-x divide-[hsl(30,12%,16%)] border-t border-[hsl(30,12%,14%)]">
          <div className="py-2 text-center">
            <div className="text-sm font-bold text-amber-400">{formatKm(activeRoute.totalDistanceKm)}</div>
            <div className="text-[9px] text-stone-500 uppercase tracking-wider">Total</div>
          </div>
          <div className="py-2 text-center">
            <div className="text-sm font-bold text-blue-400">{formatKm(activeRoute.totalRoadKm)}</div>
            <div className="text-[9px] text-stone-500 uppercase tracking-wider">Road</div>
          </div>
          <div className="py-2 text-center">
            <div className="text-sm font-bold text-orange-400">{formatKm(activeRoute.totalTrailKm)}</div>
            <div className="text-[9px] text-stone-500 uppercase tracking-wider">Trail</div>
          </div>
          <div className="py-2 text-center">
            <div className="text-sm font-bold text-stone-200">{formatDurationMin(activeRoute.totalDurationMin)}</div>
            <div className="text-[9px] text-stone-500 uppercase tracking-wider">Est. Time</div>
          </div>
        </div>
      </div>

      {/* LIVE NAV BANNER — shows when riding */}
      {riding && (
        <div className="shrink-0 bg-gradient-to-r from-blue-900/60 to-stone-900/80 border-b-2 border-blue-500/50 px-3 py-2.5">
          {!userPos && !geoError && (
            <div className="flex items-center gap-2">
              <div className="w-3 h-3 rounded-full bg-blue-500 animate-pulse"></div>
              <span className="text-xs text-blue-200 font-medium">Acquiring GPS signal...</span>
            </div>
          )}
          {geoError && (
            <div className="flex items-center gap-2">
              <svg viewBox="0 0 24 24" className="w-4 h-4 text-red-400 shrink-0" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
              </svg>
              <span className="text-[11px] text-red-300 leading-tight">{geoError}</span>
            </div>
          )}
          {userPos && currentSection && (() => {
            const isRoad = currentSection.kind === "road";
            const isTrail = currentSection.kind === "trail";
            // 3 distinct states: road-with-step, road-without-step, trail
            const hasManeuver = isRoad && nextRoadStep != null;
            const accent = isRoad ? "#3b82f6" : "#f97316";
            return (
            <div className="flex items-stretch gap-3">
              {/* Big maneuver / section icon */}
              <div className="shrink-0 w-14 h-14 rounded-xl flex flex-col items-center justify-center"
                   style={{
                     background: isRoad ? "rgba(59,130,246,0.25)" : "rgba(249,115,22,0.25)",
                     border: `2px solid ${accent}`,
                   }}>
                {hasManeuver ? (
                  <svg viewBox="0 0 24 24" className="w-7 h-7 text-blue-300" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d={maneuverArrow(nextRoadStep!.maneuver, nextRoadStep!.modifier)}/>
                  </svg>
                ) : isRoad ? (
                  <svg viewBox="0 0 24 24" className="w-7 h-7 text-blue-300" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                    <path d="M12 5v14M12 5l-4 4M12 5l4 4"/>
                  </svg>
                ) : (
                  <>
                    <svg viewBox="0 0 24 24" className="w-6 h-6 text-orange-300" fill="none" stroke="currentColor" strokeWidth="2">
                      <polygon points="12 2 22 8.5 22 15.5 12 22 2 15.5 2 8.5 12 2"/>
                    </svg>
                    <span className="text-[8px] text-orange-300 font-black uppercase mt-0.5">Trail</span>
                  </>
                )}
              </div>
              {/* Instruction text */}
              <div className="flex-1 min-w-0 flex flex-col justify-center">
                {hasManeuver ? (
                  <>
                    <div className="text-[10px] text-blue-300 font-bold uppercase tracking-wider">
                      {nextRoadStepInfo && nextRoadStepInfo.distanceToStepM > 30
                        ? `In ${formatDistance(nextRoadStepInfo.distanceToStepM)}`
                        : "Now"}
                    </div>
                    <div className="text-sm font-bold text-white leading-tight truncate">
                      {nextRoadStep!.instruction}
                    </div>
                    <div className="text-[10px] text-stone-400 mt-0.5 truncate">
                      On road to {currentSection.kind === "road" ? (currentSection.label.split("→")[1]?.trim() || "next trail") : ""}
                    </div>
                  </>
                ) : isRoad ? (
                  <>
                    <div className="text-[10px] text-blue-300 font-bold uppercase tracking-wider">
                      On the road
                    </div>
                    <div className="text-sm font-bold text-white leading-tight truncate">
                      Stay on this road
                    </div>
                    <div className="text-[10px] text-stone-400 mt-0.5 truncate">
                      Heading to {currentSection.kind === "road" ? (currentSection.label.split("→")[1]?.trim() || "next trail") : ""}
                    </div>
                  </>
                ) : (
                  <>
                    <div className="text-[10px] text-orange-300 font-bold uppercase tracking-wider">
                      Off-road · Follow GPX
                    </div>
                    <div className="text-sm font-bold text-white leading-tight truncate">
                      {isTrail ? currentSection.trail.name : "On trail"}
                    </div>
                    <div className="text-[10px] text-stone-400 mt-0.5">
                      {isTrail && `Difficulty ${currentSection.trail.difficulty} · ${currentSection.trail.legal_status}`}
                    </div>
                  </>
                )}
              </div>
              <div className="shrink-0 flex flex-col items-end justify-center text-right">
                {userPos.speedMs != null && userPos.speedMs > 0 && (
                  <div>
                    <div className="text-base font-black text-white leading-none">{Math.round(userPos.speedMs * 3.6)}</div>
                    <div className="text-[8px] text-stone-400 uppercase">km/h</div>
                  </div>
                )}
                {offRouteM != null && offRouteM > OFF_ROUTE_THRESHOLD_M && (() => {
                  const isTrailOff = currentSection?.kind === "trail";
                  if (rerouteState.status === "recalculating") {
                    return (
                      <div className="mt-1 px-1.5 py-0.5 rounded bg-blue-500/20 border border-blue-500/40">
                        <div className="text-[8px] text-blue-300 font-bold uppercase">Recalculating…</div>
                      </div>
                    );
                  }
                  if (isTrailOff) {
                    return (
                      <div className="mt-1 px-1.5 py-0.5 rounded bg-orange-500/20 border border-orange-500/40 max-w-[120px]">
                        <div className="text-[8px] text-orange-300 font-bold uppercase">Off-trail</div>
                        <div className="text-[9px] text-orange-200">{formatDistance(offRouteM)}</div>
                        <div className="text-[8px] text-orange-200/70 leading-tight mt-0.5">Return to the marked path. Trail sections aren't recalculated.</div>
                      </div>
                    );
                  }
                  if (rerouteState.givenUp) {
                    return (
                      <div className="mt-1 px-1.5 py-0.5 rounded bg-red-500/20 border border-red-500/40 max-w-[120px]">
                        <div className="text-[8px] text-red-300 font-bold uppercase">Off-route</div>
                        <div className="text-[9px] text-red-200">{formatDistance(offRouteM)}</div>
                        <div className="text-[8px] text-red-200/70 leading-tight mt-0.5">Couldn't recalculate — check signal</div>
                      </div>
                    );
                  }
                  return (
                    <div className="mt-1 px-1.5 py-0.5 rounded bg-amber-500/20 border border-amber-500/40">
                      <div className="text-[8px] text-amber-300 font-bold uppercase">Off-route</div>
                      <div className="text-[9px] text-amber-200">{formatDistance(offRouteM)}</div>
                    </div>
                  );
                })()}
              </div>
            </div>
            );
          })()}
        </div>
      )}

      {/* Warnings if any */}
      {(activeRoute.skippedTrails.length > 0 || activeRoute.failedRoadSegments > 0) && (
        <div className="shrink-0 bg-amber-900/30 border-b border-amber-600/40 px-3 py-2 flex items-start gap-2">
          <svg viewBox="0 0 24 24" className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
            <line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
          </svg>
          <div className="flex-1 text-[11px] text-amber-200 leading-tight">
            {activeRoute.skippedTrails.length > 0 && (
              <p>Skipped {activeRoute.skippedTrails.length} trail{activeRoute.skippedTrails.length !== 1 ? "s" : ""} with missing GPX: {activeRoute.skippedTrails.join(", ")}</p>
            )}
            {activeRoute.failedRoadSegments > 0 && (
              <p>Could not compute {activeRoute.failedRoadSegments} road segment{activeRoute.failedRoadSegments !== 1 ? "s" : ""} (try again — public OSRM may be busy)</p>
            )}
          </div>
        </div>
      )}

      {/* Map */}
      <div className="relative overflow-hidden" style={{ height: "45vh" }}>
        <div ref={mapContainerRef} className="bg-stone-900" style={{
          position: "absolute",
          inset: "-15%",
          width: "130%",
          height: "130%",
          transformOrigin: "center center",
          transition: mapMode === "north-up" ? "transform 0.3s ease" : undefined,
        }} />
        {!leafletLoaded && (
          <div className="absolute inset-0 flex items-center justify-center bg-[hsl(22,15%,8%)]">
            <div className="text-center">
              <div className="w-8 h-8 border-2 border-amber-500/30 border-t-amber-500 rounded-full animate-spin mx-auto mb-2"></div>
              <p className="text-xs text-stone-400">Loading navigation map...</p>
            </div>
          </div>
        )}

        {riding && (
          <button
            onClick={handleCompassTap}
            className={`absolute top-3 left-3 z-[700] w-10 h-10 rounded-full border backdrop-blur flex items-center justify-center shadow-lg transition-colors ${
              mapMode === "heading-up" && mapLock === "unlocked"
                ? "bg-blue-900/80 border-blue-400 hover:bg-blue-800/90"
                : "bg-stone-900/80 border-stone-600 hover:bg-stone-800/90"
            }`}
            title={
              mapMode === "heading-up" && mapLock === "unlocked"
                ? "Re-centre on rider"
                : mapMode === "heading-up"
                  ? "Switch to north-up"
                  : "Switch to heading-up"
            }
            aria-label="Compass: toggle map orientation"
          >
            <svg viewBox="0 0 24 24" width="20" height="20" style={{
              transform: mapMode === "heading-up" ? `rotate(${-smoothedHeading}deg)` : "rotate(0deg)",
              transition: "transform 0.2s ease",
            }}>
              <polygon points="12,2 8,14 12,12 16,14" fill="#ef4444" stroke="#fff" strokeWidth="0.8"/>
              <polygon points="12,22 8,14 12,12 16,14" fill="#94a3b8" stroke="#fff" strokeWidth="0.8"/>
              <text x="12" y="7" textAnchor="middle" fontSize="5" fontWeight="bold" fill="#fff">N</text>
            </svg>
          </button>
        )}

        {rerouteToast && (
          <div className="absolute top-3 left-1/2 -translate-x-1/2 z-[700] px-3 py-1.5 rounded-full bg-stone-900/90 border border-blue-500/50 backdrop-blur shadow-lg">
            <span className="text-[11px] font-bold text-blue-200">{rerouteToast}</span>
          </div>
        )}

        {/* Active section overlay */}
        {activeSection != null && (() => {
          const sec = activeRoute.sections.find((s) => s.index === activeSection);
          if (!sec) return null;
          let bg: string;
          let badge: string;
          let title: string;
          let subtitle: string;
          if (sec.kind === "road") {
            bg = "rgba(59,130,246,0.95)";
            badge = "RD";
            title = sec.label;
            subtitle = `${formatKm(sec.route.distanceKm)} · ${formatDurationMin(sec.route.durationMin)} · ${sec.route.steps.length} turns`;
          } else if (sec.kind === "trail") {
            bg = "rgba(249,115,22,0.95)";
            badge = `T${trailSections.findIndex((t) => t.index === sec.index) + 1}`;
            title = sec.trail.name;
            subtitle = `${formatKm(sec.distanceKm)} · Difficulty ${sec.trail.difficulty} · ${sec.trail.legal_status}`;
          } else {
            bg = "rgba(240,168,50,0.95)";
            badge = "ST";
            title = sec.waypoint.name;
            subtitle = `Stop · ${sec.waypoint.kind}`;
          }
          // Removal action only applies to trail sections — road and
          // waypoint sections are deliberately not removable from the
          // navigation view (per the task scope).
          const isTrailSec = sec.kind === "trail";
          const trailId = isTrailSec ? sec.trail.id : null;
          const trailName = isTrailSec ? sec.trail.name : "";
          const canRemove =
            isTrailSec && !!onRemoveTrailSection && !removing && !swapping;
          const canSwap =
            isTrailSec &&
            !!onFetchSwapAlternates &&
            !!onSwapTrailSection &&
            !removing &&
            !swapping &&
            !swapPickerFor;
          const isPendingThis = isTrailSec && pendingRemoval?.trailId === trailId;
          const isRemovingThis = isTrailSec && removing?.trailId === trailId;
          const isSwappingThis = isTrailSec && swapping?.trailId === trailId;
          return (
            <div className="absolute top-2 left-2 right-2 z-[500]">
              <div
                className="rounded-lg backdrop-blur shadow-lg overflow-hidden"
                style={{ background: bg, color: "#fff" }}
              >
                <div className="p-2 flex items-center gap-2">
                  <div className="w-7 h-7 rounded-md bg-white/20 flex items-center justify-center text-[11px] font-black">
                    {badge}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-xs font-bold truncate">{title}</div>
                    <div className="text-[10px] opacity-80 capitalize">{subtitle}</div>
                  </div>
                  <button
                    onClick={() => {
                      if (removing) return;
                      setPendingRemoval(null);
                      setActiveSection(null);
                    }}
                    disabled={!!removing}
                    className="text-white/80 hover:text-white text-lg leading-none disabled:opacity-40"
                    aria-label="Close section overlay"
                  >×</button>
                </div>

                {/* Trail-only: Swap + Remove buttons (paired), inline
                    confirm + progress. Hidden once a swap or remove is
                    in flight so the rider can't fire the other action
                    mid-recompute. */}
                {isTrailSec &&
                  !isPendingThis &&
                  !isRemovingThis &&
                  !isSwappingThis && (
                    <div className="px-2 pb-2">
                      <NavMarkRiddenButton trail={sec.trail} />
                    </div>
                  )}
                {isTrailSec &&
                  !isPendingThis &&
                  !isRemovingThis &&
                  !isSwappingThis &&
                  (canRemove || canSwap) && (
                    <div className="px-2 pb-2 flex gap-1.5">
                      {canSwap && (
                        <button
                          type="button"
                          onClick={() =>
                            void handleOpenSwapPicker(trailId!, trailName)
                          }
                          data-testid="nav-swap-trail-button"
                          className="flex-1 py-1.5 rounded-md bg-stone-900/45 hover:bg-stone-900/65 border border-white/30 text-[11px] font-bold uppercase tracking-wider text-white flex items-center justify-center gap-1.5 transition-colors"
                        >
                          <svg viewBox="0 0 24 24" className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                            <polyline points="17 1 21 5 17 9"/>
                            <path d="M3 11V9a4 4 0 0 1 4-4h14"/>
                            <polyline points="7 23 3 19 7 15"/>
                            <path d="M21 13v2a4 4 0 0 1-4 4H3"/>
                          </svg>
                          Swap trail
                        </button>
                      )}
                      {canRemove && (
                        <button
                          type="button"
                          onClick={() =>
                            setPendingRemoval({ trailId: trailId!, trailName })
                          }
                          data-testid="nav-remove-trail-button"
                          className="flex-1 py-1.5 rounded-md bg-stone-900/45 hover:bg-stone-900/65 border border-white/30 text-[11px] font-bold uppercase tracking-wider text-white flex items-center justify-center gap-1.5 transition-colors"
                        >
                          <svg viewBox="0 0 24 24" className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                            <polyline points="3 6 5 6 21 6"/>
                            <path d="M19 6l-1.5 14a2 2 0 0 1-2 1.8H8.5a2 2 0 0 1-2-1.8L5 6"/>
                            <path d="M10 11v6M14 11v6"/>
                            <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>
                          </svg>
                          Remove
                        </button>
                      )}
                    </div>
                  )}
                {/* Swap-in-progress strip — mirrors the removal strip
                    so the two flows feel symmetric to the rider. */}
                {isSwappingThis && (
                  <div
                    className="px-2 pb-2"
                    data-testid="nav-swap-trail-progress"
                  >
                    <div className="flex items-center gap-2 mb-1">
                      <span className="w-3 h-3 border-2 border-white/30 border-t-white rounded-full animate-spin"></span>
                      <span className="text-[11px] font-bold truncate">
                        {swapping!.progress.label}
                      </span>
                    </div>
                    <div className="h-1 bg-black/30 rounded-full overflow-hidden">
                      <div
                        className="h-full bg-white/85 transition-all duration-300"
                        style={{ width: `${swapping!.progress.pct}%` }}
                      ></div>
                    </div>
                  </div>
                )}
                {isTrailSec && isPendingThis && !isRemovingThis && (
                  <div
                    className="px-2 pb-2 flex items-center gap-2"
                    data-testid="nav-remove-trail-confirm"
                  >
                    <span className="text-[11px] font-medium flex-1 truncate">
                      Drop this trail and re-route?
                    </span>
                    <button
                      type="button"
                      onClick={() => setPendingRemoval(null)}
                      data-testid="nav-remove-trail-cancel"
                      className="px-2.5 py-1 rounded-md text-[10px] font-bold uppercase tracking-wider bg-white/15 hover:bg-white/25 text-white border border-white/20"
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      onClick={() => handleConfirmRemove(trailId!, trailName)}
                      data-testid="nav-remove-trail-confirm-yes"
                      className="px-2.5 py-1 rounded-md text-[10px] font-bold uppercase tracking-wider bg-stone-900 hover:bg-black text-amber-300 border border-amber-400/60"
                    >
                      Remove
                    </button>
                  </div>
                )}
                {isTrailSec && isRemovingThis && (
                  <div
                    className="px-2 pb-2"
                    data-testid="nav-remove-trail-progress"
                  >
                    <div className="flex items-center gap-2 mb-1">
                      <span className="w-3 h-3 border-2 border-white/30 border-t-white rounded-full animate-spin"></span>
                      <span className="text-[11px] font-bold truncate">
                        {removing!.progress.label}
                      </span>
                    </div>
                    <div className="h-1 bg-black/30 rounded-full overflow-hidden">
                      <div
                        className="h-full bg-white/85 transition-all duration-300"
                        style={{ width: `${removing!.progress.pct}%` }}
                      ></div>
                    </div>
                  </div>
                )}
              </div>
            </div>
          );
        })()}

        {/* Swap-trail alternates picker — full-width sheet near the
            top so it doesn't fight the bottom Sections/Turns panel.
            Shown only after the rider taps Swap; clicking outside or
            Cancel closes it without affecting the route. */}
        {swapPickerFor && (
          <div
            className="absolute top-2 left-2 right-2 z-[600]"
            data-testid="nav-swap-trail-picker"
          >
            <div className="rounded-lg bg-[hsl(22,15%,11%)]/97 backdrop-blur shadow-xl border border-amber-500/40 overflow-hidden">
              <div className="flex items-center justify-between px-3 py-2 border-b border-[hsl(30,12%,20%)]">
                <div className="min-w-0">
                  <div className="text-[10px] uppercase tracking-wider text-amber-400 font-bold">
                    Swap trail
                  </div>
                  <div
                    className="text-xs text-stone-300 truncate"
                    title={swapPickerFor.trailName}
                  >
                    Replace {swapPickerFor.trailName}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setSwapPickerFor(null);
                    setSwapAlternates(null);
                  }}
                  data-testid="nav-swap-trail-cancel"
                  aria-label="Cancel swap"
                  className="text-stone-400 hover:text-stone-200 text-lg leading-none px-1"
                >×</button>
              </div>
              <div className="max-h-64 overflow-y-auto">
                {swapAlternates === null && (
                  <div
                    className="flex items-center justify-center gap-2 py-6"
                    data-testid="nav-swap-trail-loading"
                  >
                    <span className="w-3.5 h-3.5 border-2 border-stone-600 border-t-amber-400 rounded-full animate-spin"></span>
                    <span className="text-[11px] text-stone-400">
                      Finding nearby trails…
                    </span>
                  </div>
                )}
                {swapAlternates !== null && swapAlternates.length === 0 && (
                  <div
                    className="px-3 py-5 text-center text-[11px] text-stone-500"
                    data-testid="nav-swap-trail-empty"
                  >
                    No nearby trails of similar difficulty were found. Try
                    Remove from trip instead.
                  </div>
                )}
                {swapAlternates !== null && swapAlternates.length > 0 && (
                  <ul className="divide-y divide-[hsl(30,12%,18%)]">
                    {swapAlternates.map((alt) => (
                      <li key={alt.id}>
                        <button
                          type="button"
                          onClick={() =>
                            void handleConfirmSwap(
                              swapPickerFor.trailId,
                              swapPickerFor.trailName,
                              alt,
                            )
                          }
                          data-testid={`nav-swap-trail-pick-${alt.id}`}
                          className="w-full text-left px-3 py-2 hover:bg-amber-500/10 transition-colors flex items-center gap-2"
                        >
                          <div className="flex-1 min-w-0">
                            <div className="text-xs font-bold text-stone-100 truncate">
                              {alt.name}
                            </div>
                            <div className="text-[10px] text-stone-500 mt-0.5">
                              {alt.distance_km != null
                                ? `${alt.distance_km.toFixed(1)} km`
                                : "—"}
                              {alt.difficulty != null
                                ? ` · Difficulty ${alt.difficulty}`
                                : ""}
                              {alt.legal_status ? ` · ${alt.legal_status}` : ""}
                            </div>
                          </div>
                          <svg viewBox="0 0 24 24" className="w-3.5 h-3.5 text-amber-400 shrink-0" fill="none" stroke="currentColor" strokeWidth="2.5">
                            <polyline points="9 18 15 12 9 6"/>
                          </svg>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Swap error banner — sibling to the removal banner. */}
        {swapError && (
          <div
            className="absolute bottom-2 left-2 right-2 z-[500]"
            data-testid="nav-swap-trail-error"
          >
            <div className="rounded-lg bg-red-900/90 border border-red-500/60 backdrop-blur shadow-lg px-3 py-2 flex items-start gap-2">
              <svg viewBox="0 0 24 24" className="w-4 h-4 text-red-300 shrink-0 mt-0.5" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
              </svg>
              <p className="flex-1 text-[11px] text-red-100 leading-tight">{swapError}</p>
              <button
                onClick={() => setSwapError(null)}
                aria-label="Dismiss error"
                className="text-red-300 hover:text-white text-base leading-none -mt-0.5"
              >×</button>
            </div>
          </div>
        )}

        {/* Removal error banner — sits over the map so it's visible
            no matter which tab is active in the bottom panel. */}
        {removalError && (
          <div
            className="absolute bottom-2 left-2 right-2 z-[500]"
            data-testid="nav-remove-trail-error"
          >
            <div className="rounded-lg bg-red-900/90 border border-red-500/60 backdrop-blur shadow-lg px-3 py-2 flex items-start gap-2">
              <svg viewBox="0 0 24 24" className="w-4 h-4 text-red-300 shrink-0 mt-0.5" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
              </svg>
              <p className="flex-1 text-[11px] text-red-100 leading-tight">{removalError}</p>
              <button
                onClick={() => setRemovalError(null)}
                aria-label="Dismiss error"
                className="text-red-300 hover:text-white text-base leading-none -mt-0.5"
              >×</button>
            </div>
          </div>
        )}
      </div>

      {/* Tab switcher */}
      <div className="shrink-0 flex border-b border-[hsl(30,12%,16%)] bg-[hsl(22,15%,9%)]">
        <button
          onClick={() => setBottomTab("sections")}
          className={`flex-1 py-2.5 text-xs font-bold uppercase tracking-wider transition-all ${
            bottomTab === "sections" ? "text-amber-400 border-b-2 border-amber-400" : "text-stone-500"
          }`}
        >
          Sections ({activeRoute.sections.length})
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
          <SectionsList
            route={activeRoute}
            activeSection={activeSection}
            onSelect={setActiveSection}
            canRemoveTrails={!!onRemoveTrailSection && !removing && !swapping}
            removingTrailId={removing?.trailId ?? null}
            onRequestRemoveTrail={(trailId, trailName) => {
              if (removing || swapping) return;
              const trailSec = activeRoute.sections.find(
                (s) => s.kind === "trail" && s.trail.id === trailId,
              );
              if (trailSec) setActiveSection(trailSec.index);
              setPendingRemoval({ trailId, trailName });
            }}
          />
        ) : (
          <TurnByTurnList route={activeRoute} onSelectSection={setActiveSection} />
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
  canRemoveTrails,
  removingTrailId,
  onRequestRemoveTrail,
}: {
  route: AssembledRoute;
  activeSection: number | null;
  onSelect: (idx: number | null) => void;
  canRemoveTrails: boolean;
  removingTrailId: string | null;
  onRequestRemoveTrail: (trailId: string, trailName: string) => void;
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
        if (sec.kind === "waypoint") {
          const wp = sec.waypoint;
          const wpColor = wp.kind === "fuel" ? "text-blue-400 bg-blue-500/15" : wp.kind === "campsite" ? "text-green-400 bg-green-500/15" : "text-amber-400 bg-amber-500/15";
          return (
            <button
              key={sec.index}
              onClick={() => onSelect(isActive ? null : sec.index)}
              className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg border transition-all ${
                isActive ? "border-amber-500/60 bg-amber-500/10" : "border-amber-500/20 bg-amber-900/10 hover:border-amber-500/40"
              }`}
            >
              <div className={`w-7 h-7 rounded-md flex items-center justify-center shrink-0 ${wpColor}`}>
                <svg viewBox="0 0 24 24" className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2.2">
                  <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/>
                  <circle cx="12" cy="10" r="3"/>
                </svg>
              </div>
              <div className="flex-1 min-w-0 text-left">
                <div className="text-xs font-bold text-stone-200 truncate">{wp.name}</div>
                <div className="text-[10px] text-stone-500 capitalize">Stop · {wp.kind}</div>
              </div>
              <svg viewBox="0 0 24 24" className={`w-4 h-4 transition-transform ${isActive ? "rotate-90" : ""} text-stone-500`} fill="none" stroke="currentColor" strokeWidth="2">
                <polyline points="9 18 15 12 9 6"/>
              </svg>
            </button>
          );
        }
        const tNum = trailSections.findIndex((t) => t.index === sec.index) + 1;
        const isRemoving = removingTrailId === sec.trail.id;
        return (
          <div
            key={sec.index}
            data-testid={`nav-section-trail-${sec.trail.id}`}
            className={`flex items-center gap-2 pr-2 rounded-lg border transition-all ${
              isActive ? "border-orange-500/60 bg-orange-500/10" : "border-orange-500/20 bg-orange-900/10 hover:border-orange-500/40"
            } ${isRemoving ? "opacity-60" : ""}`}
          >
            <button
              onClick={() => onSelect(isActive ? null : sec.index)}
              className="flex-1 flex items-center gap-3 px-3 py-2.5 text-left min-w-0"
              disabled={isRemoving}
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
            {canRemoveTrails && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onRequestRemoveTrail(sec.trail.id, sec.trail.name);
                }}
                disabled={isRemoving}
                aria-label={`Remove ${sec.trail.name} from trip`}
                title="Remove from trip"
                data-testid={`nav-section-trail-remove-${sec.trail.id}`}
                className="shrink-0 w-7 h-7 rounded-md flex items-center justify-center border border-stone-700 bg-stone-900/60 text-stone-400 hover:border-red-500/60 hover:text-red-400 hover:bg-red-900/20 transition-all disabled:opacity-50"
              >
                <svg viewBox="0 0 24 24" className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="3 6 5 6 21 6"/>
                  <path d="M19 6l-1.5 14a2 2 0 0 1-2 1.8H8.5a2 2 0 0 1-2-1.8L5 6"/>
                  <path d="M10 11v6M14 11v6"/>
                  <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>
                </svg>
              </button>
            )}
          </div>
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
        if (sec.kind === "waypoint") {
          const wp = sec.waypoint;
          return (
            <div key={sec.index} className="rounded-lg overflow-hidden border border-amber-500/30 bg-amber-500/5">
              <button
                onClick={() => onSelectSection(sec.index)}
                className="w-full px-3 py-2.5 bg-amber-500/15 border-b border-amber-500/20 flex items-center gap-2"
              >
                <svg viewBox="0 0 24 24" className="w-4 h-4 text-amber-300" fill="none" stroke="currentColor" strokeWidth="2.4">
                  <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/>
                  <circle cx="12" cy="10" r="3"/>
                </svg>
                <span className="text-[11px] font-bold text-amber-300 uppercase tracking-wider truncate">
                  Stop · {wp.name}
                </span>
              </button>
              <div className="px-3 py-2.5 text-[11px] text-stone-300 capitalize">
                Pause here for <span className="text-amber-300 font-semibold">{wp.kind}</span>
              </div>
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

/**
 * Compact mark-as-ridden control for the trail-section overlay shown
 * during navigation. Lets a rider log a trail as completed without
 * leaving the nav view (most likely flow: finish a trail, glance at
 * overlay, tap "Mark ridden"). Optimistic; rolls back on server error.
 */
function NavMarkRiddenButton({ trail }: { trail: Trail }) {
  const { completed } = useCompletionState(trail.id);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const handleClick = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    const ok = completed
      ? await unmarkCompleted(trail.id)
      : await markCompleted(trail);
    setBusy(false);
    if (!ok) {
      // Most likely cause mid-ride is a 401 (session expired) or no
      // network. Show a brief inline message so the toggle's visual
      // rollback isn't confusing — auto-clears after 4s.
      setError(
        completed ? "Couldn't undo — try again" : "Couldn't mark — sign in & retry",
      );
      window.setTimeout(() => setError(null), 4000);
    }
  };
  return (
    <div>
      <button
        type="button"
        onClick={handleClick}
        disabled={busy}
        aria-pressed={completed}
        data-testid="nav-mark-ridden-button"
        className={
          "w-full py-1.5 rounded-md text-[11px] font-bold uppercase tracking-wider flex items-center justify-center gap-1.5 transition-colors border " +
          (completed
            ? "bg-emerald-500/25 border-emerald-300/60 text-white"
            : "bg-stone-900/45 hover:bg-stone-900/65 border-white/30 text-white") +
          (busy ? " opacity-60" : "")
        }
      >
        <svg viewBox="0 0 24 24" className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2.5">
          <polyline points="20 6 9 17 4 12" />
        </svg>
        {completed ? "Ridden ✓ — tap to undo" : "Mark as ridden"}
      </button>
      {error ? (
        <p
          className="mt-1 text-[10px] text-amber-200 text-center"
          data-testid="nav-mark-ridden-error"
        >
          {error}
        </p>
      ) : null}
    </div>
  );
}

// Re-export GeoPoint for convenience
export type { GeoPoint };
