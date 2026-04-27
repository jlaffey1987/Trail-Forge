import { type Trail } from "@/lib/supabase";
import { parseGPX, type Waypoint } from "@/lib/gpx";

export const DIFFICULTY_COLORS: Record<number, string> = {
  1: "#4ade80", 2: "#86efac", 3: "#a3e635", 4: "#bef264", 5: "#fbbf24",
  6: "#fb923c", 7: "#f97316", 8: "#ef4444", 9: "#dc2626", 10: "#7f1d1d",
};

export function getDifficultyColor(diff: number | null | undefined): string {
  if (diff == null) return "#fbbf24";
  return DIFFICULTY_COLORS[Math.max(1, Math.min(10, Math.round(diff)))] ?? "#fbbf24";
}

export interface DifficultyBucket {
  label: string;
  range: [number, number];
  color: string;
}

export const DIFFICULTY_BUCKETS: DifficultyBucket[] = [
  { label: "Easy (1–3)", range: [1, 3], color: "#4ade80" },
  { label: "Moderate (4–6)", range: [4, 6], color: "#fbbf24" },
  { label: "Hard (7–8)", range: [7, 8], color: "#f97316" },
  { label: "Extreme (9–10)", range: [9, 10], color: "#dc2626" },
];

export interface TrailBbox {
  minLat: number;
  maxLat: number;
  minLng: number;
  maxLng: number;
}

// Module-level cache shared across PlannerMap and MapTab.
const gpxCache = new Map<string, Waypoint[]>();
const bboxCache = new Map<string, TrailBbox | null>();
// Cache simplified polyline arrays per trail per zoom-bucket to avoid redoing
// Douglas–Peucker on every pan.
const simplifiedCache = new Map<string, Map<number, [number, number][]>>();

export function getTrailWaypoints(trail: Trail): Waypoint[] {
  const cached = gpxCache.get(trail.id);
  if (cached) return cached;
  const wps = parseGPX(trail.gpx_data);
  gpxCache.set(trail.id, wps);
  return wps;
}

export function getTrailBbox(trail: Trail): TrailBbox | null {
  if (bboxCache.has(trail.id)) return bboxCache.get(trail.id) ?? null;
  const wps = getTrailWaypoints(trail);
  if (wps.length === 0) {
    bboxCache.set(trail.id, null);
    return null;
  }
  let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity;
  for (const w of wps) {
    if (w.lat < minLat) minLat = w.lat;
    if (w.lat > maxLat) maxLat = w.lat;
    if (w.lon < minLng) minLng = w.lon;
    if (w.lon > maxLng) maxLng = w.lon;
  }
  const bbox = { minLat, maxLat, minLng, maxLng };
  bboxCache.set(trail.id, bbox);
  return bbox;
}

export function bboxesIntersect(a: TrailBbox, b: TrailBbox): boolean {
  return !(a.maxLat < b.minLat || a.minLat > b.maxLat || a.maxLng < b.minLng || a.minLng > b.maxLng);
}

// Perpendicular distance from point p to line segment a-b (in degree space — fine for filtering).
function perpDist(p: [number, number], a: [number, number], b: [number, number]): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  if (dx === 0 && dy === 0) {
    const ex = p[0] - a[0];
    const ey = p[1] - a[1];
    return Math.sqrt(ex * ex + ey * ey);
  }
  const t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy);
  const tc = Math.max(0, Math.min(1, t));
  const cx = a[0] + tc * dx;
  const cy = a[1] + tc * dy;
  const ex = p[0] - cx;
  const ey = p[1] - cy;
  return Math.sqrt(ex * ex + ey * ey);
}

// Iterative Douglas–Peucker (avoids recursion stack issues on long tracks).
export function simplify(points: [number, number][], tolerance: number): [number, number][] {
  if (points.length < 3 || tolerance <= 0) return points;
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length) {
    const [lo, hi] = stack.pop()!;
    let maxD = 0;
    let idx = -1;
    for (let i = lo + 1; i < hi; i++) {
      const d = perpDist(points[i], points[lo], points[hi]);
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (idx !== -1 && maxD > tolerance) {
      keep[idx] = 1;
      stack.push([lo, idx]);
      stack.push([idx, hi]);
    }
  }
  const out: [number, number][] = [];
  for (let i = 0; i < points.length; i++) if (keep[i]) out.push(points[i]);
  return out;
}

// Map zoom (Leaflet zoom 0..19) to a tolerance in degrees and a bucket key.
// Lower zoom (zoomed out) → larger tolerance → fewer points.
export function toleranceForZoom(zoom: number): { tol: number; bucket: number } {
  if (zoom <= 7) return { tol: 0.01, bucket: 7 };
  if (zoom <= 9) return { tol: 0.003, bucket: 9 };
  if (zoom <= 11) return { tol: 0.0008, bucket: 11 };
  if (zoom <= 13) return { tol: 0.00015, bucket: 13 };
  return { tol: 0, bucket: 99 };
}

export function getSimplifiedLatLngs(trail: Trail, zoom: number): [number, number][] {
  const wps = getTrailWaypoints(trail);
  if (wps.length === 0) return [];
  const full: [number, number][] = wps.map((w) => [w.lat, w.lon]);
  const { tol, bucket } = toleranceForZoom(zoom);
  if (tol === 0 || full.length < 50) return full;
  let perTrail = simplifiedCache.get(trail.id);
  if (!perTrail) { perTrail = new Map(); simplifiedCache.set(trail.id, perTrail); }
  const cached = perTrail.get(bucket);
  if (cached) return cached;
  const simp = simplify(full, tol);
  perTrail.set(bucket, simp);
  return simp;
}

// ---------------------------------------------------------------------------
// Layer renderer — used by both PlannerMap and MapTab so polyline + label
// rendering and layer-management code is not duplicated.
// ---------------------------------------------------------------------------

function esc(s: string | null | undefined): string {
  if (s == null) return "";
  return String(s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

export interface RenderTrailLayerOptions {
  selectedIds?: Set<string>;
  selectedColor?: string;
  showLabels?: boolean;
  baseWeight?: number;
  selectedWeight?: number;
  shadow?: boolean;
  onTrailClick?: (trail: Trail) => void;
  /** When provided, polylines are simplified for the given zoom level. */
  simplifyForZoom?: number;
  /** When false, polylines do not capture pointer events (map clicks pass through). Default true. */
  interactive?: boolean;
  /** Optional Leaflet pane name to render trail layers into (lets callers stack other overlays on top). */
  pane?: string;
}

export interface TrailLayerHandle {
  layers: import("leaflet").Layer[];
  bounds: [number, number][];
  clear: () => void;
}

export function renderTrailLayer(
  map: import("leaflet").Map,
  trails: Trail[],
  options: RenderTrailLayerOptions = {}
): TrailLayerHandle {
  const L = window.L;
  const layers: import("leaflet").Layer[] = [];
  const bounds: [number, number][] = [];

  const selectedIds = options.selectedIds ?? new Set<string>();
  const selectedColor = options.selectedColor ?? "#f0a832";
  const baseWeight = options.baseWeight ?? 3.5;
  const selectedWeight = options.selectedWeight ?? 5;
  const showLabels = options.showLabels ?? false;
  const shadow = options.shadow ?? false;
  const interactive = options.interactive ?? true;
  const pane = options.pane;

  const selectedList = Array.from(selectedIds);

  for (const trail of trails) {
    const latlngs = options.simplifyForZoom != null
      ? getSimplifiedLatLngs(trail, options.simplifyForZoom)
      : getTrailWaypoints(trail).map((w) => [w.lat, w.lon] as [number, number]);
    if (latlngs.length < 2) continue;

    const isSelected = selectedIds.has(trail.id);
    const diffColor = getDifficultyColor(trail.difficulty);

    if (shadow) {
      const sh = L.polyline(latlngs, {
        color: "#000",
        weight: isSelected ? selectedWeight + 3 : baseWeight + 2.5,
        opacity: 0.5,
        interactive: false,
        ...(pane ? { pane } : {}),
      }).addTo(map);
      layers.push(sh);
    }

    const main = L.polyline(latlngs, {
      color: isSelected ? selectedColor : diffColor,
      weight: isSelected ? selectedWeight : baseWeight,
      opacity: isSelected ? 1 : 0.85,
      dashArray: !isSelected && selectedIds.size > 0 ? "8 4" : undefined,
      interactive,
      ...(pane ? { pane } : {}),
    }).addTo(map);
    if (interactive && options.onTrailClick) {
      const handler = options.onTrailClick;
      main.on("click", () => handler(trail));
      main.on("mouseover", () => { try { (main as unknown as { setStyle: (s: object) => void }).setStyle({ weight: (isSelected ? selectedWeight : baseWeight) + 2 }); } catch {/**/} });
      main.on("mouseout", () => { try { (main as unknown as { setStyle: (s: object) => void }).setStyle({ weight: isSelected ? selectedWeight : baseWeight }); } catch {/**/} });
    }
    layers.push(main);

    for (const c of latlngs) bounds.push(c);

    if (showLabels) {
      const mid = latlngs[Math.floor(latlngs.length / 2)];
      const routeIdx = isSelected ? selectedList.indexOf(trail.id) + 1 : null;
      const marker = L.marker(mid, {
        icon: L.divIcon({
          html: `<div style="
              background:${isSelected ? selectedColor : "rgba(20,15,10,0.85)"};
              border:2px solid ${isSelected ? "#fff" : diffColor};
              border-radius:6px;
              padding:3px 6px;
              display:flex;align-items:center;gap:4px;
              box-shadow:0 2px 6px rgba(0,0,0,0.7);
              white-space:nowrap;
              cursor:pointer;
              font-family:system-ui,sans-serif;
              transform:translate(-50%,-50%);
            ">
              <span style="
                background:${isSelected ? "#0a0a0a" : diffColor};
                color:${isSelected ? selectedColor : "#000"};
                width:16px;height:16px;border-radius:3px;
                font-size:9px;font-weight:900;
                display:flex;align-items:center;justify-content:center;
              ">${routeIdx ?? trail.difficulty ?? "?"}</span>
              <span style="
                color:${isSelected ? "#0a0a0a" : "#fff"};
                font-size:10px;font-weight:700;
                max-width:120px;overflow:hidden;text-overflow:ellipsis;
              ">${esc(trail.name)}</span>
              ${isSelected
                ? '<span style="color:#0a0a0a;font-weight:900;font-size:11px;">✓</span>'
                : '<span style="color:#fbbf24;font-weight:900;font-size:11px;">+</span>'}
            </div>`,
          iconSize: [0, 0], iconAnchor: [0, 0], className: "",
        }),
      }).addTo(map);
      if (options.onTrailClick) {
        const handler = options.onTrailClick;
        marker.on("click", () => handler(trail));
      }
      layers.push(marker);
    }
  }

  return {
    layers,
    bounds,
    clear: () => {
      for (const l of layers) {
        try { l.remove(); } catch {/**/}
      }
    },
  };
}
