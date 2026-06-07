/** Shared geometry helpers — gap split / merge logic mirrors TET import. */

export const GAP_THRESHOLD_KM = 0.5;
export const MERGE_MIN_KM = 0.5;
/** TNT spec: discard sections under 1 km after merging. */
export const DISCARD_MIN_KM = 1.0;

export interface TrackPoint {
  lat: number;
  lon: number;
  ele?: number;
}

export interface RawSection {
  points: TrackPoint[];
  distanceKm: number;
}

export interface ParsedSection {
  name: string;
  terrain: "trail" | "road";
  points: TrackPoint[];
  distanceKm: number;
  bboxMinLat: number;
  bboxMaxLat: number;
  bboxMinLon: number;
  bboxMaxLon: number;
  startLat: number;
  startLon: number;
  endLat: number;
  endLon: number;
  centroidLat: number;
  centroidLon: number;
  elevationGainM: number;
  elevationLossM: number;
  sectionNumber: number;
}

export function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2
    + Math.cos((lat1 * Math.PI) / 180)
    * Math.cos((lat2 * Math.PI) / 180)
    * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function polylineDistanceKm(pts: TrackPoint[]): number {
  let d = 0;
  for (let i = 1; i < pts.length; i++) {
    d += haversineKm(pts[i - 1].lat, pts[i - 1].lon, pts[i].lat, pts[i].lon);
  }
  return d;
}

export function computeBbox(pts: TrackPoint[]) {
  let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
  for (const p of pts) {
    if (p.lat < minLat) minLat = p.lat;
    if (p.lat > maxLat) maxLat = p.lat;
    if (p.lon < minLon) minLon = p.lon;
    if (p.lon > maxLon) maxLon = p.lon;
  }
  return { minLat, maxLat, minLon, maxLon };
}

export function computeCentroid(pts: TrackPoint[]): { lat: number; lon: number } {
  return {
    lat: pts.reduce((s, p) => s + p.lat, 0) / pts.length,
    lon: pts.reduce((s, p) => s + p.lon, 0) / pts.length,
  };
}

export function computeElevation(pts: TrackPoint[]): {
  gainM: number;
  lossM: number;
  hasData: boolean;
} {
  const withEle = pts.filter((p) => p.ele != null);
  if (withEle.length < 2) return { gainM: 0, lossM: 0, hasData: false };
  let gain = 0;
  let loss = 0;
  for (let i = 1; i < pts.length; i++) {
    if (pts[i].ele == null || pts[i - 1].ele == null) continue;
    const diff = pts[i].ele! - pts[i - 1].ele!;
    if (diff > 1) gain += diff;
    else if (diff < -1) loss += Math.abs(diff);
  }
  return { gainM: Math.round(gain), lossM: Math.round(loss), hasData: true };
}

export function deduplicatePoints(pts: TrackPoint[]): { points: TrackPoint[]; removed: number } {
  if (pts.length === 0) return { points: [], removed: 0 };
  const out: TrackPoint[] = [pts[0]];
  let removed = 0;
  for (let i = 1; i < pts.length; i++) {
    const prev = out[out.length - 1];
    if (
      Math.abs(pts[i].lat - prev.lat) > 0.00001
      || Math.abs(pts[i].lon - prev.lon) > 0.00001
    ) {
      out.push(pts[i]);
    } else {
      removed++;
    }
  }
  return { points: out, removed };
}

export function splitAtGaps(points: TrackPoint[]): {
  trailSections: RawSection[];
  roadSections: RawSection[];
  gapCount: number;
} {
  if (points.length < 2) return { trailSections: [], roadSections: [], gapCount: 0 };

  const trailSections: RawSection[] = [];
  const roadSections: RawSection[] = [];
  let run: TrackPoint[] = [points[0]];
  let gapCount = 0;

  for (let i = 1; i < points.length; i++) {
    const dist = haversineKm(
      points[i - 1].lat, points[i - 1].lon,
      points[i].lat, points[i].lon,
    );
    if (dist > GAP_THRESHOLD_KM) {
      gapCount++;
      if (run.length >= 2) {
        trailSections.push({ points: run, distanceKm: polylineDistanceKm(run) });
      }
      roadSections.push({
        points: [points[i - 1], points[i]],
        distanceKm: dist,
      });
      run = [points[i]];
    } else {
      run.push(points[i]);
    }
  }
  if (run.length >= 2) {
    trailSections.push({ points: run, distanceKm: polylineDistanceKm(run) });
  }
  return { trailSections, roadSections, gapCount };
}

export function mergeShortSections(rawSections: RawSection[]): {
  sections: RawSection[];
  mergeCount: number;
  discardCount: number;
} {
  let arr = rawSections.slice();
  let mergeCount = 0;

  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i < arr.length; i++) {
      if (arr[i].distanceKm >= MERGE_MIN_KM) continue;
      const hasPrev = i > 0;
      const hasNext = i < arr.length - 1;
      if (!hasPrev && !hasNext) break;
      let target: number;
      if (hasPrev && hasNext) {
        target = arr[i - 1].distanceKm <= arr[i + 1].distanceKm ? i - 1 : i + 1;
      } else {
        target = hasPrev ? i - 1 : i + 1;
      }
      const lo = Math.min(i, target);
      const hi = Math.max(i, target);
      arr.splice(lo, 2, {
        points: [...arr[lo].points, ...arr[hi].points],
        distanceKm: arr[lo].distanceKm + arr[hi].distanceKm,
      });
      mergeCount++;
      changed = true;
      break;
    }
  }

  const before = arr.length;
  arr = arr.filter((s) => s.distanceKm >= DISCARD_MIN_KM);
  return { sections: arr, mergeCount, discardCount: before - arr.length };
}

export function buildGpx(name: string, points: TrackPoint[]): string {
  const trkpts = points
    .map((p) => {
      const ele = p.ele != null ? `<ele>${p.ele}</ele>` : "";
      return `    <trkpt lat="${p.lat}" lon="${p.lon}">${ele}</trkpt>`;
    })
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="TrailForge TNT Import">
  <trk>
    <name>${name.replace(/&/g, "&amp;")}</name>
    <trkseg>
${trkpts}
    </trkseg>
  </trk>
</gpx>`;
}

export function processRoutePoints(points: TrackPoint[]): {
  sections: ParsedSection[];
  stats: {
    gapsFound: number;
    mergeCount: number;
    discardCount: number;
    duplicatePointsRemoved: number;
  };
} {
  const { points: cleanPoints, removed } = deduplicatePoints(points);
  const { trailSections: rawTrail, roadSections: rawRoad, gapCount } = splitAtGaps(cleanPoints);
  const { sections: mergedTrail, mergeCount, discardCount } = mergeShortSections(rawTrail);

  const sections: ParsedSection[] = [];
  let trailNum = 0;
  let roadNum = 0;

  for (const sec of mergedTrail) {
    trailNum++;
    const bbox = computeBbox(sec.points);
    const centroid = computeCentroid(sec.points);
    const elev = computeElevation(sec.points);
    const multi = mergedTrail.length > 1;
    const name = multi
      ? `Trans Northern Trail — Section ${trailNum}`
      : "Trans Northern Trail — Section 1";
    sections.push({
      name,
      terrain: "trail",
      points: sec.points,
      distanceKm: Math.round(sec.distanceKm * 10) / 10,
      bboxMinLat: bbox.minLat,
      bboxMaxLat: bbox.maxLat,
      bboxMinLon: bbox.minLon,
      bboxMaxLon: bbox.maxLon,
      startLat: sec.points[0].lat,
      startLon: sec.points[0].lon,
      endLat: sec.points[sec.points.length - 1].lat,
      endLon: sec.points[sec.points.length - 1].lon,
      centroidLat: centroid.lat,
      centroidLon: centroid.lon,
      elevationGainM: elev.gainM,
      elevationLossM: elev.lossM,
      sectionNumber: trailNum,
    });
  }

  for (const sec of rawRoad) {
    if (sec.distanceKm < 0.05) continue;
    roadNum++;
    const bbox = computeBbox(sec.points);
    const centroid = computeCentroid(sec.points);
    const elev = computeElevation(sec.points);
    sections.push({
      name: `Trans Northern Trail — Road Section ${roadNum}`,
      terrain: "road",
      points: sec.points,
      distanceKm: Math.round(sec.distanceKm * 10) / 10,
      bboxMinLat: bbox.minLat,
      bboxMaxLat: bbox.maxLat,
      bboxMinLon: bbox.minLon,
      bboxMaxLon: bbox.maxLon,
      startLat: sec.points[0].lat,
      startLon: sec.points[0].lon,
      endLat: sec.points[sec.points.length - 1].lat,
      endLon: sec.points[sec.points.length - 1].lon,
      centroidLat: centroid.lat,
      centroidLon: centroid.lon,
      elevationGainM: elev.gainM,
      elevationLossM: elev.lossM,
      sectionNumber: roadNum,
    });
  }

  return {
    sections,
    stats: {
      gapsFound: gapCount,
      mergeCount,
      discardCount,
      duplicatePointsRemoved: removed,
    },
  };
}
