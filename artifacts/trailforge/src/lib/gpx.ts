export interface Waypoint {
  lat: number;
  lon: number;
  ele?: number;
}

export interface TrailRoute {
  id: string;
  name: string;
  waypoints: Waypoint[];
  distance_km: number | null;
  legal_status: string | null;
  difficulty: number | null;
}

export function parseGPX(gpxString: string | unknown): Waypoint[] {
  if (!gpxString || typeof gpxString !== "string") return [];
  try {
    const parser = new DOMParser();
    const doc = parser.parseFromString(gpxString, "application/xml");
    // Accept both track points (`<trkpt>`) and route points (`<rtept>`) so
    // GPX exports from third-party route planners (which often use <rte>)
    // also work.
    const points = doc.querySelectorAll("trkpt, rtept");
    const waypoints: Waypoint[] = [];
    points.forEach((pt) => {
      const lat = parseFloat(pt.getAttribute("lat") || "0");
      const lon = parseFloat(pt.getAttribute("lon") || "0");
      const eleEl = pt.querySelector("ele");
      const ele = eleEl ? parseFloat(eleEl.textContent || "0") : undefined;
      if (!isNaN(lat) && !isNaN(lon)) {
        waypoints.push({ lat, lon, ele });
      }
    });
    return waypoints;
  } catch {
    return [];
  }
}

export interface GpxBbox {
  minLat: number;
  maxLat: number;
  minLng: number;
  maxLng: number;
}

export function bboxFromWaypoints(waypoints: Waypoint[]): GpxBbox | null {
  if (waypoints.length === 0) return null;
  let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity;
  for (const w of waypoints) {
    if (w.lat < minLat) minLat = w.lat;
    if (w.lat > maxLat) maxLat = w.lat;
    if (w.lon < minLng) minLng = w.lon;
    if (w.lon > maxLng) maxLng = w.lon;
  }
  return { minLat, maxLat, minLng, maxLng };
}

export function distanceKmFromWaypoints(waypoints: Waypoint[]): number {
  let total = 0;
  for (let i = 1; i < waypoints.length; i++) {
    total += haversineKm(waypoints[i - 1], waypoints[i]);
  }
  return total;
}

export interface GpxValidation {
  ok: boolean;
  /** Reason for failure (set when ok=false). */
  error?: string;
  /** Number of <trk> tracks found. */
  trackCount: number;
  /** Number of <rte> routes found. */
  routeCount: number;
  /** Total decoded points (across tracks and routes). */
  pointCount: number;
  /** Decoded waypoints (in document order). */
  waypoints: Waypoint[];
  /** Bounding box, present when at least one waypoint was decoded. */
  bbox: GpxBbox | null;
  /** Total distance in km (haversine over decoded waypoints). */
  distanceKm: number;
  /** Detected name (`<metadata><name>` or first `<trk><name>`). */
  name: string | null;
}

const MIN_POINTS = 2;
const MAX_POINTS = 100_000; // sanity ceiling
const ALLOWED_LAT = 90;
const ALLOWED_LNG = 180;

export function validateGpxString(gpxString: string): GpxValidation {
  const empty: GpxValidation = {
    ok: false,
    trackCount: 0,
    routeCount: 0,
    pointCount: 0,
    waypoints: [],
    bbox: null,
    distanceKm: 0,
    name: null,
  };

  if (!gpxString || typeof gpxString !== "string") {
    return { ...empty, error: "GPX file is empty" };
  }
  let doc: Document;
  try {
    doc = new DOMParser().parseFromString(gpxString, "application/xml");
  } catch {
    return { ...empty, error: "Could not parse GPX XML" };
  }
  const parserError = doc.querySelector("parsererror");
  if (parserError) {
    return { ...empty, error: "GPX file is not valid XML" };
  }
  const root = doc.documentElement;
  if (!root || root.tagName.toLowerCase() !== "gpx") {
    return { ...empty, error: "Not a GPX file (missing <gpx> root element)" };
  }

  const trackCount = doc.querySelectorAll("trk").length;
  const routeCount = doc.querySelectorAll("rte").length;
  if (trackCount === 0 && routeCount === 0) {
    return { ...empty, trackCount, routeCount, error: "GPX file has no tracks or routes" };
  }

  const waypoints = parseGPX(gpxString);
  if (waypoints.length < MIN_POINTS) {
    return {
      ...empty,
      trackCount,
      routeCount,
      pointCount: waypoints.length,
      error: `Need at least ${MIN_POINTS} points to draw a trail (found ${waypoints.length})`,
    };
  }
  if (waypoints.length > MAX_POINTS) {
    return {
      ...empty,
      trackCount,
      routeCount,
      pointCount: waypoints.length,
      error: `Too many points (${waypoints.length}) — max is ${MAX_POINTS}`,
    };
  }
  // Sane coordinate range — GPX clients sometimes export 0,0 placeholder rows.
  for (const w of waypoints) {
    if (
      Math.abs(w.lat) > ALLOWED_LAT ||
      Math.abs(w.lon) > ALLOWED_LNG ||
      Number.isNaN(w.lat) ||
      Number.isNaN(w.lon)
    ) {
      return {
        ...empty,
        trackCount,
        routeCount,
        pointCount: waypoints.length,
        error: `Invalid coordinate found: lat=${w.lat}, lon=${w.lon}`,
      };
    }
  }
  const bbox = bboxFromWaypoints(waypoints);
  if (
    !bbox ||
    bbox.maxLat - bbox.minLat > 20 ||
    bbox.maxLng - bbox.minLng > 30
  ) {
    return {
      ...empty,
      trackCount,
      routeCount,
      pointCount: waypoints.length,
      bbox,
      error: "GPX covers an unreasonably large area — please check the file",
    };
  }

  const metaName = doc.querySelector("metadata > name")?.textContent?.trim();
  const trkName = doc.querySelector("trk > name")?.textContent?.trim();
  const rteName = doc.querySelector("rte > name")?.textContent?.trim();
  const name = metaName || trkName || rteName || null;

  return {
    ok: true,
    trackCount,
    routeCount,
    pointCount: waypoints.length,
    waypoints,
    bbox,
    distanceKm: distanceKmFromWaypoints(waypoints),
    name,
  };
}

export function getTrailStart(waypoints: Waypoint[]): Waypoint | null {
  return waypoints[0] ?? null;
}

export function getTrailEnd(waypoints: Waypoint[]): Waypoint | null {
  return waypoints[waypoints.length - 1] ?? null;
}

function haversineKm(a: Waypoint, b: Waypoint): number {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLon = ((b.lon - a.lon) * Math.PI) / 180;
  const sin2 = Math.sin(dLat / 2) ** 2;
  const cos2 = Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.asin(Math.sqrt(sin2 + cos2));
}

export function calcRouteDistanceKm(routes: TrailRoute[]): number {
  let total = 0;
  for (const r of routes) {
    total += r.distance_km ?? 0;
  }
  for (let i = 0; i < routes.length - 1; i++) {
    const endPt = getTrailEnd(routes[i].waypoints);
    const startPt = getTrailStart(routes[i + 1].waypoints);
    if (endPt && startPt) {
      total += haversineKm(endPt, startPt);
    }
  }
  return total;
}

export function buildCombinedGPX(routes: TrailRoute[]): string {
  const metadata = `  <metadata>
    <name>TrailForge Route — ${routes.map((r) => r.name).join(" → ")}</name>
    <desc>${routes.length} trails linked by TrailForge</desc>
    <time>${new Date().toISOString()}</time>
  </metadata>`;

  const waypoints = routes
    .map((r) => {
      const start = getTrailStart(r.waypoints);
      if (!start) return "";
      return `  <wpt lat="${start.lat}" lon="${start.lon}">
    <name>${r.name} — Start</name>
    <desc>Difficulty ${r.difficulty ?? "?"} · ${r.distance_km ?? "?"}km · ${r.legal_status ?? "Trail"}</desc>
  </wpt>`;
    })
    .join("\n");

  const tracks = routes
    .map((r, i) => {
      const trkpts = r.waypoints
        .map((p) => `      <trkpt lat="${p.lat}" lon="${p.lon}">${p.ele != null ? `<ele>${p.ele}</ele>` : ""}</trkpt>`)
        .join("\n");
      return `  <trk>
    <name>${i + 1}. ${r.name}</name>
    <desc>${r.legal_status ?? "Trail"} · Difficulty ${r.difficulty ?? "?"} · ${r.distance_km ?? "?"}km</desc>
    <type>${r.legal_status ?? "Trail"}</type>
    <trkseg>
${trkpts}
    </trkseg>
  </trk>`;
    })
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="TrailForge" xmlns="http://www.topografix.com/GPX/1/1"
     xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
     xsi:schemaLocation="http://www.topografix.com/GPX/1/1 http://www.topografix.com/GPX/1/1/gpx.xsd">
${metadata}
${waypoints}
${tracks}
</gpx>`;
}

export function downloadGPX(gpxContent: string, filename: string) {
  const blob = new Blob([gpxContent], { type: "application/gpx+xml" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export function buildGoogleMapsUrl(routes: TrailRoute[]): string {
  const points = routes
    .map((r) => getTrailStart(r.waypoints))
    .filter(Boolean) as Waypoint[];
  if (points.length === 0) return "https://maps.google.com";
  const stops = points.map((p) => `${p.lat},${p.lon}`).join("/");
  return `https://www.google.com/maps/dir/${stops}`;
}

export function buildAppleMapsUrl(routes: TrailRoute[]): string {
  const points = routes
    .map((r) => getTrailStart(r.waypoints))
    .filter(Boolean) as Waypoint[];
  if (points.length === 0) return "https://maps.apple.com";
  const waypoints = points.map((p, i) => (i === 0 ? `saddr=${p.lat},${p.lon}` : `daddr=${p.lat},${p.lon}`));
  return `https://maps.apple.com/?${waypoints.join("&")}&dirflg=d`;
}

export function buildWazeUrl(routes: TrailRoute[]): string {
  const first = getTrailStart(routes[0]?.waypoints ?? []);
  if (!first) return "https://waze.com";
  return `https://waze.com/ul?ll=${first.lat},${first.lon}&navigate=yes`;
}
