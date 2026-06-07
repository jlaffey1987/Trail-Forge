/**
 * GPX import parser for React Native (regex-based — no DOMParser).
 * Mirrors artifacts/trailforge/src/lib/gpx.ts validation rules.
 */
import { haversineKm } from "@/lib/geo";

export interface GpxWaypoint {
  lat: number;
  lon: number;
  ele?: number;
}

export interface GpxValidation {
  ok: boolean;
  error?: string;
  trackCount: number;
  routeCount: number;
  pointCount: number;
  waypoints: GpxWaypoint[];
  distanceKm: number;
  name: string | null;
}

const MIN_POINTS = 2;
const MAX_POINTS = 100_000;
const SOFT_FILE_LIMIT_BYTES = 10 * 1024 * 1024;

export function parseGpxText(gpxText: string): GpxWaypoint[] {
  const points: GpxWaypoint[] = [];
  const ptRegex =
    /<(?:trkpt|rtept)\s[^>]*lat="([^"]+)"[^>]*lon="([^"]+)"[^>]*>([\s\S]*?)<\/(?:trkpt|rtept)>|<(?:trkpt|rtept)\s[^>]*lat="([^"]+)"[^>]*lon="([^"]+)"[^>]*\/>/g;
  let m: RegExpExecArray | null;
  while ((m = ptRegex.exec(gpxText)) != null) {
    const lat = parseFloat(m[1] ?? m[4] ?? "");
    const lon = parseFloat(m[2] ?? m[5] ?? "");
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) continue;
    let ele: number | undefined;
    const inner = m[3] ?? "";
    const eleMatch = inner.match(/<ele>([^<]+)<\/ele>/);
    if (eleMatch) {
      const e = parseFloat(eleMatch[1]);
      if (Number.isFinite(e)) ele = e;
    }
    points.push({ lat, lon, ele });
  }
  return points;
}

export function extractGpxName(gpxText: string): string | null {
  const meta = gpxText.match(/<metadata>[\s\S]*?<name>([^<]+)<\/name>/i);
  if (meta?.[1]?.trim()) return meta[1].trim();
  const trk = gpxText.match(/<trk>[\s\S]*?<name>([^<]+)<\/name>/i);
  if (trk?.[1]?.trim()) return trk[1].trim();
  const rte = gpxText.match(/<rte>[\s\S]*?<name>([^<]+)<\/name>/i);
  if (rte?.[1]?.trim()) return rte[1].trim();
  return null;
}

function distanceKmFromWaypoints(waypoints: GpxWaypoint[]): number {
  let total = 0;
  for (let i = 1; i < waypoints.length; i++) {
    total += haversineKm(waypoints[i - 1], waypoints[i]);
  }
  return Math.round(total * 100) / 100;
}

function bboxFromWaypoints(waypoints: GpxWaypoint[]) {
  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLng = Infinity;
  let maxLng = -Infinity;
  for (const w of waypoints) {
    minLat = Math.min(minLat, w.lat);
    maxLat = Math.max(maxLat, w.lat);
    minLng = Math.min(minLng, w.lon);
    maxLng = Math.max(maxLng, w.lon);
  }
  return { minLat, maxLat, minLng, maxLng };
}

export function validateGpxString(gpxText: string, fileSizeBytes?: number): GpxValidation {
  const empty: GpxValidation = {
    ok: false,
    trackCount: 0,
    routeCount: 0,
    pointCount: 0,
    waypoints: [],
    distanceKm: 0,
    name: null,
  };

  if (typeof fileSizeBytes === "number" && fileSizeBytes > SOFT_FILE_LIMIT_BYTES) {
    return {
      ...empty,
      error: "GPX file is too large (max 10 MB). Try splitting the track first.",
    };
  }

  if (!gpxText || typeof gpxText !== "string" || !gpxText.trim()) {
    return { ...empty, error: "GPX file is empty" };
  }

  if (!/<gpx[\s>]/i.test(gpxText)) {
    return { ...empty, error: "Not a GPX file (missing <gpx> root element)" };
  }

  const trackCount = (gpxText.match(/<trk[\s>]/gi) ?? []).length;
  const routeCount = (gpxText.match(/<rte[\s>]/gi) ?? []).length;
  if (trackCount === 0 && routeCount === 0) {
    return { ...empty, trackCount, routeCount, error: "GPX file has no tracks or routes" };
  }

  const waypoints = parseGpxText(gpxText);
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

  const bbox = bboxFromWaypoints(waypoints);
  if (bbox.maxLat - bbox.minLat > 20 || bbox.maxLng - bbox.minLng > 30) {
    return {
      ...empty,
      trackCount,
      routeCount,
      pointCount: waypoints.length,
      error: "GPX covers an unreasonably large area — please check the file",
    };
  }

  return {
    ok: true,
    trackCount,
    routeCount,
    pointCount: waypoints.length,
    waypoints,
    distanceKm: distanceKmFromWaypoints(waypoints),
    name: extractGpxName(gpxText),
  };
}

export function waypointsToPath(waypoints: GpxWaypoint[]): Array<[number, number]> {
  return waypoints.map((w) => [w.lon, w.lat] as [number, number]);
}

export function waypointsToAltitudes(waypoints: GpxWaypoint[]): number[] | undefined {
  if (!waypoints.some((w) => w.ele != null)) return undefined;
  return waypoints.map((w) => w.ele ?? 0);
}
