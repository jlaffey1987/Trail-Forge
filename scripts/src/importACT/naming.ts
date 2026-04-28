import { haversineMeters, type GpxPoint, type GpxWaypoint } from "./parseBundle.js";

/**
 * Pick a human-friendly name for an off-road sub-segment. Strategy:
 *
 * 1. Find the closest waypoint to the segment's midpoint, within
 *    `maxWaypointMeters` (default 5 km). Strip generic prefixes like
 *    `Start N Day`, `Finish ACT` so the result reads like a place name.
 * 2. Compose `"<Day name> · <waypoint hint> (segment N+1)"`.
 * 3. Fallback when no waypoint is close enough:
 *    `"<Day name> (segment N+1)"`.
 */
export function nameSubSegment(
  dayName: string,
  segmentIndex: number,
  segmentPoints: GpxPoint[],
  waypoints: GpxWaypoint[],
  maxWaypointMeters: number = 5000,
): string {
  const baseDay = cleanDayName(dayName);
  const segLabel = `segment ${segmentIndex + 1}`;
  if (segmentPoints.length === 0) return `${baseDay} (${segLabel})`;

  const mid = segmentPoints[Math.floor(segmentPoints.length / 2)];
  let nearest: { wp: GpxWaypoint; dist: number } | null = null;
  for (const wp of waypoints) {
    const d = haversineMeters(mid, wp);
    if (d <= maxWaypointMeters && (!nearest || d < nearest.dist)) {
      nearest = { wp, dist: d };
    }
  }
  if (!nearest) return `${baseDay} (${segLabel})`;

  const cleaned = cleanWaypointName(nearest.wp.name);
  if (!cleaned) return `${baseDay} (${segLabel})`;
  return `${baseDay} · ${cleaned} (${segLabel})`;
}

/**
 * Normalise a track-level "day" name for display.
 * Strips trailing `_YYYYMMDD` date suffixes (TET convention) and
 * collapses underscores so the result reads naturally.
 *   "TET_UK-01-Borderlands_20240702" → "TET UK-01-Borderlands"
 *   "ACK_UK_Day_1"                   → "ACK UK Day 1"
 */
function cleanDayName(raw: string): string {
  let s = raw.trim();
  s = s.replace(/_(\d{8})$/, "");
  s = s.replace(/_/g, " ");
  return s.trim();
}

function cleanWaypointName(raw: string): string {
  let s = raw.trim();
  // Drop "Start 3 Day ACT It -" / "Finish ACT UK -" / "Day 1 ACT UK -" prefixes.
  s = s.replace(/^(start|finish|begin|end)\s*\d*\s*(day\s*\d*)?\s*act\s*(uk|it|italy|pyrenees|py)?\s*[-:–]\s*/i, "");
  s = s.replace(/^(day\s*\d+)\s*act\s*(uk|it|italy|pyrenees|py)?\s*[-:–]\s*/i, "");
  s = s.replace(/^act\s*(uk|it|italy|pyrenees|py)?\s*[-:–]\s*/i, "");
  // Drop generic placeholder names that the import shouldn't surface.
  if (/^wp\d+$/i.test(s) || /^waypoint\s*\d+$/i.test(s)) return "";
  return s.trim();
}
