/**
 * Corridor trail picking and along-route ordering for the planner ↔ map flow.
 * Ported from artifacts/trailforge/src/lib/routing.ts (selectTrailsAlongCorridor).
 */
import type { MapTrail } from "@/lib/api";
import { formatSearchBbox, haversineKm, trailMapCoordinates } from "@/lib/geo";
import { gradeFromDifficulty } from "@/lib/trailColors";
import type { LocationPoint } from "@/store/routePlannerStore";
import type { NavLatLng } from "@/lib/navigationReroute";

const KM_PER_DEG_LAT = 111.32;
export const SUGGEST_CORRIDOR_KM = 15;
export const SUGGEST_MAX_TRAILS = 8;

export interface CorridorSelectionOptions {
  corridorKm?: number;
  maxTrails?: number;
  excludeIds?: ReadonlySet<string>;
}

function trailMidpoint(t: MapTrail): { lat: number; lon: number } | null {
  if (typeof t.centroid_lat === "number" && typeof t.centroid_lon === "number") {
    return { lat: t.centroid_lat, lon: t.centroid_lon };
  }
  const pts = trailMapCoordinates(t);
  if (pts.length === 0) return null;
  const mid = pts[Math.floor(pts.length / 2)];
  return { lat: mid.latitude, lon: mid.longitude };
}

interface ScoredCandidate {
  trail: MapTrail;
  alongKm: number;
  perpendicularKm: number;
}

export function filterTrailsByGrades(trails: MapTrail[], grades: number[]): MapTrail[] {
  if (grades.length === 0) return trails;
  return trails.filter((t) => {
    const g =
      gradeFromDifficulty(t.difficulty) ??
      gradeFromDifficulty(t.ai_difficulty ?? null);
    return g != null && grades.includes(g);
  });
}

export function difficultyToCorridorKm(grades: number[]): number {
  if (grades.length === 0) return 25;
  const max = Math.max(...grades);
  if (max <= 5) return 20;
  if (max <= 7) return 30;
  return 40;
}

export function selectTrailsAlongCorridor(
  start: LocationPoint,
  end: LocationPoint,
  trails: MapTrail[],
  opts: CorridorSelectionOptions = {},
): MapTrail[] {
  const corridorKm = Math.max(0, opts.corridorKm ?? SUGGEST_CORRIDOR_KM);
  const maxTrails = Math.max(0, Math.floor(opts.maxTrails ?? SUGGEST_MAX_TRAILS));
  const excludeIds = opts.excludeIds ?? new Set<string>();
  if (maxTrails === 0 || trails.length === 0) return [];

  const meanLat = ((start.lat + end.lat) / 2) * (Math.PI / 180);
  const kmPerDegLng = KM_PER_DEG_LAT * Math.cos(meanLat);
  const bx = (end.lon - start.lon) * kmPerDegLng;
  const by = (end.lat - start.lat) * KM_PER_DEG_LAT;
  const totalKm = Math.hypot(bx, by);

  const scored: ScoredCandidate[] = [];
  for (const t of trails) {
    if (excludeIds.has(t.id)) continue;
    const m = trailMidpoint(t);
    if (!m) continue;
    const px = (m.lon - start.lon) * kmPerDegLng;
    const py = (m.lat - start.lat) * KM_PER_DEG_LAT;
    let alongKm: number;
    let perpKm: number;
    if (totalKm < 0.01) {
      alongKm = 0;
      perpKm = Math.hypot(px, py);
    } else {
      const t01 = (px * bx + py * by) / (totalKm * totalKm);
      const tc = Math.max(0, Math.min(1, t01));
      perpKm = Math.hypot(px - tc * bx, py - tc * by);
      alongKm = tc * totalKm;
    }
    if (perpKm > corridorKm) continue;
    scored.push({ trail: t, alongKm, perpendicularKm: perpKm });
  }

  if (scored.length === 0) return [];

  if (totalKm < 1 || maxTrails === 1) {
    return [...scored]
      .sort((a, b) => a.perpendicularKm - b.perpendicularKm)
      .slice(0, maxTrails)
      .sort((a, b) => a.alongKm - b.alongKm)
      .map((s) => s.trail);
  }

  const buckets: ScoredCandidate[][] = Array.from({ length: maxTrails }, () => []);
  for (const s of scored) {
    const idx = Math.min(
      maxTrails - 1,
      Math.max(0, Math.floor((s.alongKm / totalKm) * maxTrails)),
    );
    buckets[idx].push(s);
  }

  const picked: ScoredCandidate[] = [];
  const pickedIds = new Set<string>();
  for (const b of buckets) {
    if (b.length === 0) continue;
    b.sort((x, y) => x.perpendicularKm - y.perpendicularKm);
    picked.push(b[0]);
    pickedIds.add(b[0].trail.id);
  }

  if (picked.length < maxTrails) {
    for (const s of scored.sort((a, b) => a.perpendicularKm - b.perpendicularKm)) {
      if (picked.length >= maxTrails) break;
      if (pickedIds.has(s.trail.id)) continue;
      picked.push(s);
      pickedIds.add(s.trail.id);
    }
  }

  picked.sort((a, b) => a.alongKm - b.alongKm);
  return picked.map((s) => s.trail);
}

/** Order trail ids start → end to avoid backtracking along the trip line. */
export function orderTrailIdsAlongRoute(
  start: LocationPoint,
  end: LocationPoint,
  trailIds: string[],
  details: Map<string, MapTrail>,
): string[] {
  if (trailIds.length <= 1) return trailIds;

  const meanLat = ((start.lat + end.lat) / 2) * (Math.PI / 180);
  const kmPerDegLng = KM_PER_DEG_LAT * Math.cos(meanLat);
  const bx = (end.lon - start.lon) * kmPerDegLng;
  const by = (end.lat - start.lat) * KM_PER_DEG_LAT;
  const totalKm = Math.hypot(bx, by) || 1;

  return [...trailIds].sort((a, b) => {
    const ma = trailMidpoint(details.get(a) ?? { id: a } as MapTrail);
    const mb = trailMidpoint(details.get(b) ?? { id: b } as MapTrail);
    if (!ma || !mb) return 0;
    const along = (m: { lat: number; lon: number }) => {
      const px = (m.lon - start.lon) * kmPerDegLng;
      const py = (m.lat - start.lat) * KM_PER_DEG_LAT;
      return (px * bx + py * by) / (totalKm * totalKm);
    };
    return along(ma) - along(mb);
  });
}

/** Best entry point on a trail when approaching from `from`. */
export function trailEntryPoint(t: MapTrail, from: LocationPoint): NavLatLng {
  const pts = trailMapCoordinates(t);
  if (pts.length === 0) {
    return { latitude: from.lat, longitude: from.lon };
  }
  if (pts.length === 1) return pts[0];
  const first = pts[0];
  const last = pts[pts.length - 1];
  const dFirst = haversineKm(
    { lat: from.lat, lon: from.lon },
    { lat: first.latitude, lon: first.longitude },
  );
  const dLast = haversineKm(
    { lat: from.lat, lon: from.lon },
    { lat: last.latitude, lon: last.longitude },
  );
  return dFirst <= dLast ? first : last;
}
