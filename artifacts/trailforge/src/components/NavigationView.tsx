import { useEffect, useRef, useState } from "react";
import {
  type AssembledRoute,
  type RouteSection,
  type GeoPoint,
  formatDistance,
  formatKm,
  formatDurationMin,
  maneuverArrow,
  haversineM,
  HYBRID_LABEL_TILE_URL,
  HYBRID_LABEL_TILE_ATTRIBUTION,
} from "@/lib/routing";
import { buildCombinedGPX, downloadGPX, type TrailRoute } from "@/lib/gpx";

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

interface Props {
  route: AssembledRoute;
  onClose: () => void;
  /**
   * Drop the given trail from the planner selection and rebuild the
   * assembled route in place. The implementation MUST recompute the
   * route off `route.start` / `route.end` with the trail removed and,
   * on success, push the new `AssembledRoute` back via the same channel
   * NavigationView's `route` prop is fed from. Progress callbacks
   * mirror the planner's initial-plan progress contract.
   *
   * Returning `{ ok: false }` signals re-routing failed end-to-end —
   * the previous route stays on screen and the trail is NOT removed
   * from the planner store.
   */
  onRemoveTrailSection?: (
    trailId: string,
    onProgress: (step: number, total: number, label: string) => void,
  ) => Promise<RemoveTrailSectionResult>;
}

export default function NavigationView({ route, onClose, onRemoveTrailSection }: Props) {
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<import("leaflet").Map | null>(null);
  const sectionLayersRef = useRef<Map<number, import("leaflet").Polyline | import("leaflet").Marker>>(new Map());
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

  // Computed nav state from current user position
  const nearestInfo = userPos ? findNearestSection(route, userPos) : null;
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
    // Hybrid place-label overlay so the rider can read town/road names
    // while navigating on the satellite base layer.
    L.tileLayer(HYBRID_LABEL_TILE_URL, {
      attribution: HYBRID_LABEL_TILE_ATTRIBUTION,
      opacity: 0.95,
      maxZoom: 19,
      pane: "shadowPane",
    }).addTo(map);
    mapRef.current = map;
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
      userMarkerRef.current = null;
      userAccuracyRef.current = null;
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

  // Update user marker and auto-pan map when riding
  useEffect(() => {
    if (!mapRef.current || !window.L) return;
    const L = window.L;
    const map = mapRef.current;

    // Remove if not riding or no position
    if (!riding || !userPos) {
      if (userMarkerRef.current) { userMarkerRef.current.remove(); userMarkerRef.current = null; }
      if (userAccuracyRef.current) { userAccuracyRef.current.remove(); userAccuracyRef.current = null; }
      return;
    }

    // Accuracy circle
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

    // Pulsing user marker
    const heading = userPos.headingDeg ?? 0;
    const html = `<div style="position:relative;width:32px;height:32px;display:flex;align-items:center;justify-content:center;">
      <div style="position:absolute;inset:0;background:#3b82f6;border-radius:50%;opacity:0.3;animation:pulse 1.6s ease-out infinite;"></div>
      <div style="position:relative;width:18px;height:18px;background:#3b82f6;border:3px solid #fff;border-radius:50%;box-shadow:0 2px 6px rgba(0,0,0,0.6);"></div>
      ${userPos.headingDeg != null ? `<div style="position:absolute;top:-2px;left:50%;transform:translateX(-50%) rotate(${heading}deg);transform-origin:50% 18px;width:0;height:0;border-left:6px solid transparent;border-right:6px solid transparent;border-bottom:10px solid #3b82f6;"></div>` : ""}
    </div>
    <style>@keyframes pulse{0%{transform:scale(0.8);opacity:0.6}100%{transform:scale(2.2);opacity:0}}</style>`;

    if (!userMarkerRef.current) {
      userMarkerRef.current = L.marker([userPos.lat, userPos.lng], {
        icon: L.divIcon({
          html, iconSize: [32, 32], iconAnchor: [16, 16], className: "user-marker",
        }),
        zIndexOffset: 1000,
      }).addTo(map);
    } else {
      userMarkerRef.current.setLatLng([userPos.lat, userPos.lng]);
      userMarkerRef.current.setIcon(L.divIcon({
        html, iconSize: [32, 32], iconAnchor: [16, 16], className: "user-marker",
      }));
    }

    // Auto-pan if user is far from map center
    const center = map.getCenter();
    const dist = haversineM({ lat: center.lat, lng: center.lng }, userPos);
    if (dist > 200) {
      map.setView([userPos.lat, userPos.lng], Math.max(map.getZoom(), 15), { animate: true });
    }
  }, [userPos, riding]);

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
        const trailNum = route.sections.filter((s) => s.kind === "trail" && s.index <= sec.index).length;
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
          const sec = route.sections.find((s) => s.index === activeSection);
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
  }, [route, leafletLoaded, activeSection]);

  // Kick off in-place removal of a trail section. Pauses live GPS while
  // the route is recomputed and resumes it against the new route on
  // success. On failure the previous route stays on screen and a
  // dismissible error banner explains why so the rider can retry.
  const handleConfirmRemove = async (trailId: string, trailName: string) => {
    if (!onRemoveTrailSection) return;
    if (removing) return;
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

  const handleDownloadFullGPX = () => {
    // Build a single GPX with all sections (road tracks + trail tracks).
    // Waypoint sections are zero-length stops, so we skip them in the GPX
    // export — the surrounding road sections already include the path that
    // passes through the waypoint coordinate.
    const trailRoutes: TrailRoute[] = route.sections
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
          <div className="flex items-center gap-1.5">
            <button
              onClick={() => setRiding((v) => !v)}
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
              {/* Speed + off-route */}
              <div className="shrink-0 flex flex-col items-end justify-center text-right">
                {userPos.speedMs != null && userPos.speedMs > 0 && (
                  <div>
                    <div className="text-base font-black text-white leading-none">{Math.round(userPos.speedMs * 3.6)}</div>
                    <div className="text-[8px] text-stone-400 uppercase">km/h</div>
                  </div>
                )}
                {offRouteM != null && offRouteM > 50 && (
                  <div className="mt-1 px-1.5 py-0.5 rounded bg-amber-500/20 border border-amber-500/40">
                    <div className="text-[8px] text-amber-300 font-bold uppercase">Off-route</div>
                    <div className="text-[9px] text-amber-200">{formatDistance(offRouteM)}</div>
                  </div>
                )}
              </div>
            </div>
            );
          })()}
        </div>
      )}

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
          // Per-kind chrome — colours, badge, title and subtitle so the
          // overlay reads correctly for road / trail / waypoint sections.
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
          const canRemove = isTrailSec && !!onRemoveTrailSection && !removing;
          const isPendingThis = isTrailSec && pendingRemoval?.trailId === trailId;
          const isRemovingThis = isTrailSec && removing?.trailId === trailId;
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

                {/* Trail-only: Remove from trip + inline confirm + progress */}
                {isTrailSec && canRemove && !isPendingThis && !isRemovingThis && (
                  <div className="px-2 pb-2">
                    <button
                      type="button"
                      onClick={() =>
                        setPendingRemoval({ trailId: trailId!, trailName })
                      }
                      data-testid="nav-remove-trail-button"
                      className="w-full py-1.5 rounded-md bg-stone-900/45 hover:bg-stone-900/65 border border-white/30 text-[11px] font-bold uppercase tracking-wider text-white flex items-center justify-center gap-1.5 transition-colors"
                    >
                      <svg viewBox="0 0 24 24" className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="3 6 5 6 21 6"/>
                        <path d="M19 6l-1.5 14a2 2 0 0 1-2 1.8H8.5a2 2 0 0 1-2-1.8L5 6"/>
                        <path d="M10 11v6M14 11v6"/>
                        <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>
                      </svg>
                      Remove from trip
                    </button>
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
          <SectionsList
            route={route}
            activeSection={activeSection}
            onSelect={setActiveSection}
            canRemoveTrails={!!onRemoveTrailSection && !removing}
            removingTrailId={removing?.trailId ?? null}
            onRequestRemoveTrail={(trailId, trailName) => {
              if (removing) return;
              // Open the section in the overlay so the rider sees the
              // confirm prompt in the same place whether they tapped
              // the row's remove button or the polyline.
              const trailSec = route.sections.find(
                (s) => s.kind === "trail" && s.trail.id === trailId,
              );
              if (trailSec) setActiveSection(trailSec.index);
              setPendingRemoval({ trailId, trailName });
            }}
          />
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

// Re-export GeoPoint for convenience
export type { GeoPoint };
