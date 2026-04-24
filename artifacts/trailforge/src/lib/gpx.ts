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
    const trkpts = doc.querySelectorAll("trkpt");
    const waypoints: Waypoint[] = [];
    trkpts.forEach((pt) => {
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
