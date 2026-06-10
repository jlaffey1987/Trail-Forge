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

function toNavLatLng(p: LocationPoint | NavLatLng): NavLatLng {
  if ("latitude" in p) return p;
  return { latitude: p.lat, longitude: p.lon };
}

export function orientTrailPathToward(
  path: NavLatLng[],
  approach: LocationPoint | NavLatLng,
  toward: LocationPoint | NavLatLng,
): NavLatLng[] {
  if (path.length <= 1) return path;
  const a = toNavLatLng(approach);
  const t = toNavLatLng(toward);

  const legCost = (pts: NavLatLng[]) => {
    const entry = pts[0];
    const exit = pts[pts.length - 1];
    return (
      haversineKm(
        { lat: a.latitude, lon: a.longitude },
        { lat: entry.latitude, lon: entry.longitude },
      ) +
      haversineKm(
        { lat: exit.latitude, lon: exit.longitude },
        { lat: t.latitude, lon: t.longitude },
      )
    );
  };

  const forward = path;
  const reverse = [...path].reverse();
  return legCost(forward) <= legCost(reverse) ? forward : reverse;
}

/**
 * Greedy trail sequence: each step picks the remaining trail that minimizes
 * approach→entry plus exit→destination (avoids backtracking when trails are added late).
 */
export function buildOptimalTrailSequence(
  start: LocationPoint,
  end: LocationPoint,
  trails: MapTrail[],
): MapTrail[] {
  if (trails.length <= 1) return trails;

  const remaining = new Set(trails.map((t) => t.id));
  const byId = new Map(trails.map((t) => [t.id, t]));
  const ordered: MapTrail[] = [];
  let current: LocationPoint = start;

  while (remaining.size > 0) {
    let bestId: string | null = null;
    let bestCost = Infinity;

    for (const id of remaining) {
      const trail = byId.get(id)!;
      const pts = trailMapCoordinates(trail);
      if (pts.length === 0) {
        bestId = id;
        bestCost = 0;
        continue;
      }
      const oriented = orientTrailPathToward(pts, current, end);
      const entry = oriented[0];
      const exit = oriented[oriented.length - 1];
      const cost =
        haversineKm(
          { lat: current.lat, lon: current.lon },
          { lat: entry.latitude, lon: entry.longitude },
        ) +
        haversineKm(
          { lat: exit.latitude, lon: exit.longitude },
          { lat: end.lat, lon: end.lon },
        );
      if (cost < bestCost) {
        bestCost = cost;
        bestId = id;
      }
    }

    if (!bestId) break;
    const trail = byId.get(bestId)!;
    ordered.push(trail);
    remaining.delete(bestId);

    const pts = trailMapCoordinates(trail);
    if (pts.length > 0) {
      const exit = orientTrailPathToward(pts, current, end).at(-1)!;
      current = { lat: exit.latitude, lon: exit.longitude, address: "" };
    }
  }

  return ordered;
}

/**
 * Order trails from the rider's current position with no fixed destination —
 * pure nearest-neighbor on trail entry points.
 */
export function buildOptimalTrailSequenceFromHere(
  start: LocationPoint,
  trails: MapTrail[],
): MapTrail[] {
  if (trails.length <= 1) return trails;

  const remaining = new Set(trails.map((t) => t.id));
  const byId = new Map(trails.map((t) => [t.id, t]));
  const ordered: MapTrail[] = [];
  let current: LocationPoint = start;

  while (remaining.size > 0) {
    let bestId: string | null = null;
    let bestEntryKm = Infinity;
    let bestExit: NavLatLng | null = null;

    for (const id of remaining) {
      const trail = byId.get(id)!;
      const pts = trailMapCoordinates(trail);
      if (pts.length === 0) {
        bestId = id;
        bestEntryKm = 0;
        bestExit = null;
        continue;
      }
      const forward = pts;
      const reverse = [...pts].reverse();
      for (const oriented of [forward, reverse]) {
        const entry = oriented[0];
        const d = haversineKm(
          { lat: current.lat, lon: current.lon },
          { lat: entry.latitude, lon: entry.longitude },
        );
        if (d < bestEntryKm) {
          bestEntryKm = d;
          bestId = id;
          bestExit = oriented[oriented.length - 1];
        }
      }
    }

    if (!bestId) break;
    ordered.push(byId.get(bestId)!);
    remaining.delete(bestId);
    if (bestExit) {
      current = { lat: bestExit.latitude, lon: bestExit.longitude, address: "" };
    }
  }

  return ordered;
}

/** Order trail ids from current position (no destination). */
export function orderTrailIdsFromLocation(
  start: LocationPoint,
  trailIds: string[],
  details: Map<string, MapTrail>,
): string[] {
  if (trailIds.length <= 1) return trailIds;
  const trails = trailIds
    .map((id) => details.get(id))
    .filter(Boolean) as MapTrail[];
  if (trails.length <= 1) return trailIds;
  return buildOptimalTrailSequenceFromHere(start, trails).map((t) => t.id);
}

/** Order trail ids for forward flow toward the destination. */
export function orderTrailIdsAlongRoute(
  start: LocationPoint,
  end: LocationPoint,
  trailIds: string[],
  details: Map<string, MapTrail>,
): string[] {
  if (trailIds.length <= 1) return trailIds;
  const trails = trailIds
    .map((id) => details.get(id))
    .filter(Boolean) as MapTrail[];
  if (trails.length <= 1) return trailIds;
  return buildOptimalTrailSequence(start, end, trails).map((t) => t.id);
}

/** Best entry point when approaching from `from`, optionally biased toward `toward`. */
export function trailEntryPoint(
  t: MapTrail,
  from: LocationPoint,
  toward?: LocationPoint,
): NavLatLng {
  const pts = trailMapCoordinates(t);
  if (pts.length === 0) {
    return { latitude: from.lat, longitude: from.lon };
  }
  if (pts.length === 1) return pts[0];
  if (toward) {
    return orientTrailPathToward(pts, from, toward)[0];
  }
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

/** Exit point after entering `t` from `from` toward `toward`. */
export function trailExitPoint(
  t: MapTrail,
  from: LocationPoint,
  toward: LocationPoint,
): NavLatLng {
  const pts = trailMapCoordinates(t);
  if (pts.length === 0) return { latitude: from.lat, longitude: from.lon };
  const oriented = orientTrailPathToward(pts, from, toward);
  return oriented[oriented.length - 1];
}
