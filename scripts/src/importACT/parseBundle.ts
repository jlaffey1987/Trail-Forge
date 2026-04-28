import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

export interface GpxPoint {
  lat: number;
  lon: number;
  ele: number | null;
}

export interface GpxTrack {
  name: string;
  index: number;
  points: GpxPoint[];
}

export interface GpxWaypoint {
  name: string;
  lat: number;
  lon: number;
}

export interface ParsedBundle {
  filePath: string;
  sha256: string;
  bytes: number;
  tracks: GpxTrack[];
  waypoints: GpxWaypoint[];
}

const TRK_RE = /<trk\b[^>]*>([\s\S]*?)<\/trk>/g;
const TRKPT_RE = /<trkpt\b[^>]*\blat="([-\d.eE]+)"[^>]*\blon="([-\d.eE]+)"[^>]*\/?>(?:[\s\S]*?<ele>([-\d.eE]+)<\/ele>)?/g;
const WPT_RE = /<wpt\b[^>]*\blat="([-\d.eE]+)"[^>]*\blon="([-\d.eE]+)"[^>]*>([\s\S]*?)<\/wpt>/g;
const NAME_RE = /<name>([\s\S]*?)<\/name>/;

function decodeXml(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

export function parseBundle(filePath: string): ParsedBundle {
  const buf = readFileSync(filePath);
  const text = buf.toString("utf8");
  const sha256 = createHash("sha256").update(buf).digest("hex");

  const tracks: GpxTrack[] = [];
  let trkMatch: RegExpExecArray | null;
  let trackIndex = 0;
  while ((trkMatch = TRK_RE.exec(text)) != null) {
    const inner = trkMatch[1];
    const nameMatch = NAME_RE.exec(inner);
    const name = nameMatch ? decodeXml(nameMatch[1]).trim() : `Track ${trackIndex + 1}`;
    const points: GpxPoint[] = [];
    TRKPT_RE.lastIndex = 0;
    let ptMatch: RegExpExecArray | null;
    while ((ptMatch = TRKPT_RE.exec(inner)) != null) {
      const lat = parseFloat(ptMatch[1]);
      const lon = parseFloat(ptMatch[2]);
      const ele = ptMatch[3] != null ? parseFloat(ptMatch[3]) : null;
      if (Number.isFinite(lat) && Number.isFinite(lon)) {
        points.push({ lat, lon, ele: Number.isFinite(ele as number) ? (ele as number) : null });
      }
    }
    if (points.length > 1) {
      tracks.push({ name, index: trackIndex, points });
    }
    trackIndex += 1;
  }

  const waypoints: GpxWaypoint[] = [];
  let wptMatch: RegExpExecArray | null;
  WPT_RE.lastIndex = 0;
  while ((wptMatch = WPT_RE.exec(text)) != null) {
    const lat = parseFloat(wptMatch[1]);
    const lon = parseFloat(wptMatch[2]);
    const inner = wptMatch[3];
    const nameMatch = NAME_RE.exec(inner);
    const name = nameMatch ? decodeXml(nameMatch[1]).trim() : "";
    if (Number.isFinite(lat) && Number.isFinite(lon) && name) {
      waypoints.push({ name, lat, lon });
    }
  }

  return { filePath, sha256, bytes: buf.length, tracks, waypoints };
}

export function haversineMeters(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function trackDistanceMeters(points: GpxPoint[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i += 1) {
    total += haversineMeters(points[i - 1], points[i]);
  }
  return total;
}

export function trackBbox(points: GpxPoint[]): {
  minLat: number;
  maxLat: number;
  minLng: number;
  maxLng: number;
} {
  let minLat = 90;
  let maxLat = -90;
  let minLng = 180;
  let maxLng = -180;
  for (const p of points) {
    if (p.lat < minLat) minLat = p.lat;
    if (p.lat > maxLat) maxLat = p.lat;
    if (p.lon < minLng) minLng = p.lon;
    if (p.lon > maxLng) maxLng = p.lon;
  }
  return { minLat, maxLat, minLng, maxLng };
}
