import { useEffect, useRef, useState } from "react";
import {
  validateGpxString,
  type GpxValidation,
  type Waypoint,
} from "@/lib/gpx";
import SaveTrailForm from "./SaveTrailForm";
import { addTrail } from "@/lib/supabase";
import { useLeaflet } from "@/lib/useLeaflet";

declare global {
  interface Window {
    L: typeof import("leaflet");
  }
}

interface Props {
  open: boolean;
  onClose: () => void;
  onSaved?: () => void;
}

type Step = "pick" | "preview" | "save";

export default function UploadGpxFlow({ open, onClose, onSaved }: Props) {
  const [step, setStep] = useState<Step>("pick");
  const [filename, setFilename] = useState<string>("");
  const [gpxText, setGpxText] = useState<string>("");
  const [validation, setValidation] = useState<GpxValidation | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);

  // Reset state every time the modal is re-opened.
  useEffect(() => {
    if (open) {
      setStep("pick");
      setFilename("");
      setGpxText("");
      setValidation(null);
      setError(null);
      setDragOver(false);
    }
  }, [open]);

  const handleFile = async (file: File) => {
    setError(null);
    if (!/\.gpx$/i.test(file.name)) {
      setError("Please choose a .gpx file");
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      setError("GPX file is too large (max 10 MB)");
      return;
    }
    const text = await file.text();
    const result = validateGpxString(text);
    if (!result.ok) {
      setError(result.error ?? "Could not parse GPX file");
      return;
    }
    setFilename(file.name);
    setGpxText(text);
    setValidation(result);
    setStep("preview");
  };

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[2800] flex flex-col"
      style={{ background: "rgba(0,0,0,0.85)", backdropFilter: "blur(3px)" }}
      role="dialog"
      aria-modal="true"
      data-testid="upload-gpx-flow"
    >
      {step === "pick" && (
        <div
          className="flex flex-col mt-auto rounded-t-2xl overflow-hidden"
          style={{ background: "hsl(22,15%,9%)", maxHeight: "92vh" }}
        >
          <div className="flex justify-center pt-3 pb-1 shrink-0">
            <div className="w-10 h-1 rounded-full bg-stone-700"></div>
          </div>
          <div className="flex items-center justify-between px-4 py-3 border-b border-[hsl(30,12%,16%)] shrink-0">
            <h2 className="text-base font-bold text-amber-400 uppercase tracking-widest">
              Upload GPX File
            </h2>
            <button
              onClick={onClose}
              className="text-xs text-stone-500 hover:text-red-400"
              data-testid="upload-gpx-cancel"
            >
              Cancel
            </button>
          </div>
          <div className="px-4 py-6">
            <DropZone
              dragOver={dragOver}
              onDragOver={(over) => setDragOver(over)}
              onPick={handleFile}
              error={error}
            />
            <p className="text-[11px] text-stone-500 mt-3 text-center">
              We accept .gpx files containing tracks (`&lt;trk&gt;`) or routes (`&lt;rte&gt;`).
            </p>
          </div>
        </div>
      )}

      {step === "preview" && validation && (
        <div
          className="flex flex-col mt-auto rounded-t-2xl overflow-hidden"
          style={{ background: "hsl(22,15%,9%)", maxHeight: "92vh" }}
        >
          <div className="flex justify-center pt-3 pb-1 shrink-0">
            <div className="w-10 h-1 rounded-full bg-stone-700"></div>
          </div>
          <div className="flex items-center justify-between px-4 py-3 border-b border-[hsl(30,12%,16%)] shrink-0">
            <div>
              <h2 className="text-base font-bold text-amber-400 uppercase tracking-widest">
                Preview GPX
              </h2>
              <p className="text-[11px] text-stone-500 mt-0.5">{filename}</p>
            </div>
            <button
              onClick={onClose}
              className="text-xs text-stone-500 hover:text-red-400"
              data-testid="upload-gpx-preview-cancel"
            >
              Cancel
            </button>
          </div>

          <div className="overflow-y-auto px-4 py-3 space-y-3">
            <PreviewMap waypoints={validation.waypoints} />

            <div className="grid grid-cols-3 gap-2">
              <Stat label="Points" value={String(validation.pointCount)} />
              <Stat label="Distance" value={`${validation.distanceKm.toFixed(2)} km`} />
              <Stat
                label="Tracks/Routes"
                value={`${validation.trackCount}/${validation.routeCount}`}
              />
            </div>

            {validation.name && (
              <div className="bg-[hsl(22,15%,12%)] border border-[hsl(30,12%,20%)] rounded-lg px-3 py-2">
                <div className="text-[10px] uppercase tracking-wider text-stone-500">Detected name</div>
                <div className="text-sm text-stone-200">{validation.name}</div>
              </div>
            )}
          </div>

          <div className="border-t border-[hsl(30,12%,16%)] p-3 flex gap-2 shrink-0">
            <button
              onClick={() => setStep("pick")}
              className="flex-1 py-3 rounded-xl text-sm font-bold uppercase tracking-wider text-stone-400 border border-stone-700"
              data-testid="upload-gpx-back"
            >
              Choose Different File
            </button>
            <button
              onClick={() => setStep("save")}
              className="flex-1 py-3 rounded-xl text-sm font-bold uppercase tracking-wider text-stone-900"
              style={{ background: "linear-gradient(135deg, #d4870c, #f0a832)" }}
              data-testid="upload-gpx-continue"
            >
              Continue
            </button>
          </div>
        </div>
      )}

      <SaveTrailForm
        open={step === "save" && validation != null}
        title="Save Uploaded Trail"
        waypoints={validation?.waypoints ?? []}
        gpxData={gpxText}
        prefill={{
          name: validation?.name ?? filename.replace(/\.gpx$/i, ""),
          distanceKm: validation?.distanceKm,
        }}
        onCancel={() => setStep("preview")}
        onSave={async ({ input, selectedGroupIds }) => {
          // Pass selectedGroupIds straight through — the server creates the
          // trail row and the matching trail_shares rows in one handler so
          // a failed share can never leave behind an orphan private trail.
          const trail = await addTrail({ ...input, group_ids: selectedGroupIds });
          if (!trail) {
            return { ok: false, error: "Could not save trail. Are you signed in?" };
          }
          onSaved?.();
          onClose();
          return { ok: true };
        }}
      />
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-[hsl(22,15%,12%)] border border-[hsl(30,12%,20%)] rounded-lg px-2 py-2 text-center">
      <div className="text-sm font-bold text-amber-400">{value}</div>
      <div className="text-[9px] uppercase tracking-wider text-stone-500 mt-0.5">{label}</div>
    </div>
  );
}

interface DropZoneProps {
  dragOver: boolean;
  onDragOver: (v: boolean) => void;
  onPick: (file: File) => void;
  error: string | null;
}

function DropZone({ dragOver, onDragOver, onPick, error }: DropZoneProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <>
      <div
        onDragOver={(e) => {
          e.preventDefault();
          onDragOver(true);
        }}
        onDragLeave={() => onDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          onDragOver(false);
          const file = e.dataTransfer.files?.[0];
          if (file) void onPick(file);
        }}
        onClick={() => inputRef.current?.click()}
        className={`rounded-xl border-2 border-dashed p-6 text-center cursor-pointer transition-all ${
          dragOver
            ? "border-amber-500 bg-amber-500/10"
            : "border-stone-700 hover:border-amber-500/60 bg-[hsl(22,15%,12%)]"
        }`}
        data-testid="upload-gpx-dropzone"
      >
        <svg viewBox="0 0 24 24" className="w-10 h-10 mx-auto text-stone-500 mb-2" fill="none" stroke="currentColor" strokeWidth="1.5">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
          <polyline points="17 8 12 3 7 8" />
          <line x1="12" y1="3" x2="12" y2="15" />
        </svg>
        <div className="text-sm font-bold text-stone-200">
          Drop your GPX file here
        </div>
        <div className="text-xs text-stone-500 mt-0.5">or tap to browse</div>
        {/* The input is visually hidden but kept in the layout. Tailwind's
         * `hidden` class (display: none) is unreliable here: on iOS Safari,
         * calling `.click()` on a `display: none` file input often fails to
         * open the OS picker at all. Position-absolute + opacity-0 keeps it
         * rendered so the programmatic click works on every platform. */}
        <input
          ref={inputRef}
          type="file"
          accept=".gpx,application/gpx+xml,application/xml,text/xml"
          className="absolute w-px h-px opacity-0 pointer-events-none"
          tabIndex={-1}
          aria-hidden="true"
          data-testid="upload-gpx-file-input"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void onPick(file);
            e.target.value = "";
          }}
        />
      </div>
      {error && (
        <div className="mt-3 bg-red-900/40 border border-red-500/40 rounded-lg px-3 py-2">
          <p className="text-xs text-red-300" data-testid="upload-gpx-error">{error}</p>
        </div>
      )}
    </>
  );
}

interface PreviewMapProps {
  waypoints: Waypoint[];
}

function PreviewMap({ waypoints }: PreviewMapProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<import("leaflet").Map | null>(null);
  // Self-load Leaflet if it isn't already on the page. Required because the
  // upload flow can be opened from My Trails before the user has ever visited
  // the Map tab — without this the preview container would stay blank.
  const leafletReady = useLeaflet();

  useEffect(() => {
    if (!containerRef.current || waypoints.length < 2 || !leafletReady || !window.L) return;
    const L = window.L;
    if (!mapRef.current) {
      mapRef.current = L.map(containerRef.current, {
        zoomControl: false,
        attributionControl: false,
        dragging: false,
        scrollWheelZoom: false,
        doubleClickZoom: false,
        touchZoom: false,
      });
      L.tileLayer(
        "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
        { maxZoom: 19 },
      ).addTo(mapRef.current);
    }
    const map = mapRef.current;
    map.eachLayer((layer) => {
      if (layer instanceof L.Polyline) layer.remove();
    });
    const latlngs = waypoints.map((w) => [w.lat, w.lon] as [number, number]);
    const polyline = L.polyline(latlngs, { color: "#f0a832", weight: 3.5, opacity: 0.9 }).addTo(map);
    try {
      map.fitBounds(polyline.getBounds(), { padding: [16, 16] });
    } catch {
      // ignore
    }
    setTimeout(() => map.invalidateSize(), 60);
  }, [waypoints, leafletReady]);

  // Cleanup on unmount.
  useEffect(() => {
    return () => {
      mapRef.current?.remove();
      mapRef.current = null;
    };
  }, []);

  if (waypoints.length < 2) {
    return (
      <div className="h-44 rounded-lg bg-[hsl(22,15%,12%)] border border-[hsl(30,12%,20%)] flex items-center justify-center">
        <p className="text-xs text-stone-500">Not enough points to preview</p>
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className="h-44 rounded-lg overflow-hidden border border-[hsl(30,12%,20%)]"
      data-testid="upload-gpx-preview-map"
    />
  );
}
