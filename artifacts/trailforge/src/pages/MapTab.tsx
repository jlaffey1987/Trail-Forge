import { useEffect, useRef, useState } from "react";

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

export default function MapTab() {
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<import("leaflet").Map | null>(null);
  const markersRef = useRef<import("leaflet").Marker[]>([]);
  const polylineRef = useRef<import("leaflet").Polyline | null>(null);
  const [drawMode, setDrawMode] = useState(false);
  const [waypoints, setWaypoints] = useState<Waypoint[]>([]);
  const [totalKm, setTotalKm] = useState(0);
  const [leafletLoaded, setLeafletLoaded] = useState(false);
  const drawModeRef = useRef(drawMode);
  const waypointsRef = useRef(waypoints);

  drawModeRef.current = drawMode;
  waypointsRef.current = waypoints;

  useEffect(() => {
    if (typeof window !== "undefined" && !document.getElementById("leaflet-script")) {
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css";
      document.head.appendChild(link);

      const script = document.createElement("script");
      script.id = "leaflet-script";
      script.src = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js";
      script.onload = () => setLeafletLoaded(true);
      document.head.appendChild(script);
    } else if (window.L) {
      setLeafletLoaded(true);
    }
  }, []);

  useEffect(() => {
    if (!leafletLoaded || !mapContainerRef.current || mapRef.current) return;

    const L = window.L;

    const map = L.map(mapContainerRef.current, {
      center: [53.2, -1.8],
      zoom: 10,
      zoomControl: true,
    });

    L.tileLayer(
      "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
      {
        attribution: "Tiles © Esri — Source: Esri, i-cubed, USDA, USGS, AEX, GeoEye, Getmapping, Aerogrid, IGN, IGP, UPR-EGP",
        maxZoom: 19,
      }
    ).addTo(map);

    map.on("click", (e: import("leaflet").LeafletMouseEvent) => {
      if (!drawModeRef.current) return;

      const L = window.L;
      const { lat, lng } = e.latlng;
      const id = Date.now();

      const svgMarker = L.divIcon({
        html: `<div style="
          width:20px;height:20px;
          background:#d4870c;
          border:2.5px solid #fff;
          border-radius:50% 50% 50% 0;
          transform:rotate(-45deg);
          box-shadow:0 2px 8px rgba(0,0,0,0.6);
        "></div>`,
        iconSize: [20, 20],
        iconAnchor: [10, 20],
        className: "",
      });

      const marker = L.marker([lat, lng], { icon: svgMarker }).addTo(map);
      markersRef.current.push(marker);

      const newWaypoints = [...waypointsRef.current, { id, lat, lng }];
      setWaypoints(newWaypoints);
      waypointsRef.current = newWaypoints;

      if (polylineRef.current) {
        polylineRef.current.remove();
      }

      if (newWaypoints.length >= 2) {
        const latlngs = newWaypoints.map((wp) => [wp.lat, wp.lng] as [number, number]);
        polylineRef.current = L.polyline(latlngs, {
          color: "#f0a832",
          weight: 3.5,
          opacity: 0.85,
          dashArray: undefined,
        }).addTo(map);

        let dist = 0;
        for (let i = 1; i < newWaypoints.length; i++) {
          dist += L.latLng(newWaypoints[i - 1].lat, newWaypoints[i - 1].lng).distanceTo(
            L.latLng(newWaypoints[i].lat, newWaypoints[i].lng)
          );
        }
        setTotalKm(dist / 1000);
      }
    });

    mapRef.current = map;
  }, [leafletLoaded]);

  const clearWaypoints = () => {
    markersRef.current.forEach((m) => m.remove());
    markersRef.current = [];
    if (polylineRef.current) {
      polylineRef.current.remove();
      polylineRef.current = null;
    }
    setWaypoints([]);
    setTotalKm(0);
  };

  const undoWaypoint = () => {
    if (markersRef.current.length === 0) return;
    const lastMarker = markersRef.current.pop();
    lastMarker?.remove();

    const newWaypoints = waypointsRef.current.slice(0, -1);
    setWaypoints(newWaypoints);
    waypointsRef.current = newWaypoints;

    if (polylineRef.current) {
      polylineRef.current.remove();
      polylineRef.current = null;
    }

    if (newWaypoints.length >= 2 && mapRef.current) {
      const L = window.L;
      const latlngs = newWaypoints.map((wp) => [wp.lat, wp.lng] as [number, number]);
      polylineRef.current = L.polyline(latlngs, {
        color: "#f0a832",
        weight: 3.5,
        opacity: 0.85,
      }).addTo(mapRef.current);

      let dist = 0;
      for (let i = 1; i < newWaypoints.length; i++) {
        dist += L.latLng(newWaypoints[i - 1].lat, newWaypoints[i - 1].lng).distanceTo(
          L.latLng(newWaypoints[i].lat, newWaypoints[i].lng)
        );
      }
      setTotalKm(dist / 1000);
    } else {
      setTotalKm(0);
    }
  };

  return (
    <div className="flex flex-col h-full relative">
      {/* Map Controls Bar */}
      <div className="absolute top-0 left-0 right-0 z-[1000] flex items-center justify-between px-3 py-2 bg-gradient-to-b from-black/60 to-transparent pointer-events-none">
        <div className="pointer-events-auto flex items-center gap-2">
          <button
            onClick={() => setDrawMode((d) => !d)}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold uppercase tracking-wider border transition-all ${
              drawMode
                ? "bg-amber-500 border-amber-400 text-stone-900 shadow-lg shadow-amber-500/30"
                : "bg-black/50 border-stone-600/60 text-stone-300 backdrop-blur"
            }`}
          >
            <svg viewBox="0 0 24 24" className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2.5">
              <path d="M12 20h9" />
              <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
            </svg>
            {drawMode ? "Drawing" : "Draw"}
          </button>

          {waypoints.length > 0 && (
            <>
              <button
                onClick={undoWaypoint}
                className="p-1.5 rounded-lg bg-black/50 border border-stone-600/60 text-stone-300 backdrop-blur pointer-events-auto hover:bg-stone-700/60 transition-colors"
              >
                <svg viewBox="0 0 24 24" className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2">
                  <polyline points="9 14 4 9 9 4" />
                  <path d="M20 20v-7a4 4 0 0 0-4-4H4" />
                </svg>
              </button>
              <button
                onClick={clearWaypoints}
                className="p-1.5 rounded-lg bg-black/50 border border-red-600/50 text-red-400 backdrop-blur pointer-events-auto hover:bg-red-900/30 transition-colors"
              >
                <svg viewBox="0 0 24 24" className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2">
                  <polyline points="3 6 5 6 21 6" />
                  <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
                </svg>
              </button>
            </>
          )}
        </div>

        <div className="pointer-events-auto">
          <button className="p-1.5 rounded-lg bg-black/50 border border-stone-600/60 text-stone-300 backdrop-blur">
            <svg viewBox="0 0 24 24" className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="10" />
              <line x1="2" y1="12" x2="22" y2="12" />
              <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
            </svg>
          </button>
        </div>
      </div>

      {/* Draw Mode Hint */}
      {drawMode && (
        <div className="absolute top-12 left-1/2 -translate-x-1/2 z-[1000] bg-amber-500/90 text-stone-900 text-xs font-bold px-3 py-1.5 rounded-full shadow-lg pointer-events-none">
          Tap map to add waypoints
        </div>
      )}

      {/* Map */}
      <div ref={mapContainerRef} className="flex-1" style={{ cursor: drawMode ? "crosshair" : "grab" }}>
        {!leafletLoaded && (
          <div className="w-full h-full flex items-center justify-center bg-[hsl(22,15%,8%)]">
            <div className="text-center">
              <div className="w-8 h-8 border-2 border-amber-500/30 border-t-amber-500 rounded-full animate-spin mx-auto mb-3"></div>
              <p className="text-sm text-stone-400">Loading satellite map...</p>
            </div>
          </div>
        )}
      </div>

      {/* Stats Bar */}
      <div className="absolute bottom-0 left-0 right-0 z-[1000] bg-gradient-to-t from-black/80 to-transparent pt-6">
        <div className="flex items-center justify-between px-4 pb-2">
          <div className="flex items-center gap-4">
            <div>
              <div className="text-xs text-stone-500 uppercase tracking-wider">Distance</div>
              <div className="text-base font-bold text-amber-400">
                {totalKm > 0 ? `${totalKm.toFixed(1)} km` : "0.0 km"}
              </div>
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
                  <div className="text-base font-bold text-amber-400">
                    {Math.round(totalKm / 15 * 60)}m
                  </div>
                </div>
              </>
            )}
          </div>

          {waypoints.length >= 2 && (
            <button
              className="px-3 py-2 rounded-lg text-xs font-bold uppercase tracking-wider text-stone-900"
              style={{ background: "linear-gradient(135deg, #d4870c, #f0a832)" }}
            >
              Save Trail
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
