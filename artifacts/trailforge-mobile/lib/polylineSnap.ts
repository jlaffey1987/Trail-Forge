/**
 * Snap GPS positions to trail polylines and trim paths from a join point.
 */
import { haversineLatLng } from "@/lib/geo";
import type { NavLatLng } from "@/lib/navigationReroute";

export interface PolylineSnap {
  point: NavLatLng;
  segmentIndex: number;
  /** Distance from query point to snapped point (metres). */
  distanceM: number;
  /** Distance along the polyline from start to snap point (metres). */
  distanceAlongM: number;
}

/** Closest point on segment [a, b] to p. */
export function closestPointOnSegment(
  p: NavLatLng,
  a: NavLatLng,
  b: NavLatLng,
): NavLatLng {
  const ax = a.longitude;
  const ay = a.latitude;
  const bx = b.longitude;
  const by = b.latitude;
  const px = p.longitude;
  const py = p.latitude;

  const abx = bx - ax;
  const aby = by - ay;
  const lenSq = abx * abx + aby * aby;
  const t =
    lenSq > 0
      ? Math.max(0, Math.min(1, ((px - ax) * abx + (py - ay) * aby) / lenSq))
      : 0;

  return {
    latitude: ay + t * aby,
    longitude: ax + t * abx,
  };
}

/** Nearest point on a polyline to `pos`. */
export function snapToPolyline(path: NavLatLng[], pos: NavLatLng): PolylineSnap | null {
  if (path.length === 0) return null;
  if (path.length === 1) {
    return {
      point: path[0],
      segmentIndex: 0,
      distanceM: haversineLatLng(pos, path[0]),
      distanceAlongM: 0,
    };
  }

  let bestPoint = path[0];
  let bestSeg = 0;
  let bestDist = Infinity;
  let bestAlong = 0;
  let along = 0;

  for (let i = 0; i < path.length - 1; i++) {
    const a = path[i];
    const b = path[i + 1];
    const segLen = haversineLatLng(a, b);
    const pt = closestPointOnSegment(pos, a, b);
    const d = haversineLatLng(pos, pt);
    if (d < bestDist) {
      bestDist = d;
      bestPoint = pt;
      bestSeg = i;
      bestAlong = along + haversineLatLng(a, pt);
    }
    along += segLen;
  }

  return {
    point: bestPoint,
    segmentIndex: bestSeg,
    distanceM: bestDist,
    distanceAlongM: bestAlong,
  };
}

/** Remaining path from snap point toward the end (forward travel). */
export function trimPathForward(path: NavLatLng[], snap: PolylineSnap): NavLatLng[] {
  if (path.length === 0) return [];
  if (path.length === 1) return [snap.point];

  const seg = snap.segmentIndex;
  const tail = path.slice(seg + 1);
  const out: NavLatLng[] = [snap.point, ...tail];
  return dedupeAdjacent(out);
}

/** Remaining path from snap point toward the start (reverse travel). */
export function trimPathBackward(path: NavLatLng[], snap: PolylineSnap): NavLatLng[] {
  if (path.length === 0) return [];
  if (path.length === 1) return [snap.point];

  const head = path.slice(0, snap.segmentIndex + 1).reverse();
  const out: NavLatLng[] = [snap.point, ...head.slice(1)];
  return dedupeAdjacent(out);
}

function dedupeAdjacent(pts: NavLatLng[]): NavLatLng[] {
  if (pts.length <= 1) return pts;
  const out: NavLatLng[] = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const prev = out[out.length - 1];
    if (haversineLatLng(prev, pts[i]) > 2) out.push(pts[i]);
  }
  return out.length >= 2 ? out : pts.length >= 2 ? pts : out;
}

/** Path length in metres. */
export function pathLengthM(path: NavLatLng[]): number {
  let d = 0;
  for (let i = 1; i < path.length; i++) {
    d += haversineLatLng(path[i - 1], path[i]);
  }
  return d;
}
