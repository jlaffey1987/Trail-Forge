import { useState, useRef } from "react";
import { parseGPX } from "@/lib/gpx";

export interface MapLayer {
  id: string;
  name: string;
  color: string;
  visible: boolean;
  polylines: [number, number][][]; // array of segments, each is array of [lat, lng]
  source: "tet" | "act" | "import";
  km?: number;
}

export type BaseMap = "satellite" | "topo" | "os-outdoor";

const BASE_MAPS: { key: BaseMap; label: string; desc: string; icon: string }[] = [
  {
    key: "satellite",
    label: "Satellite",
    desc: "Esri World Imagery",
    icon: "🛰",
  },
  {
    key: "topo",
    label: "OS Topo",
    desc: "OpenTopoMap — contours & terrain",
    icon: "🗻",
  },
  {
    key: "os-outdoor",
    label: "OS Outdoor",
    desc: "Ordnance Survey outdoor (API key required)",
    icon: "🟢",
  },
];

const LAYER_COLORS = ["#3b82f6", "#f97316", "#a855f7", "#ec4899", "#10b981", "#f59e0b", "#06b6d4"];

function calcLayerKm(polylines: [number, number][][]): number {
  let total = 0;
  for (const seg of polylines) {
    for (let i = 1; i < seg.length; i++) {
      const R = 6371;
      const dLat = ((seg[i][0] - seg[i - 1][0]) * Math.PI) / 180;
      const dLon = ((seg[i][1] - seg[i - 1][1]) * Math.PI) / 180;
      const a =
        Math.sin(dLat / 2) ** 2 +
        Math.cos((seg[i - 1][0] * Math.PI) / 180) *
          Math.cos((seg[i][0] * Math.PI) / 180) *
          Math.sin(dLon / 2) ** 2;
      total += R * 2 * Math.asin(Math.sqrt(a));
    }
  }
  return total;
}

async function fetchTETfromOverpass(): Promise<[number, number][][]> {
  // UK bounding box, query for Trans Euro Trail route relations
  const query = `[out:json][timeout:60][bbox:49.5,-8.5,61.0,2.0];(relation["name"~"Trans Euro Trail","i"]["type"="route"];relation["operator"~"Trans Euro Trail","i"]["type"="route"];relation["network"~"TET","i"];);out geom;`;
  const url = `https://overpass-api.de/api/interpreter?data=${encodeURIComponent(query)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Overpass error ${res.status}`);
  const json = await res.json();

  const segments: [number, number][][] = [];
  for (const el of json.elements ?? []) {
    if (el.type === "relation") {
      for (const member of el.members ?? []) {
        if (member.type === "way" && Array.isArray(member.geometry) && member.geometry.length >= 2) {
          segments.push(member.geometry.map((pt: { lat: number; lon: number }) => [pt.lat, pt.lon]));
        }
      }
    }
    if (el.type === "way" && Array.isArray(el.geometry) && el.geometry.length >= 2) {
      segments.push(el.geometry.map((pt: { lat: number; lon: number }) => [pt.lat, pt.lon]));
    }
  }
  return segments;
}

async function fetchACTfromOverpass(): Promise<[number, number][][]> {
  const query = `[out:json][timeout:60][bbox:49.5,-8.5,61.0,2.0];(relation["name"~"Adventure Country Tracks","i"]["type"="route"];relation["name"~"ACT UK","i"]["type"="route"];);out geom;`;
  const url = `https://overpass-api.de/api/interpreter?data=${encodeURIComponent(query)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Overpass error ${res.status}`);
  const json = await res.json();

  const segments: [number, number][][] = [];
  for (const el of json.elements ?? []) {
    if (el.type === "relation") {
      for (const member of el.members ?? []) {
        if (member.type === "way" && Array.isArray(member.geometry) && member.geometry.length >= 2) {
          segments.push(member.geometry.map((pt: { lat: number; lon: number }) => [pt.lat, pt.lon]));
        }
      }
    }
  }
  return segments;
}

function gpxToPolylines(gpxString: string): [number, number][][] {
  const waypoints = parseGPX(gpxString);
  if (waypoints.length === 0) return [];
  return [waypoints.map((w) => [w.lat, w.lon] as [number, number])];
}

interface Props {
  onClose: () => void;
  layers: MapLayer[];
  onLayersChange: (layers: MapLayer[]) => void;
  baseMap: BaseMap;
  onBaseMapChange: (bm: BaseMap) => void;
  osApiKey: string;
  onOsApiKeyChange: (key: string) => void;
}

export default function LayersPanel({
  onClose,
  layers,
  onLayersChange,
  baseMap,
  onBaseMapChange,
  osApiKey,
  onOsApiKeyChange,
}: Props) {
  const [tetLoading, setTetLoading] = useState(false);
  const [tetError, setTetError] = useState<string | null>(null);
  const [actLoading, setActLoading] = useState(false);
  const [actError, setActError] = useState<string | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [showOsKey, setShowOsKey] = useState(false);
  const [osKeyInput, setOsKeyInput] = useState(osApiKey);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const colorIndex = useRef(0);
  const nextColor = () => {
    const c = LAYER_COLORS[colorIndex.current % LAYER_COLORS.length];
    colorIndex.current++;
    return c;
  };

  const tetLayer = layers.find((l) => l.source === "tet");
  const actLayer = layers.find((l) => l.source === "act");

  const toggleLayer = (id: string) => {
    onLayersChange(layers.map((l) => (l.id === id ? { ...l, visible: !l.visible } : l)));
  };

  const removeLayer = (id: string) => {
    onLayersChange(layers.filter((l) => l.id !== id));
  };

  const loadTET = async () => {
    if (tetLayer) { toggleLayer(tetLayer.id); return; }
    setTetLoading(true);
    setTetError(null);
    try {
      const segments = await fetchTETfromOverpass();
      if (segments.length === 0) {
        setTetError("No TET data found in OpenStreetMap for the UK. Try importing your own TET GPX file below.");
      } else {
        const km = calcLayerKm(segments);
        const layer: MapLayer = {
          id: "tet",
          name: "Trans Euro Trail UK",
          color: "#3b82f6",
          visible: true,
          polylines: segments,
          source: "tet",
          km: parseFloat(km.toFixed(1)),
        };
        onLayersChange([...layers.filter((l) => l.source !== "tet"), layer]);
      }
    } catch (e) {
      setTetError("Could not reach OpenStreetMap server. Try importing your downloaded TET GPX instead.");
    }
    setTetLoading(false);
  };

  const loadACT = async () => {
    if (actLayer) { toggleLayer(actLayer.id); return; }
    setActLoading(true);
    setActError(null);
    try {
      const segments = await fetchACTfromOverpass();
      if (segments.length === 0) {
        setActError("ACT is not yet mapped in OpenStreetMap. Import your membership GPX file below.");
      } else {
        const km = calcLayerKm(segments);
        const layer: MapLayer = {
          id: "act",
          name: "Adventure Country Tracks UK",
          color: "#f97316",
          visible: true,
          polylines: segments,
          source: "act",
          km: parseFloat(km.toFixed(1)),
        };
        onLayersChange([...layers.filter((l) => l.source !== "act"), layer]);
      }
    } catch (e) {
      setActError("Could not reach OpenStreetMap server. Import your ACT GPX file instead.");
    }
    setActLoading(false);
  };

  const handleGpxImport = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    setImportError(null);
    Array.from(files).forEach((file) => {
      const reader = new FileReader();
      reader.onload = (ev) => {
        const content = ev.target?.result as string;
        try {
          const polylines = gpxToPolylines(content);
          if (polylines.length === 0 || polylines[0].length < 2) {
            setImportError(`Could not parse "${file.name}" — check it's a valid GPX file with track points.`);
            return;
          }
          const km = calcLayerKm(polylines);
          const id = `import-${Date.now()}-${Math.random().toString(36).slice(2)}`;
          const layer: MapLayer = {
            id,
            name: file.name.replace(/\.gpx$/i, ""),
            color: nextColor(),
            visible: true,
            polylines,
            source: "import",
            km: parseFloat(km.toFixed(1)),
          };
          onLayersChange([...layers, layer]);
        } catch {
          setImportError(`Failed to read "${file.name}".`);
        }
      };
      reader.readAsText(file);
    });
    e.target.value = "";
  };

  const saveOsKey = () => {
    onOsApiKeyChange(osKeyInput.trim());
    setShowOsKey(false);
  };

  return (
    <div className="fixed inset-0 z-[1500] flex flex-col" style={{ background: "rgba(0,0,0,0.80)", backdropFilter: "blur(4px)" }}>
      <div
        className="flex flex-col mt-auto rounded-t-2xl overflow-hidden"
        style={{ background: "hsl(22,15%,9%)", maxHeight: "92vh" }}
      >
        {/* Handle */}
        <div className="flex justify-center pt-3 pb-1 shrink-0">
          <div className="w-10 h-1 rounded-full bg-stone-700"></div>
        </div>

        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-[hsl(30,12%,16%)] shrink-0">
          <h2 className="text-base font-bold text-amber-400 uppercase tracking-widest">Map Layers</h2>
          <button
            onClick={onClose}
            className="w-8 h-8 rounded-full bg-stone-800 flex items-center justify-center text-stone-400 hover:text-stone-200 transition-colors"
          >
            <svg viewBox="0 0 24 24" className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>

        <div className="overflow-y-auto flex-1 px-4 py-3 space-y-4">

          {/* Base Map */}
          <div>
            <h3 className="text-[10px] font-bold text-stone-500 uppercase tracking-widest mb-2">Base Map</h3>
            <div className="space-y-1.5">
              {BASE_MAPS.map((bm) => (
                <button
                  key={bm.key}
                  onClick={() => {
                    if (bm.key === "os-outdoor" && !osApiKey) { setShowOsKey(true); return; }
                    onBaseMapChange(bm.key);
                  }}
                  className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl border transition-all text-left ${
                    baseMap === bm.key
                      ? "border-amber-500/60 bg-amber-500/10"
                      : "border-[hsl(30,12%,20%)] bg-[hsl(22,15%,12%)] hover:border-stone-600"
                  }`}
                >
                  <span className="text-lg shrink-0">{bm.icon}</span>
                  <div className="flex-1">
                    <div className={`text-sm font-bold ${baseMap === bm.key ? "text-amber-300" : "text-stone-300"}`}>
                      {bm.label}
                    </div>
                    <div className="text-[10px] text-stone-500">{bm.desc}</div>
                  </div>
                  {baseMap === bm.key && (
                    <svg viewBox="0 0 24 24" className="w-4 h-4 text-amber-400 shrink-0" fill="none" stroke="currentColor" strokeWidth="2.5">
                      <polyline points="20 6 9 17 4 12"/>
                    </svg>
                  )}
                  {bm.key === "os-outdoor" && !osApiKey && (
                    <span className="text-[10px] text-stone-600 shrink-0">API key</span>
                  )}
                </button>
              ))}
            </div>

            {showOsKey && (
              <div className="mt-2 bg-[hsl(22,15%,12%)] border border-[hsl(30,12%,22%)] rounded-xl p-3">
                <p className="text-[11px] text-stone-400 mb-2">
                  Get a free API key at{" "}
                  <a href="https://osdatahub.os.uk" target="_blank" rel="noreferrer" className="text-amber-400 underline">
                    osdatahub.os.uk
                  </a>
                </p>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={osKeyInput}
                    onChange={(e) => setOsKeyInput(e.target.value)}
                    placeholder="Paste OS API key..."
                    className="flex-1 bg-[hsl(22,15%,16%)] border border-[hsl(30,12%,22%)] rounded-lg px-3 py-2 text-xs text-stone-200 placeholder:text-stone-600 focus:outline-none focus:border-amber-500/60"
                  />
                  <button
                    onClick={saveOsKey}
                    className="px-3 py-2 rounded-lg bg-amber-500 text-stone-900 text-xs font-bold"
                  >
                    Save
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* Route Overlays */}
          <div>
            <h3 className="text-[10px] font-bold text-stone-500 uppercase tracking-widest mb-2">Route Overlays</h3>

            {/* TET */}
            <div className="bg-[hsl(22,15%,12%)] border border-[hsl(30,12%,20%)] rounded-xl p-3 mb-2">
              <div className="flex items-center gap-3 mb-2">
                <div className="w-5 h-5 rounded shrink-0" style={{ background: "#3b82f6" }}></div>
                <div className="flex-1">
                  <div className="text-sm font-bold text-stone-200">Trans Euro Trail UK</div>
                  <div className="text-[10px] text-stone-500">
                    {tetLayer ? `${tetLayer.km?.toFixed(0)} km · ${tetLayer.polylines.length} segments from OSM` : "Free via OpenStreetMap · 2,600+ km"}
                  </div>
                </div>
                {tetLayer && (
                  <button
                    onClick={() => toggleLayer(tetLayer.id)}
                    className={`w-10 h-5 rounded-full transition-colors shrink-0 ${tetLayer.visible ? "bg-blue-500" : "bg-stone-700"}`}
                  >
                    <div className={`w-4 h-4 rounded-full bg-white mx-0.5 transition-transform ${tetLayer.visible ? "translate-x-5" : "translate-x-0"}`}></div>
                  </button>
                )}
              </div>

              <div className="flex gap-2">
                <button
                  onClick={loadTET}
                  disabled={tetLoading}
                  className={`flex-1 py-2 rounded-lg text-xs font-bold border transition-all flex items-center justify-center gap-1.5 ${
                    tetLayer
                      ? "border-blue-500/40 text-blue-400 bg-blue-500/10"
                      : "border-stone-700 text-stone-400 hover:border-blue-500/50 hover:text-blue-300"
                  }`}
                >
                  {tetLoading ? (
                    <><span className="w-3 h-3 border border-blue-400/50 border-t-blue-400 rounded-full animate-spin"></span>Loading OSM...</>
                  ) : tetLayer ? "Loaded from OSM" : "Load from OSM"}
                </button>
                <a
                  href="https://transeurotrail.org/united-kingdom/"
                  target="_blank"
                  rel="noreferrer"
                  className="flex-1 py-2 rounded-lg text-xs font-bold border border-stone-700 text-stone-400 hover:border-amber-500/40 hover:text-amber-300 transition-all text-center"
                >
                  Download GPX ↗
                </a>
              </div>

              {tetError && (
                <p className="text-[10px] text-amber-400 mt-2">{tetError}</p>
              )}
            </div>

            {/* ACT */}
            <div className="bg-[hsl(22,15%,12%)] border border-[hsl(30,12%,20%)] rounded-xl p-3">
              <div className="flex items-center gap-3 mb-2">
                <div className="w-5 h-5 rounded shrink-0" style={{ background: "#f97316" }}></div>
                <div className="flex-1">
                  <div className="text-sm font-bold text-stone-200">Adventure Country Tracks UK</div>
                  <div className="text-[10px] text-stone-500">
                    {actLayer
                      ? `${actLayer.km?.toFixed(0)} km · ${actLayer.polylines.length} segments`
                      : "Brecon Beacons → Whitby · 915 km · Members only"}
                  </div>
                </div>
                {actLayer && (
                  <button
                    onClick={() => toggleLayer(actLayer.id)}
                    className={`w-10 h-5 rounded-full transition-colors shrink-0 ${actLayer.visible ? "bg-orange-500" : "bg-stone-700"}`}
                  >
                    <div className={`w-4 h-4 rounded-full bg-white mx-0.5 transition-transform ${actLayer.visible ? "translate-x-5" : "translate-x-0"}`}></div>
                  </button>
                )}
              </div>

              <div className="flex gap-2">
                <button
                  onClick={loadACT}
                  disabled={actLoading}
                  className={`flex-1 py-2 rounded-lg text-xs font-bold border transition-all flex items-center justify-center gap-1.5 ${
                    actLayer
                      ? "border-orange-500/40 text-orange-400 bg-orange-500/10"
                      : "border-stone-700 text-stone-400 hover:border-orange-500/50 hover:text-orange-300"
                  }`}
                >
                  {actLoading ? (
                    <><span className="w-3 h-3 border border-orange-400/50 border-t-orange-400 rounded-full animate-spin"></span>Checking OSM...</>
                  ) : actLayer ? "Loaded from OSM" : "Check OSM"}
                </button>
                <a
                  href="https://www.act-uk.com"
                  target="_blank"
                  rel="noreferrer"
                  className="flex-1 py-2 rounded-lg text-xs font-bold border border-stone-700 text-stone-400 hover:border-amber-500/40 hover:text-amber-300 transition-all text-center"
                >
                  Join ACT ↗
                </a>
              </div>

              {actError && (
                <p className="text-[10px] text-amber-400 mt-2">{actError}</p>
              )}
            </div>
          </div>

          {/* Import GPX */}
          <div>
            <h3 className="text-[10px] font-bold text-stone-500 uppercase tracking-widest mb-2">Import Your Own GPX</h3>
            <div className="bg-[hsl(22,15%,12%)] border border-dashed border-[hsl(30,12%,26%)] rounded-xl p-4">
              <input
                ref={fileInputRef}
                type="file"
                accept=".gpx"
                multiple
                onChange={handleGpxImport}
                className="hidden"
              />
              <button
                onClick={() => fileInputRef.current?.click()}
                className="w-full flex flex-col items-center gap-2 py-2"
              >
                <div className="w-10 h-10 rounded-full bg-stone-800 flex items-center justify-center">
                  <svg viewBox="0 0 24 24" className="w-5 h-5 text-stone-400" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                    <polyline points="17 8 12 3 7 8"/>
                    <line x1="12" y1="3" x2="12" y2="15"/>
                  </svg>
                </div>
                <div>
                  <div className="text-sm font-bold text-stone-300">Import GPX Files</div>
                  <div className="text-[10px] text-stone-500 mt-0.5">TET · ACT · Komoot · Garmin · Any GPX</div>
                </div>
              </button>

              {importError && (
                <p className="text-[10px] text-red-400 mt-2 text-center">{importError}</p>
              )}
            </div>
          </div>

          {/* Imported layers list */}
          {layers.filter((l) => l.source === "import").length > 0 && (
            <div>
              <h3 className="text-[10px] font-bold text-stone-500 uppercase tracking-widest mb-2">Imported Layers</h3>
              <div className="space-y-1.5">
                {layers.filter((l) => l.source === "import").map((layer) => (
                  <div key={layer.id} className="flex items-center gap-3 bg-[hsl(22,15%,12%)] border border-[hsl(30,12%,20%)] rounded-xl px-3 py-2.5">
                    <div className="w-4 h-4 rounded-sm shrink-0" style={{ background: layer.color }}></div>
                    <div className="flex-1 min-w-0">
                      <div className="text-xs font-bold text-stone-200 truncate">{layer.name}</div>
                      <div className="text-[10px] text-stone-500">{layer.km?.toFixed(1)} km · {layer.polylines[0]?.length ?? 0} pts</div>
                    </div>
                    <button
                      onClick={() => toggleLayer(layer.id)}
                      className={`w-10 h-5 rounded-full transition-colors shrink-0 ${layer.visible ? "" : "bg-stone-700"}`}
                      style={layer.visible ? { backgroundColor: layer.color } : {}}
                    >
                      <div className={`w-4 h-4 rounded-full bg-white mx-0.5 transition-transform ${layer.visible ? "translate-x-5" : "translate-x-0"}`}></div>
                    </button>
                    <button
                      onClick={() => removeLayer(layer.id)}
                      className="text-stone-600 hover:text-red-400 transition-colors"
                    >
                      <svg viewBox="0 0 24 24" className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2">
                        <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
                      </svg>
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="pb-2">
            <p className="text-[10px] text-stone-600 text-center leading-relaxed">
              TET route data sourced from OpenStreetMap contributors · ACT routes require membership from act-uk.com · Import your own downloaded GPX files to display any route
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
