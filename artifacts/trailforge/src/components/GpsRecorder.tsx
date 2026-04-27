import { useState, useEffect, useRef, useCallback } from "react";
import { downloadGPX } from "@/lib/gpx";
import { addTrail } from "@/lib/supabase";
import { useCurrentUser } from "@/hooks/useCurrentUser";

interface RecordedPoint {
  lat: number;
  lng: number;
  ele: number | null;
  timestamp: number;
  speed: number | null;
}

type RecordState = "idle" | "recording" | "paused" | "editing" | "saving";

declare global {
  interface Window {
    L: typeof import("leaflet");
  }
}

interface Props {
  mapRef: React.MutableRefObject<import("leaflet").Map | null>;
  leafletLoaded: boolean;
}

function buildGPXFromPoints(points: RecordedPoint[], name: string): string {
  const trkpts = points
    .map((p) => {
      const time = new Date(p.timestamp).toISOString();
      const ele = p.ele != null ? `<ele>${p.ele.toFixed(1)}</ele>` : "";
      return `      <trkpt lat="${p.lat}" lon="${p.lng}">${ele}<time>${time}</time></trkpt>`;
    })
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="TrailForge" xmlns="http://www.topografix.com/GPX/1/1"
     xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
     xsi:schemaLocation="http://www.topografix.com/GPX/1/1 http://www.topografix.com/GPX/1/1/gpx.xsd">
  <metadata>
    <name>${name}</name>
    <time>${new Date(points[0]?.timestamp ?? Date.now()).toISOString()}</time>
  </metadata>
  <trk>
    <name>${name}</name>
    <trkseg>
${trkpts}
    </trkseg>
  </trk>
</gpx>`;
}

function calcDistanceKm(points: RecordedPoint[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    const R = 6371;
    const dLat = ((points[i].lat - points[i - 1].lat) * Math.PI) / 180;
    const dLon = ((points[i].lng - points[i - 1].lng) * Math.PI) / 180;
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos((points[i - 1].lat * Math.PI) / 180) *
        Math.cos((points[i].lat * Math.PI) / 180) *
        Math.sin(dLon / 2) ** 2;
    total += R * 2 * Math.asin(Math.sqrt(a));
  }
  return total;
}

function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  return `${m}:${String(sec).padStart(2, "0")}`;
}

export default function GpsRecorder({ mapRef, leafletLoaded }: Props) {
  const { userId, isSignedIn } = useCurrentUser();
  const [state, setState] = useState<RecordState>("idle");
  const [points, setPoints] = useState<RecordedPoint[]>([]);
  const [elapsed, setElapsed] = useState(0);
  const [currentSpeed, setCurrentSpeed] = useState<number | null>(null);
  const [gpsError, setGpsError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [accuracy, setAccuracy] = useState<number | null>(null);

  // Track editor state
  const [deleteFrom, setDeleteFrom] = useState(0);
  const [deleteTo, setDeleteTo] = useState(0);
  const [editedPoints, setEditedPoints] = useState<RecordedPoint[]>([]);
  const [editsApplied, setEditsApplied] = useState(0);

  // Save form
  const [trailName, setTrailName] = useState("");
  const [trailDifficulty, setTrailDifficulty] = useState(5);
  const [trailType, setTrailType] = useState<"BOAT" | "Green Lane">("BOAT");
  const [saveDone, setSaveDone] = useState(false);

  const watchIdRef = useRef<number | null>(null);
  const startTimeRef = useRef<number | null>(null);
  const pausedAtRef = useRef<number | null>(null);
  const totalPausedRef = useRef<number>(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Leaflet refs for recording track
  const trackPolylineRef = useRef<import("leaflet").Polyline | null>(null);
  const deletePolylineRef = useRef<import("leaflet").Polyline | null>(null);
  const locationMarkerRef = useRef<import("leaflet").Marker | null>(null);

  const drawTrack = useCallback((pts: RecordedPoint[]) => {
    if (!mapRef.current || !window.L || pts.length < 2) return;
    const L = window.L;
    if (trackPolylineRef.current) trackPolylineRef.current.remove();
    const latlngs = pts.map((p) => [p.lat, p.lng] as [number, number]);
    trackPolylineRef.current = L.polyline(latlngs, {
      color: "#ef4444",
      weight: 4,
      opacity: 0.9,
    }).addTo(mapRef.current);
  }, [mapRef]);

  const drawDeletePreview = useCallback((pts: RecordedPoint[], from: number, to: number) => {
    if (!mapRef.current || !window.L) return;
    const L = window.L;
    if (deletePolylineRef.current) { deletePolylineRef.current.remove(); deletePolylineRef.current = null; }
    if (from >= to) return;
    const section = pts.slice(from, to + 1).map((p) => [p.lat, p.lng] as [number, number]);
    if (section.length < 2) return;
    deletePolylineRef.current = L.polyline(section, {
      color: "#f87171",
      weight: 6,
      opacity: 0.7,
      dashArray: "8 6",
    }).addTo(mapRef.current);
  }, [mapRef]);

  const updateLocationMarker = useCallback((lat: number, lng: number) => {
    if (!mapRef.current || !window.L) return;
    const L = window.L;
    const icon = L.divIcon({
      html: `<div style="
        width:18px;height:18px;
        background:#ef4444;
        border:3px solid #fff;
        border-radius:50%;
        box-shadow:0 0 12px rgba(239,68,68,0.8);
        animation:gps-pulse 1.5s infinite;
      "></div>`,
      iconSize: [18, 18],
      iconAnchor: [9, 9],
      className: "",
    });
    if (locationMarkerRef.current) locationMarkerRef.current.remove();
    locationMarkerRef.current = L.marker([lat, lng], { icon }).addTo(mapRef.current);
    mapRef.current.panTo([lat, lng], { animate: true });
  }, [mapRef]);

  const clearMapLayers = useCallback(() => {
    trackPolylineRef.current?.remove(); trackPolylineRef.current = null;
    deletePolylineRef.current?.remove(); deletePolylineRef.current = null;
    locationMarkerRef.current?.remove(); locationMarkerRef.current = null;
  }, []);

  const startRecording = () => {
    if (!navigator.geolocation) {
      setGpsError("Geolocation is not supported by your browser.");
      return;
    }
    setGpsError(null);
    setSaveError(null);
    setSaveDone(false);
    setPoints([]);
    setElapsed(0);
    setCurrentSpeed(null);
    startTimeRef.current = Date.now();
    totalPausedRef.current = 0;
    setState("recording");

    watchIdRef.current = navigator.geolocation.watchPosition(
      (pos) => {
        const { latitude, longitude, altitude, speed, accuracy: acc } = pos.coords;
        setAccuracy(acc);
        setCurrentSpeed(speed != null ? speed * 3.6 : null);
        const newPoint: RecordedPoint = {
          lat: latitude,
          lng: longitude,
          ele: altitude,
          timestamp: pos.timestamp,
          speed: speed != null ? speed * 3.6 : null,
        };
        setPoints((prev) => {
          const updated = [...prev, newPoint];
          drawTrack(updated);
          return updated;
        });
        updateLocationMarker(latitude, longitude);
      },
      (err) => {
        setGpsError(err.message);
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 1000 }
    );

    timerRef.current = setInterval(() => {
      if (startTimeRef.current != null) {
        setElapsed(Date.now() - startTimeRef.current - totalPausedRef.current);
      }
    }, 1000);
  };

  const pauseRecording = () => {
    if (watchIdRef.current != null) {
      navigator.geolocation.clearWatch(watchIdRef.current);
      watchIdRef.current = null;
    }
    if (timerRef.current) clearInterval(timerRef.current);
    pausedAtRef.current = Date.now();
    setState("paused");
  };

  const resumeRecording = () => {
    if (pausedAtRef.current != null) {
      totalPausedRef.current += Date.now() - pausedAtRef.current;
      pausedAtRef.current = null;
    }
    setState("recording");
    watchIdRef.current = navigator.geolocation.watchPosition(
      (pos) => {
        const { latitude, longitude, altitude, speed, accuracy: acc } = pos.coords;
        setAccuracy(acc);
        setCurrentSpeed(speed != null ? speed * 3.6 : null);
        const newPoint: RecordedPoint = {
          lat: latitude, lng: longitude, ele: altitude,
          timestamp: pos.timestamp, speed: speed != null ? speed * 3.6 : null,
        };
        setPoints((prev) => {
          const updated = [...prev, newPoint];
          drawTrack(updated);
          return updated;
        });
        updateLocationMarker(latitude, longitude);
      },
      (err) => setGpsError(err.message),
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 1000 }
    );
    timerRef.current = setInterval(() => {
      if (startTimeRef.current != null) {
        setElapsed(Date.now() - startTimeRef.current - totalPausedRef.current);
      }
    }, 1000);
  };

  const stopRecording = () => {
    if (watchIdRef.current != null) {
      navigator.geolocation.clearWatch(watchIdRef.current);
      watchIdRef.current = null;
    }
    if (timerRef.current) clearInterval(timerRef.current);
    locationMarkerRef.current?.remove();
    locationMarkerRef.current = null;
    setEditedPoints([...points]);
    setDeleteFrom(0);
    setDeleteTo(0);
    setEditsApplied(0);
    setTrailName(`My Trail ${new Date().toLocaleDateString("en-GB")}`);
    setSaveDone(false);
    setState("editing");
    setTimeout(() => drawTrack(points), 100);
  };

  const discardRecording = () => {
    clearMapLayers();
    setPoints([]);
    setEditedPoints([]);
    setElapsed(0);
    setState("idle");
  };

  // Editor: apply a range deletion
  const applyDeletion = () => {
    if (deleteFrom >= deleteTo) return;
    const next = [...editedPoints.slice(0, deleteFrom), ...editedPoints.slice(deleteTo + 1)];
    setEditedPoints(next);
    setDeleteFrom(0);
    setDeleteTo(0);
    setEditsApplied((n) => n + 1);
    drawTrack(next);
    if (deletePolylineRef.current) { deletePolylineRef.current.remove(); deletePolylineRef.current = null; }
  };

  useEffect(() => {
    if (state === "editing" && editedPoints.length > 0) {
      drawDeletePreview(editedPoints, deleteFrom, deleteTo);
    }
  }, [deleteFrom, deleteTo, editedPoints, state, drawDeletePreview]);

  const handleDownloadGPX = () => {
    const name = trailName || "TrailForge Recording";
    const gpx = buildGPXFromPoints(editedPoints, name);
    const filename = `${name.replace(/\s+/g, "-")}.gpx`;
    downloadGPX(gpx, filename);
  };

  const handleSaveTrail = async () => {
    setSaveError(null);
    if (!isSignedIn) {
      setSaveError("Sign in required to publish a recorded trail.");
      return;
    }
    setState("saving");
    const name = trailName || "My Recorded Trail";
    const gpx = buildGPXFromPoints(editedPoints, name);
    const distKm = calcDistanceKm(editedPoints);
    const saved = await addTrail({
      user_id: null,
      owner_user_id: userId,
      name,
      type: "enduro",
      difficulty: trailDifficulty,
      distance_km: parseFloat(distKm.toFixed(2)),
      terrain: "Mixed",
      legal_status: trailType,
      gpx_data: gpx,
      is_public: true,
    });
    if (!saved) {
      setSaveError("Could not save your trail. Please try again.");
      setState("idle");
      return;
    }
    clearMapLayers();
    setPoints([]);
    setEditedPoints([]);
    setSaveDone(true);
    setState("idle");
  };

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (watchIdRef.current != null) navigator.geolocation.clearWatch(watchIdRef.current);
      if (timerRef.current) clearInterval(timerRef.current);
      clearMapLayers();
    };
  }, [clearMapLayers]);

  const recordedDistKm = calcDistanceKm(editedPoints);
  const editedDistKm = calcDistanceKm(editedPoints);
  const maxSpeed = points.reduce((m, p) => (p.speed != null && p.speed > m ? p.speed : m), 0);

  // --- IDLE ---
  if (state === "idle") {
    return (
      <div className="absolute bottom-14 left-0 right-0 z-[1000] px-4 pb-2">
        {saveDone && (
          <div className="mb-2 bg-green-900/80 border border-green-500/40 rounded-lg px-3 py-2 flex items-center gap-2">
            <svg viewBox="0 0 24 24" className="w-4 h-4 text-green-400 shrink-0" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="20 6 9 17 4 12"/></svg>
            <span className="text-xs text-green-300 font-medium">Trail saved to Supabase and Discover feed!</span>
          </div>
        )}
        {gpsError && (
          <div className="mb-2 bg-red-900/60 border border-red-500/40 rounded-lg px-3 py-2">
            <p className="text-xs text-red-300">{gpsError}</p>
          </div>
        )}
        {saveError && (
          <div className="mb-2 bg-amber-900/60 border border-amber-500/40 rounded-lg px-3 py-2">
            <p className="text-xs text-amber-200" data-testid="gps-save-error">{saveError}</p>
          </div>
        )}
        <button
          onClick={startRecording}
          className="w-full py-3.5 rounded-xl font-bold text-sm uppercase tracking-widest flex items-center justify-center gap-2.5 shadow-lg"
          style={{ background: "linear-gradient(135deg, #dc2626 0%, #ef4444 50%, #dc2626 100%)", color: "#fff" }}
        >
          <span className="w-3 h-3 rounded-full bg-white animate-pulse"></span>
          Start Recording
        </button>
      </div>
    );
  }

  // --- RECORDING / PAUSED ---
  if (state === "recording" || state === "paused") {
    const distKm = calcDistanceKm(points);
    return (
      <div className="absolute bottom-0 left-0 right-0 z-[1000] bg-gradient-to-t from-black/95 to-transparent pt-8">
        <div className="px-4 pb-4">
          {/* Live status */}
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              {state === "recording" ? (
                <span className="w-2.5 h-2.5 rounded-full bg-red-500 animate-pulse"></span>
              ) : (
                <span className="w-2.5 h-2.5 rounded-full bg-amber-500"></span>
              )}
              <span className="text-xs font-bold uppercase tracking-widest text-stone-300">
                {state === "recording" ? "Recording" : "Paused"}
              </span>
              {accuracy != null && (
                <span className="text-[10px] text-stone-600">±{Math.round(accuracy)}m</span>
              )}
            </div>
            <span className="text-sm font-mono font-bold text-amber-400">{formatDuration(elapsed)}</span>
          </div>

          {/* Stats row */}
          <div className="grid grid-cols-3 gap-2 mb-3">
            <div className="bg-[hsl(22,15%,10%)]/90 rounded-lg p-2 text-center">
              <div className="text-lg font-bold text-amber-400">{distKm.toFixed(2)}</div>
              <div className="text-[10px] text-stone-500 uppercase tracking-wider">km</div>
            </div>
            <div className="bg-[hsl(22,15%,10%)]/90 rounded-lg p-2 text-center">
              <div className="text-lg font-bold text-amber-400">
                {currentSpeed != null ? currentSpeed.toFixed(1) : "—"}
              </div>
              <div className="text-[10px] text-stone-500 uppercase tracking-wider">km/h</div>
            </div>
            <div className="bg-[hsl(22,15%,10%)]/90 rounded-lg p-2 text-center">
              <div className="text-lg font-bold text-amber-400">{points.length}</div>
              <div className="text-[10px] text-stone-500 uppercase tracking-wider">points</div>
            </div>
          </div>

          {gpsError && (
            <div className="mb-2 bg-red-900/60 border border-red-500/40 rounded-lg px-3 py-1.5">
              <p className="text-[10px] text-red-300">{gpsError}</p>
            </div>
          )}

          {/* Controls */}
          <div className="flex gap-2">
            {state === "recording" ? (
              <button
                onClick={pauseRecording}
                className="flex-1 py-3 rounded-xl font-bold text-sm border border-amber-500/50 text-amber-400 bg-amber-500/10 flex items-center justify-center gap-2"
              >
                <svg viewBox="0 0 24 24" className="w-4 h-4" fill="currentColor">
                  <rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/>
                </svg>
                Pause
              </button>
            ) : (
              <button
                onClick={resumeRecording}
                className="flex-1 py-3 rounded-xl font-bold text-sm border border-green-500/50 text-green-400 bg-green-500/10 flex items-center justify-center gap-2"
              >
                <svg viewBox="0 0 24 24" className="w-4 h-4" fill="currentColor">
                  <polygon points="5 3 19 12 5 21 5 3"/>
                </svg>
                Resume
              </button>
            )}
            <button
              onClick={stopRecording}
              disabled={points.length < 2}
              className="flex-1 py-3 rounded-xl font-bold text-sm flex items-center justify-center gap-2 disabled:opacity-40"
              style={{ background: points.length >= 2 ? "linear-gradient(135deg, #dc2626, #ef4444)" : "hsl(22,15%,16%)", color: "#fff" }}
            >
              <svg viewBox="0 0 24 24" className="w-4 h-4" fill="currentColor">
                <rect x="3" y="3" width="18" height="18" rx="2"/>
              </svg>
              Stop
            </button>
          </div>
        </div>
      </div>
    );
  }

  // --- EDITING ---
  if (state === "editing") {
    const canDelete = deleteFrom < deleteTo && deleteTo < editedPoints.length;
    const pointsToRemove = canDelete ? deleteTo - deleteFrom + 1 : 0;

    return (
      <div className="fixed inset-0 z-[2000] flex flex-col" style={{ background: "rgba(0,0,0,0.88)", backdropFilter: "blur(3px)" }}>
        <div
          className="flex flex-col mt-auto rounded-t-2xl overflow-hidden"
          style={{ background: "hsl(22,15%,9%)", maxHeight: "90vh" }}
        >
          {/* Handle */}
          <div className="flex justify-center pt-3 pb-1 shrink-0">
            <div className="w-10 h-1 rounded-full bg-stone-700"></div>
          </div>

          {/* Header */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-[hsl(30,12%,16%)] shrink-0">
            <div>
              <h2 className="text-base font-bold text-red-400 uppercase tracking-widest">Track Editor</h2>
              <p className="text-xs text-stone-500">
                {editedPoints.length} points · {editedDistKm.toFixed(2)} km
                {editsApplied > 0 && <span className="text-amber-400 ml-2">· {editsApplied} edit{editsApplied > 1 ? "s" : ""} applied</span>}
              </p>
            </div>
            <button
              onClick={discardRecording}
              className="text-xs text-stone-600 hover:text-red-400 transition-colors"
            >
              Discard
            </button>
          </div>

          <div className="overflow-y-auto flex-1 px-4 py-3 space-y-4">
            {/* Stats */}
            <div className="grid grid-cols-3 gap-2">
              <div className="bg-[hsl(22,15%,13%)] rounded-lg p-2 text-center">
                <div className="text-base font-bold text-amber-400">{formatDuration(elapsed)}</div>
                <div className="text-[10px] text-stone-500 uppercase tracking-wider">Duration</div>
              </div>
              <div className="bg-[hsl(22,15%,13%)] rounded-lg p-2 text-center">
                <div className="text-base font-bold text-amber-400">{editedDistKm.toFixed(2)}</div>
                <div className="text-[10px] text-stone-500 uppercase tracking-wider">km</div>
              </div>
              <div className="bg-[hsl(22,15%,13%)] rounded-lg p-2 text-center">
                <div className="text-base font-bold text-amber-400">{maxSpeed.toFixed(0)}</div>
                <div className="text-[10px] text-stone-500 uppercase tracking-wider">Max km/h</div>
              </div>
            </div>

            {/* Remove Wrong Turn */}
            <div className="bg-[hsl(22,15%,12%)] border border-[hsl(30,12%,20%)] rounded-xl p-3">
              <div className="flex items-center gap-2 mb-3">
                <svg viewBox="0 0 24 24" className="w-4 h-4 text-red-400 shrink-0" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M3 3l18 18M10.5 10.677A2 2 0 0 0 8 12.5V17h8v-4.5a2 2 0 0 0-2-2h-.5"/>
                  <path d="M12 3a4 4 0 0 1 4 4c0 1.5-.83 2.8-2 3.46"/>
                </svg>
                <h3 className="text-xs font-bold text-stone-200 uppercase tracking-wider">Remove Wrong Turn</h3>
              </div>

              <p className="text-[11px] text-stone-500 mb-3">
                Select the point range of the wrong section. Points are numbered 1 to {editedPoints.length}.
              </p>

              <div className="grid grid-cols-2 gap-3 mb-3">
                <div>
                  <label className="text-[10px] text-stone-500 uppercase tracking-wider block mb-1">From point</label>
                  <div className="flex items-center gap-1">
                    <button
                      onClick={() => setDeleteFrom((n) => Math.max(0, n - 1))}
                      className="w-8 h-8 rounded-lg bg-stone-800 text-stone-300 flex items-center justify-center text-lg font-bold hover:bg-stone-700 transition-colors"
                    >−</button>
                    <div className="flex-1 text-center text-sm font-bold text-amber-400 bg-[hsl(22,15%,16%)] rounded-lg py-1.5">
                      {deleteFrom + 1}
                    </div>
                    <button
                      onClick={() => setDeleteFrom((n) => Math.min(editedPoints.length - 2, n + 1))}
                      className="w-8 h-8 rounded-lg bg-stone-800 text-stone-300 flex items-center justify-center text-lg font-bold hover:bg-stone-700 transition-colors"
                    >+</button>
                  </div>
                </div>
                <div>
                  <label className="text-[10px] text-stone-500 uppercase tracking-wider block mb-1">To point</label>
                  <div className="flex items-center gap-1">
                    <button
                      onClick={() => setDeleteTo((n) => Math.max(deleteFrom + 1, n - 1))}
                      className="w-8 h-8 rounded-lg bg-stone-800 text-stone-300 flex items-center justify-center text-lg font-bold hover:bg-stone-700 transition-colors"
                    >−</button>
                    <div className="flex-1 text-center text-sm font-bold text-amber-400 bg-[hsl(22,15%,16%)] rounded-lg py-1.5">
                      {deleteTo + 1}
                    </div>
                    <button
                      onClick={() => setDeleteTo((n) => Math.min(editedPoints.length - 1, n + 1))}
                      className="w-8 h-8 rounded-lg bg-stone-800 text-stone-300 flex items-center justify-center text-lg font-bold hover:bg-stone-700 transition-colors"
                    >+</button>
                  </div>
                </div>
              </div>

              {canDelete && (
                <p className="text-[11px] text-red-400 mb-2 flex items-center gap-1">
                  <span className="w-2 h-2 rounded-full bg-red-400 inline-block"></span>
                  {pointsToRemove} point{pointsToRemove > 1 ? "s" : ""} will be removed — shown dashed on map
                </p>
              )}

              <button
                onClick={applyDeletion}
                disabled={!canDelete}
                className="w-full py-2.5 rounded-lg text-xs font-bold uppercase tracking-wider border transition-all flex items-center justify-center gap-2 disabled:opacity-30"
                style={{
                  background: canDelete ? "hsl(0,70%,25%)" : "transparent",
                  borderColor: canDelete ? "#ef4444" : "hsl(30,12%,22%)",
                  color: canDelete ? "#fca5a5" : "#6b7280",
                }}
              >
                <svg viewBox="0 0 24 24" className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2">
                  <polyline points="3 6 5 6 21 6"/>
                  <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>
                </svg>
                Remove Section
              </button>
            </div>

            {/* Trail Details for saving */}
            <div className="bg-[hsl(22,15%,12%)] border border-[hsl(30,12%,20%)] rounded-xl p-3 space-y-3">
              <h3 className="text-xs font-bold text-stone-200 uppercase tracking-wider">Trail Details</h3>
              <div>
                <label className="text-[10px] text-stone-500 uppercase tracking-wider block mb-1">Trail Name</label>
                <input
                  type="text"
                  value={trailName}
                  onChange={(e) => setTrailName(e.target.value)}
                  className="w-full bg-[hsl(22,15%,16%)] border border-[hsl(30,12%,22%)] rounded-lg px-3 py-2 text-sm text-stone-200 placeholder:text-stone-600 focus:outline-none focus:border-amber-500/60 transition-colors"
                  placeholder="Name your trail..."
                />
              </div>
              <div>
                <label className="text-[10px] text-stone-500 uppercase tracking-wider block mb-2">
                  Difficulty: {trailDifficulty}
                </label>
                <div className="flex gap-1.5">
                  {Array.from({ length: 10 }, (_, i) => i + 1).map((d) => {
                    const colors: Record<number, string> = {
                      1: "#4ade80", 2: "#86efac", 3: "#a3e635", 4: "#bef264", 5: "#fbbf24",
                      6: "#fb923c", 7: "#f97316", 8: "#ef4444", 9: "#dc2626", 10: "#7f1d1d",
                    };
                    return (
                      <button
                        key={d}
                        onClick={() => setTrailDifficulty(d)}
                        className="flex-1 aspect-square rounded text-xs font-bold transition-all"
                        style={{
                          backgroundColor: trailDifficulty === d ? colors[d] : "hsl(22,15%,18%)",
                          color: trailDifficulty === d ? "#000" : colors[d],
                          border: `1px solid ${colors[d]}40`,
                          transform: trailDifficulty === d ? "scale(1.1)" : "scale(1)",
                        }}
                      >
                        {d}
                      </button>
                    );
                  })}
                </div>
              </div>
              <div>
                <label className="text-[10px] text-stone-500 uppercase tracking-wider block mb-1">Trail Type</label>
                <div className="flex gap-2">
                  {(["BOAT", "Green Lane"] as const).map((t) => (
                    <button
                      key={t}
                      onClick={() => setTrailType(t)}
                      className={`flex-1 py-2 rounded-lg text-xs font-semibold border transition-all ${
                        trailType === t
                          ? t === "BOAT" ? "bg-amber-500 border-amber-400 text-stone-900" : "bg-green-600 border-green-500 text-white"
                          : "bg-transparent border-stone-700 text-stone-400"
                      }`}
                    >
                      {t}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </div>

          {/* Action Buttons */}
          <div className="px-4 pb-6 pt-3 space-y-2 border-t border-[hsl(30,12%,16%)] shrink-0">
            <button
              onClick={handleSaveTrail}
              disabled={editedPoints.length < 2 || !trailName.trim()}
              className="w-full py-3.5 rounded-xl font-bold text-sm uppercase tracking-widest flex items-center justify-center gap-2 disabled:opacity-40"
              style={{ background: "linear-gradient(135deg, #d4870c 0%, #f0a832 50%, #d4870c 100%)", color: "#1a0e05" }}
            >
              <svg viewBox="0 0 24 24" className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2.5">
                <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/>
                <polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/>
              </svg>
              Save Trail to Community
            </button>

            <button
              onClick={handleDownloadGPX}
              disabled={editedPoints.length < 2}
              className="w-full py-3 rounded-xl font-bold text-sm uppercase tracking-widest flex items-center justify-center gap-2 border border-[hsl(30,12%,24%)] text-stone-300 hover:border-amber-500/40 hover:text-amber-300 transition-colors disabled:opacity-40"
            >
              <svg viewBox="0 0 24 24" className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2.5">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                <polyline points="7 10 12 15 17 10"/>
                <line x1="12" y1="15" x2="12" y2="3"/>
              </svg>
              Download GPX Only
            </button>
          </div>
        </div>
      </div>
    );
  }

  // --- SAVING ---
  return (
    <div className="absolute inset-0 z-[2000] flex items-center justify-center" style={{ background: "rgba(0,0,0,0.8)" }}>
      <div className="text-center">
        <div className="w-10 h-10 border-2 border-amber-500/30 border-t-amber-500 rounded-full animate-spin mx-auto mb-3"></div>
        <p className="text-sm text-stone-300 font-medium">Saving trail to Supabase...</p>
      </div>
    </div>
  );
}
