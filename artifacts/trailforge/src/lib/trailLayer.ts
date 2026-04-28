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
// Cache the [lat, lng] points used for rendering. Populated from the
// pre-simplified columns (migration 0008) when present, with a fallback to
// parsing `gpx_data` on the device.
const latLngCache = new Map<string, [number, number][]>();
// Cache simplified polyline arrays per trail per zoom-bucket to avoid redoing
// Douglas–Peucker on every pan.
const simplifiedCache = new Map<string, Map<number, [number, number][]>>();

/**
 * Decode a Google encoded polyline (precision 5) into `[lat, lng]` pairs.
 *
 * Used to read the `simplified_path` column written by the migration 0008
 * trigger. Mirrors the algorithm from the @googlemaps/polyline-codec
 * reference implementation, kept inline to avoid pulling a dependency.
 */
export function decodePolyline(encoded: string): [number, number][] {
  const points: [number, number][] = [];
  let index = 0;
  let lat = 0;
  let lng = 0;
  const len = encoded.length;
  while (index < len) {
    let result = 0;
    let shift = 0;
    let b: number;
    do {
      b = encoded.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20 && index < len);
    const dLat = (result & 1) !== 0 ? ~(result >> 1) : result >> 1;
    lat += dLat;

    result = 0;
    shift = 0;
    do {
      b = encoded.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20 && index < len);
    const dLng = (result & 1) !== 0 ? ~(result >> 1) : result >> 1;
    lng += dLng;

    points.push([lat / 1e5, lng / 1e5]);
  }
  return points;
}

/**
 * Return the points the Map / Planner layers should render for `trail`.
 *
 * Order of preference:
 *   1. `trail.simplified_path` — encoded polyline written by migration 0008
 *      (instant decode, no XML parse, much smaller than gpx_data).
 *   2. `trail.path_geojson`    — GeoJSON LineString counterpart from the
 *      same migration. Coordinates are `[lng, lat]` per the GeoJSON spec
 *      and we flip them to Leaflet's `[lat, lng]`.
 *   3. `parseGPX(trail.gpx_data)` — legacy fall-back used until the bbox
 *      / simplified-path migration is applied to a given DB.
 */
export function getTrailLatLngs(trail: Trail): [number, number][] {
  const cached = latLngCache.get(trail.id);
  if (cached) return cached;

  if (typeof trail.simplified_path === "string" && trail.simplified_path.length > 0) {
    try {
      const decoded = decodePolyline(trail.simplified_path);
      if (decoded.length >= 2) {
        latLngCache.set(trail.id, decoded);
        return decoded;
      }
    } catch {
      // Fall through to the next source if decoding throws.
    }
  }

  const geo = trail.path_geojson;
  if (
    geo &&
    typeof geo === "object" &&
    Array.isArray((geo as { coordinates?: unknown }).coordinates)
  ) {
    const coords = (geo as { coordinates: Array<[number, number]> }).coordinates;
    if (coords.length >= 2) {
      const flipped: [number, number][] = coords.map(
        ([lng, lat]) => [lat, lng] as [number, number],
      );
      latLngCache.set(trail.id, flipped);
      return flipped;
    }
  }

  const wps = getTrailWaypoints(trail);
  const flipped: [number, number][] = wps.map((w) => [w.lat, w.lon]);
  latLngCache.set(trail.id, flipped);
  return flipped;
}

export function getTrailWaypoints(trail: Trail): Waypoint[] {
  const cached = gpxCache.get(trail.id);
  if (cached) return cached;
  const wps = parseGPX(trail.gpx_data);
  gpxCache.set(trail.id, wps);
  return wps;
}

export function getTrailBbox(trail: Trail): TrailBbox | null {
  if (bboxCache.has(trail.id)) return bboxCache.get(trail.id) ?? null;
  const latlngs = getTrailLatLngs(trail);
  if (latlngs.length === 0) {
    bboxCache.set(trail.id, null);
    return null;
  }
  let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity;
  for (const [lat, lng] of latlngs) {
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
    if (lng < minLng) minLng = lng;
    if (lng > maxLng) maxLng = lng;
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
  const full = getTrailLatLngs(trail);
  if (full.length === 0) return [];
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
// Trail clustering — at low zoom levels we collapse trails into a small
// number of grid-cell clusters instead of drawing every polyline. This keeps
// the country / region view readable and panning smooth.
// ---------------------------------------------------------------------------

/** Below this zoom level the Map renders clusters instead of polylines. */
export const CLUSTER_ZOOM_THRESHOLD = 10;

export interface TrailCluster {
  /** Cluster centroid (mean of member trail centers). */
  lat: number;
  lng: number;
  /** Number of trails aggregated into this cluster. */
  count: number;
  /** IDs of the trails grouped here. */
  trailIds: string[];
  /** Average difficulty (1..10) across members with a difficulty set. */
  avgDifficulty: number | null;
  /** Color matching the difficulty bucket of `avgDifficulty`. */
  color: string;
  /** Bounding box covering all member trails — used to zoom in on tap. */
  bbox: TrailBbox;
}

/**
 * Cell size in degrees used to grid-bucket trails into clusters at the given
 * Leaflet zoom. Smaller cells at higher zoom so clusters split apart as the
 * user zooms in. Tuned so a typical phone viewport shows ~3-8 clusters at
 * each zoom step below the threshold.
 */
export function clusterCellSize(zoom: number): number {
  if (zoom <= 3) return 16;
  if (zoom <= 4) return 8;
  if (zoom <= 5) return 4;
  if (zoom <= 6) return 2;
  if (zoom <= 7) return 1;
  if (zoom <= 8) return 0.5;
  return 0.25; // zoom 9
}

// Exported so the bucket mapping is unit-testable and reusable.
export function bucketColorForDifficulty(d: number | null): string {
  if (d == null) return "#a3a3a3";
  // Cluster averages are fractional (e.g. 3.5, 6.5). Round to the nearest
  // integer first so a value lands in exactly one bucket — without this,
  // 3.5 / 6.5 / 8.5 would fall through every range check and incorrectly
  // pick the last bucket. Clamp to the valid 1..10 difficulty domain.
  const rounded = Math.max(1, Math.min(10, Math.round(d)));
  for (const b of DIFFICULTY_BUCKETS) {
    if (rounded >= b.range[0] && rounded <= b.range[1]) return b.color;
  }
  // Unreachable given DIFFICULTY_BUCKETS covers 1..10 — defensive fallback.
  return DIFFICULTY_BUCKETS[DIFFICULTY_BUCKETS.length - 1].color;
}

/**
 * Group `trails` into spatial clusters based on their bbox centers.
 * Trails without a usable bbox are skipped (same as polyline rendering).
 */
export function clusterTrails(trails: Trail[], zoom: number): TrailCluster[] {
  const cellSize = clusterCellSize(zoom);
  interface Bucket {
    latSum: number;
    lngSum: number;
    diffSum: number;
    diffCount: number;
    ids: string[];
    minLat: number;
    maxLat: number;
    minLng: number;
    maxLng: number;
  }
  const cells = new Map<string, Bucket>();

  for (const t of trails) {
    const bbox = getTrailBbox(t);
    if (!bbox) continue;
    const cLat = (bbox.minLat + bbox.maxLat) / 2;
    const cLng = (bbox.minLng + bbox.maxLng) / 2;
    const key = `${Math.floor(cLat / cellSize)}:${Math.floor(cLng / cellSize)}`;
    let cell = cells.get(key);
    if (!cell) {
      cell = {
        latSum: 0,
        lngSum: 0,
        diffSum: 0,
        diffCount: 0,
        ids: [],
        minLat: bbox.minLat,
        maxLat: bbox.maxLat,
        minLng: bbox.minLng,
        maxLng: bbox.maxLng,
      };
      cells.set(key, cell);
    }
    cell.latSum += cLat;
    cell.lngSum += cLng;
    cell.ids.push(t.id);
    if (t.difficulty != null) {
      cell.diffSum += t.difficulty;
      cell.diffCount += 1;
    }
    if (bbox.minLat < cell.minLat) cell.minLat = bbox.minLat;
    if (bbox.maxLat > cell.maxLat) cell.maxLat = bbox.maxLat;
    if (bbox.minLng < cell.minLng) cell.minLng = bbox.minLng;
    if (bbox.maxLng > cell.maxLng) cell.maxLng = bbox.maxLng;
  }

  const out: TrailCluster[] = [];
  for (const cell of cells.values()) {
    const count = cell.ids.length;
    const avg = cell.diffCount > 0 ? cell.diffSum / cell.diffCount : null;
    out.push({
      lat: cell.latSum / count,
      lng: cell.lngSum / count,
      count,
      trailIds: cell.ids,
      avgDifficulty: avg,
      color: bucketColorForDifficulty(avg),
      bbox: {
        minLat: cell.minLat,
        maxLat: cell.maxLat,
        minLng: cell.minLng,
        maxLng: cell.maxLng,
      },
    });
  }
  return out;
}

export interface RenderClusterLayerOptions {
  onClusterClick?: (cluster: TrailCluster) => void;
  pane?: string;
  interactive?: boolean;
}

export interface ClusterLayerHandle {
  layers: import("leaflet").Layer[];
  clear: () => void;
}

function clusterMarkerSize(count: number): number {
  if (count >= 100) return 56;
  if (count >= 25) return 48;
  if (count >= 10) return 42;
  if (count >= 5) return 36;
  return 32;
}

export function renderTrailClusters(
  map: import("leaflet").Map,
  clusters: TrailCluster[],
  options: RenderClusterLayerOptions = {},
): ClusterLayerHandle {
  const L = window.L;
  const layers: import("leaflet").Layer[] = [];
  const interactive = options.interactive ?? true;
  const pane = options.pane;

  for (const c of clusters) {
    const size = clusterMarkerSize(c.count);
    const fontSize = c.count >= 100 ? 13 : c.count >= 10 ? 14 : 15;
    const html = `<div style="
        width:${size}px;height:${size}px;
        border-radius:50%;
        background:${c.color};
        border:3px solid rgba(0,0,0,0.7);
        box-shadow:0 2px 8px rgba(0,0,0,0.55);
        color:#0a0a0a;
        font-family:system-ui,-apple-system,sans-serif;
        font-weight:900;
        font-size:${fontSize}px;
        display:flex;align-items:center;justify-content:center;
        cursor:${interactive && options.onClusterClick ? "pointer" : "default"};
      ">${c.count}</div>`;

    const icon = L.divIcon({
      html,
      iconSize: [size, size],
      iconAnchor: [size / 2, size / 2],
      className: "trail-cluster-marker",
    });

    const marker = L.marker([c.lat, c.lng], {
      icon,
      interactive,
      ...(pane ? { pane } : {}),
    } as Parameters<typeof L.marker>[1]).addTo(map);

    if (interactive && options.onClusterClick) {
      const handler = options.onClusterClick;
      marker.on("click", () => handler(c));
    }

    layers.push(marker);
  }

  return {
    layers,
    clear: () => {
      for (const l of layers) {
        try { l.remove(); } catch {/**/}
      }
    },
  };
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
      : getTrailLatLngs(trail);
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

    // Approximated AI-discovered trails are rendered with a dashed line so
    // they're visually distinct from verified routes. They're still
    // interactive (so you can open and review them) but the user sees at a
    // glance that the geometry is not real.
    const isApprox = trail.verification_status === "ai-approximated";
    const baseDash =
      !isSelected && selectedIds.size > 0 ? "8 4" : isApprox ? "4 6" : undefined;

    const main = L.polyline(latlngs, {
      color: isSelected ? selectedColor : diffColor,
      weight: isSelected ? selectedWeight : baseWeight,
      opacity: isSelected ? 1 : isApprox ? 0.65 : 0.85,
      dashArray: baseDash,
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
