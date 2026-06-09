/**
 * Merge OSM ways into continuous road-to-road trail sections.
 *
 * Extends through degree-2 junctions (simple path joins) and stops at
 * dead-ends / multi-way junctions. Splits on internal gaps (road transfer)
 * or when the next way's grade differs by GRADE_SPLIT_DELTA+.
 */

export interface OsmWayGeom {
  lat: number;
  lon: number;
}

export interface OsmWayInput {
  id: number;
  geometry: OsmWayGeom[];
  tags: Record<string, string>;
}

export interface MergedOsmSegment {
  pts: OsmWayGeom[];
  distKm: number;
  wayIds: number[];
  tags: Record<string, string>;
  grade: number;
}

export const ENDPOINT_SNAP_DECIMALS = 4;
export const GRADE_SPLIT_DELTA = 3;
export const GAP_SPLIT_KM = 0.5;
export const MIN_TRAIL_KM = 0.25;

function haversineKm(a: OsmWayGeom, b: OsmWayGeom): number {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLon = ((b.lon - a.lon) * Math.PI) / 180;
  const h =
    Math.sin(dLat / 2) ** 2
    + Math.cos((a.lat * Math.PI) / 180)
    * Math.cos((b.lat * Math.PI) / 180)
    * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.asin(Math.sqrt(h));
}

function wayDistance(pts: OsmWayGeom[]): number {
  let d = 0;
  for (let i = 1; i < pts.length; i++) d += haversineKm(pts[i - 1], pts[i]);
  return d;
}

function snapNode(p: OsmWayGeom): string {
  return `${p.lat.toFixed(ENDPOINT_SNAP_DECIMALS)},${p.lon.toFixed(ENDPOINT_SNAP_DECIMALS)}`;
}

/** Union-find endpoints within `thresholdM` so nearly-touching ways connect. */
function clusterEndpoints(
  nodes: string[],
  thresholdM: number,
): Map<string, string> {
  const parsed = nodes.map((n) => {
    const [lat, lon] = n.split(",").map(Number);
    return { key: n, lat, lon };
  });
  const parent = new Map<string, string>();
  const find = (a: string): string => {
    if (!parent.has(a)) parent.set(a, a);
    if (parent.get(a) !== a) parent.set(a, find(parent.get(a)!));
    return parent.get(a)!;
  };
  const union = (a: string, b: string) => {
    parent.set(find(a), find(b));
  };

  for (let i = 0; i < parsed.length; i++) {
    for (let j = i + 1; j < parsed.length; j++) {
      const dKm = haversineKm(
        { lat: parsed[i].lat, lon: parsed[i].lon },
        { lat: parsed[j].lat, lon: parsed[j].lon },
      );
      if (dKm * 1000 <= thresholdM) union(parsed[i].key, parsed[j].key);
    }
  }

  const canonical = new Map<string, string>();
  for (const n of nodes) {
    const root = find(n);
    if (!canonical.has(root)) canonical.set(root, root);
    canonical.set(n, root);
  }
  return canonical;
}

function samePoint(a: OsmWayGeom, b: OsmWayGeom): boolean {
  return Math.abs(a.lat - b.lat) < 1e-6 && Math.abs(a.lon - b.lon) < 1e-6;
}

function appendPoints(base: OsmWayGeom[], add: OsmWayGeom[]): OsmWayGeom[] {
  if (add.length === 0) return base;
  if (base.length === 0) return [...add];
  const startIdx = samePoint(add[0], base[base.length - 1]) ? 1 : 0;
  return [...base, ...add.slice(startIdx)];
}

function prependPoints(add: OsmWayGeom[], base: OsmWayGeom[]): OsmWayGeom[] {
  if (base.length === 0) return [...add];
  if (add.length === 0) return base;
  const endIdx = samePoint(add[add.length - 1], base[0]) ? add.length - 1 : add.length;
  return [...add.slice(0, endIdx), ...base];
}

function splitAtInternalGaps(pts: OsmWayGeom[]): OsmWayGeom[][] {
  if (pts.length < 2) return [];
  const runs: OsmWayGeom[][] = [];
  let run: OsmWayGeom[] = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const d = haversineKm(pts[i - 1], pts[i]);
    if (d > GAP_SPLIT_KM && run.length >= 2) {
      runs.push(run);
      run = [pts[i]];
    } else {
      run.push(pts[i]);
    }
  }
  if (run.length >= 2) runs.push(run);
  return runs;
}

interface WayEdge {
  id: number;
  pts: OsmWayGeom[];
  tags: Record<string, string>;
  grade: number;
  start: string;
  end: string;
}

function mergeOneEdge(
  edge: WayEdge,
  adj: Map<string, WayEdge[]>,
  visited: Set<number>,
): { pts: OsmWayGeom[]; wayIds: number[]; tags: Record<string, string>; grade: number } | null {
  if (visited.has(edge.id)) return null;
  visited.add(edge.id);

  const usedWayIds = [edge.id];
  const grades = [edge.grade];
  let pts = [...edge.pts];
  let tags = edge.tags;

  // Extend forward from end node.
  let tip = edge.end;
  let g = edge.grade;
  while (true) {
    const candidates = (adj.get(tip) ?? []).filter((e) => !visited.has(e.id));
    if (candidates.length !== 1) break;
    const next = candidates[0];
    if (Math.abs(next.grade - g) >= GRADE_SPLIT_DELTA) break;
    visited.add(next.id);
    usedWayIds.push(next.id);
    grades.push(next.grade);
    const forward = next.start === tip;
    pts = appendPoints(pts, forward ? next.pts : [...next.pts].reverse());
    if (!tags.name && next.tags.name) tags = next.tags;
    g = next.grade;
    tip = forward ? next.end : next.start;
  }

  // Extend backward from start node.
  tip = edge.start;
  g = edge.grade;
  while (true) {
    const candidates = (adj.get(tip) ?? []).filter((e) => !visited.has(e.id));
    if (candidates.length !== 1) break;
    const next = candidates[0];
    if (Math.abs(next.grade - g) >= GRADE_SPLIT_DELTA) break;
    visited.add(next.id);
    usedWayIds.unshift(next.id);
    grades.unshift(next.grade);
    const connectsAtEnd = next.end === tip;
    const nextPts = connectsAtEnd ? [...next.pts].reverse() : next.pts;
    pts = prependPoints(nextPts, pts);
    if (!tags.name && next.tags.name) tags = next.tags;
    g = next.grade;
    tip = connectsAtEnd ? next.start : next.end;
  }

  return { pts, wayIds: usedWayIds, tags, grade: Math.max(...grades) };
}

/**
 * Merge ways in a region into continuous trail sections between road junctions.
 */
export function mergeOsmWays(
  ways: OsmWayInput[],
  gradeFromTags: (tags: Record<string, string>) => number,
): MergedOsmSegment[] {
  const edges: WayEdge[] = [];

  for (const w of ways) {
    if (w.geometry.length < 2) continue;
    edges.push({
      id: w.id,
      pts: w.geometry,
      tags: w.tags,
      grade: gradeFromTags(w.tags),
      start: snapNode(w.geometry[0]),
      end: snapNode(w.geometry[w.geometry.length - 1]),
    });
  }

  const endpointKeys = [...new Set(edges.flatMap((e) => [e.start, e.end]))];
  const endpointCluster = clusterEndpoints(endpointKeys, 35);
  const remappedEdges = edges.map((e) => ({
    ...e,
    start: endpointCluster.get(e.start) ?? e.start,
    end: endpointCluster.get(e.end) ?? e.end,
  }));

  const adjClustered = new Map<string, WayEdge[]>();
  for (const e of remappedEdges) {
    for (const node of [e.start, e.end]) {
      if (!adjClustered.has(node)) adjClustered.set(node, []);
      adjClustered.get(node)!.push(e);
    }
  }

  const visited = new Set<number>();
  const merged: MergedOsmSegment[] = [];

  for (const edge of remappedEdges) {
    const chain = mergeOneEdge(edge, adjClustered, visited);
    if (!chain || chain.pts.length < 2) continue;

    const gapRuns = splitAtInternalGaps(chain.pts);
    for (const run of gapRuns) {
      const distKm = wayDistance(run);
      if (distKm < MIN_TRAIL_KM) continue;
      merged.push({
        pts: run,
        distKm,
        wayIds: chain.wayIds,
        tags: chain.tags,
        grade: chain.grade,
      });
    }
  }

  return merged;
}
