/**
 * GPX 1.1 export library with device presets.
 *
 * Device presets:
 *   garminInreach  — simplified waypoints, max 500 pts per track
 *   garminEdge     — full elevation + course points for turns
 *   wahoo          — compatible format, named segments
 *   generic        — standard GPX 1.1 with all data (default)
 */

import * as FileSystem from "expo-file-system/legacy";
import * as Sharing from "expo-sharing";

export type GpxDevice = "garminInreach" | "garminEdge" | "wahoo" | "generic";

export interface GpxPoint {
  lat: number;
  lon: number;
  ele?: number;
  time?: string;
}

export interface GpxWaypoint {
  lat: number;
  lon: number;
  name: string;
  description?: string;
  sym?: string; // GPX symbol name
}

export interface GpxSegment {
  name: string;
  gradeLabel?: string; // e.g. "Grade 4 — Intermediate"
  isRoad?: boolean;
  points: GpxPoint[];
}

export interface GpxRouteInput {
  name: string;
  description?: string;
  segments: GpxSegment[];
  waypoints?: GpxWaypoint[];
}

// ── Device configs ────────────────────────────────────────────────────────────

const DEVICE_CONFIGS: Record<GpxDevice, {
  maxPointsPerTrack: number;
  includeElevation: boolean;
  includeCoursePoints: boolean;
  includeSegmentWaypoints: boolean;
  creator: string;
}> = {
  garminInreach: {
    maxPointsPerTrack: 500,
    includeElevation: false,
    includeCoursePoints: false,
    includeSegmentWaypoints: true,
    creator: "TrailForge (Garmin inReach)",
  },
  garminEdge: {
    maxPointsPerTrack: 5000,
    includeElevation: true,
    includeCoursePoints: true,
    includeSegmentWaypoints: true,
    creator: "TrailForge (Garmin Edge)",
  },
  wahoo: {
    maxPointsPerTrack: 3000,
    includeElevation: true,
    includeCoursePoints: false,
    includeSegmentWaypoints: true,
    creator: "TrailForge (Wahoo)",
  },
  generic: {
    maxPointsPerTrack: 10000,
    includeElevation: true,
    includeCoursePoints: false,
    includeSegmentWaypoints: true,
    creator: "TrailForge",
  },
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function trkpt(p: GpxPoint, includeEle: boolean): string {
  const ele = includeEle && p.ele != null
    ? `<ele>${p.ele.toFixed(1)}</ele>`
    : "";
  const time = p.time ? `<time>${p.time}</time>` : "";
  return `        <trkpt lat="${p.lat.toFixed(7)}" lon="${p.lon.toFixed(7)}">${ele}${time}</trkpt>`;
}

/** Thin a point array to maxPoints using uniform sampling */
function thin(points: GpxPoint[], maxPoints: number): GpxPoint[] {
  if (points.length <= maxPoints) return points;
  const step = points.length / maxPoints;
  const result: GpxPoint[] = [];
  for (let i = 0; i < maxPoints; i++) {
    result.push(points[Math.round(i * step)]);
  }
  return result;
}

// ── Core builder ──────────────────────────────────────────────────────────────

export function buildGpxString(input: GpxRouteInput, device: GpxDevice = "generic"): string {
  const cfg = DEVICE_CONFIGS[device];
  const now = new Date().toISOString();
  const safeName = escapeXml(input.name);

  // Build waypoints XML (section starts)
  let wptXml = "";
  if (cfg.includeSegmentWaypoints) {
    for (const seg of input.segments) {
      const first = seg.points[0];
      if (!first) continue;
      const sym = seg.isRoad ? "Road Junction" : "Trailhead";
      const desc = seg.gradeLabel ? escapeXml(seg.gradeLabel) : (seg.isRoad ? "Road section" : "Trail section");
      wptXml += `  <wpt lat="${first.lat.toFixed(7)}" lon="${first.lon.toFixed(7)}">
    <name>${escapeXml(seg.name)}</name>
    <desc>${desc}</desc>
    <sym>${sym}</sym>
  </wpt>\n`;
    }
    for (const w of input.waypoints ?? []) {
      wptXml += `  <wpt lat="${w.lat.toFixed(7)}" lon="${w.lon.toFixed(7)}">
    <name>${escapeXml(w.name)}</name>${w.description ? `\n    <desc>${escapeXml(w.description)}</desc>` : ""}${w.sym ? `\n    <sym>${escapeXml(w.sym)}</sym>` : ""}
  </wpt>\n`;
    }
  }

  // Build track XML (segments combined)
  let trksegXml = "";
  for (const seg of input.segments) {
    const pts = thin(seg.points, cfg.maxPointsPerTrack);
    trksegXml += `      <trkseg>\n`;
    for (const p of pts) {
      trksegXml += trkpt(p, cfg.includeElevation) + "\n";
    }
    trksegXml += `      </trkseg>\n`;

    // Garmin Edge course points for segment transitions
    if (cfg.includeCoursePoints && seg.gradeLabel) {
      trksegXml += `      <!-- ${escapeXml(seg.name)} — ${escapeXml(seg.gradeLabel ?? "")} -->\n`;
    }
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1"
     creator="${escapeXml(cfg.creator)}"
     xmlns="http://www.topografix.com/GPX/1/1"
     xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
     xsi:schemaLocation="http://www.topografix.com/GPX/1/1 http://www.topografix.com/GPX/1/1/gpx.xsd">
  <metadata>
    <name>${safeName}</name>${input.description ? `\n    <desc>${escapeXml(input.description)}</desc>` : ""}
    <time>${now}</time>
  </metadata>
${wptXml}  <trk>
    <name>${safeName}</name>
    <type>Motorcycle trail</type>
${trksegXml}  </trk>
</gpx>
`;
}

// ── File export ───────────────────────────────────────────────────────────────

function safeFilename(name: string): string {
  const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const safe = name.replace(/[^a-zA-Z0-9_-\s]/g, "").replace(/\s+/g, "-");
  return `TrailForge-${safe}-${date}.gpx`;
}

export async function exportGpxFile(
  input: GpxRouteInput,
  device: GpxDevice = "generic",
): Promise<void> {
  const gpxString = buildGpxString(input, device);
  const filename = safeFilename(input.name);
  const baseDir = FileSystem.cacheDirectory ?? FileSystem.documentDirectory;
  if (!baseDir) throw new Error("No writable directory on this device");

  const uri = `${baseDir}${filename}`;
  await FileSystem.writeAsStringAsync(uri, gpxString, {
    encoding: FileSystem.EncodingType.UTF8,
  });

  const canShare = await Sharing.isAvailableAsync();
  if (canShare) {
    await Sharing.shareAsync(uri, {
      mimeType: "application/gpx+xml",
      dialogTitle: filename,
      UTI: "com.topografix.gpx",
    });
  } else {
    throw new Error(`GPX saved to ${uri} but sharing is not available on this device.`);
  }
}

// ── Trail segments → GpxRouteInput ───────────────────────────────────────────

import type { MapTrail } from "./api";

/** Convert a list of planned trail sections into GpxRouteInput */
export function trailsToGpxInput(
  routeName: string,
  trails: MapTrail[],
): GpxRouteInput {
  const segments: GpxSegment[] = trails.map(t => {
    const pathPts: GpxPoint[] = [];
    const rawPath = t.path;
    if (Array.isArray(rawPath)) {
      rawPath.forEach((pair, idx) => {
        if (Array.isArray(pair) && pair.length >= 2) {
          const [lon, lat] = pair as [unknown, unknown];
          if (typeof lon === "number" && typeof lat === "number") {
            const p: GpxPoint = { lat, lon };
            if (t.altitudes && typeof t.altitudes[idx] === "number") {
              p.ele = t.altitudes[idx];
            }
            pathPts.push(p);
          }
        }
      });
    }

    const grade = parseInt(String(t.difficulty ?? "5"), 10);
    const gradeLabel = isNaN(grade)
      ? undefined
      : grade <= 3 ? `Grade ${grade} — Easy`
      : grade <= 6 ? `Grade ${grade} — Intermediate`
      : grade <= 9 ? `Grade ${grade} — Hard`
      : `Grade ${grade} — Extreme`;

    return {
      name: t.name,
      gradeLabel,
      isRoad: t.terrain === "road",
      points: pathPts,
    };
  });

  return { name: routeName, segments };
}
