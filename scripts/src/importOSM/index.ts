/**
 * OSM Legal Motorcycle Trail Import
 * ==================================
 * Queries Overpass API for all UK legal motorcycle trails and imports them
 * into the TrailForge database.
 *
 * USAGE:
 *   pnpm --filter @workspace/scripts import:osm -- [flags]
 *
 * FLAGS:
 *   --region <scotland|wales|england-north|england-midlands|england-south|all>
 *   --dry-run        Preview without writing to DB
 *   --skip-ai        Use heuristic grading only
 *
 * LEGAL CRITERIA (queried from Overpass):
 *   - highway=track + motor_vehicle=yes|permissive
 *   - highway=track + designation=byway_open_to_all_traffic
 *   - highway=byway
 *   - highway=track + tracktype=grade2..5
 */

import { createClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { gradeSegment, elevationGainMeters } from "../importACT/grade.js";
import { mergeOsmWays, type MergedOsmSegment } from "./mergeWays.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Env loading
// ---------------------------------------------------------------------------

function loadEnv() {
  const candidates = [
    join(__dirname, "..", "..", "..", "artifacts", "api-server", ".env.local"),
    join(process.cwd(), "artifacts", "api-server", ".env.local"),
    join(process.cwd(), ".env.local"),
  ];
  for (const p of candidates) {
    if (!existsSync(p)) continue;
    for (const line of readFileSync(p, "utf8").split("\n")) {
      const eq = line.indexOf("=");
      if (eq === -1) continue;
      const k = line.slice(0, eq).trim();
      const v = line.slice(eq + 1).trim();
      if (!process.env[k]) process.env[k] = v;
    }
    console.log(`Loaded env: ${p}`);
    break;
  }
}

// ---------------------------------------------------------------------------
// CLI parsing
// ---------------------------------------------------------------------------

interface Opts {
  region: string;
  dryRun: boolean;
  skipAi: boolean;
  /** Use the simplified single-clause query (motor_vehicle=yes only) — good for smoke tests */
  simple: boolean;
}

function parseCli(): Opts {
  const opts: Opts = { region: "all", dryRun: false, skipAi: false, simple: false };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--region") opts.region = argv[++i] ?? "all";
    else if (a === "--dry-run") opts.dryRun = true;
    else if (a === "--skip-ai") opts.skipAi = true;
    else if (a === "--simple") opts.simple = true;
    else if (a === "--help" || a === "-h") {
      console.log("Usage: import:osm [--region <name>] [--dry-run] [--skip-ai] [--simple]");
      console.log("  --simple  Use basic single-clause query (motor_vehicle=yes only)");
      process.exit(0);
    }
  }
  return opts;
}

// ---------------------------------------------------------------------------
// Region bounding boxes [south, west, north, east]
//
// Large regions (England) are deliberately split into small sub-regions so
// each Overpass query stays well under the 60-second timeout.  Using one big
// bbox for England would cause a timeout → 0 results.
// ---------------------------------------------------------------------------

const REGIONS: Record<string, { bbox: [number, number, number, number]; label: string; scotland?: boolean }> = {
  // ── Scotland (separate flag triggers extra forest-road clauses) ───────────
  scotland:           { bbox: [54.5, -7.6, 60.9,  1.8],  label: "Scotland",          scotland: true },

  // ── Wales ─────────────────────────────────────────────────────────────────
  wales:              { bbox: [51.3, -5.4, 53.5, -2.6],  label: "Wales" },

  // ── England North (split — single bbox would timeout at 60s) ─────────────
  yorkshire:          { bbox: [53.3, -2.5, 54.5,  0.1],  label: "Yorkshire" },
  "lake-district":    { bbox: [54.2, -3.5, 55.0, -2.0],  label: "Lake District" },
  "peak-district":    { bbox: [53.0, -2.2, 53.6, -1.4],  label: "Peak District" },
  "northumberland":   { bbox: [54.8, -2.5, 55.5, -1.5],  label: "Northumberland" },

  // ── England Midlands (split) ──────────────────────────────────────────────
  shropshire:         { bbox: [52.3, -3.1, 52.9, -2.4],  label: "Shropshire" },
  "welsh-marches":    { bbox: [51.8, -3.0, 52.5, -2.6],  label: "Welsh Marches" },
  "midlands-central": { bbox: [52.0, -1.8, 53.0,  1.8],  label: "Midlands Central" },

  // ── England South (split) ─────────────────────────────────────────────────
  dartmoor:           { bbox: [50.3, -4.1, 50.7, -3.5],  label: "Dartmoor" },
  cotswolds:          { bbox: [51.6, -2.2, 52.0, -1.4],  label: "Cotswolds" },
  "south-downs":      { bbox: [50.8, -1.2, 51.1,  0.3],  label: "South Downs" },
  "new-forest":       { bbox: [50.7, -1.8, 51.0, -1.3],  label: "New Forest" },
  "exmoor":           { bbox: [51.0, -3.8, 51.3, -3.3],  label: "Exmoor" },
  cornwall:           { bbox: [49.95, -5.7, 50.6, -4.2], label: "Cornwall" },
  somerset:           { bbox: [50.9, -3.8, 51.5, -2.3],  label: "Somerset" },
  dorset:             { bbox: [50.5, -2.9, 51.2, -1.6],  label: "Dorset" },
  kent:               { bbox: [50.9, -0.2, 51.5, 1.4],   label: "Kent" },
  "east-anglia":      { bbox: [52.0, -0.2, 53.0, 1.8],   label: "East Anglia" },
  lancashire:         { bbox: [53.5, -3.2, 54.5, -2.2],  label: "Lancashire" },
  cheshire:           { bbox: [53.0, -3.0, 53.5, -2.0],  label: "Cheshire" },

  // ── Convenience aliases that group sub-regions (run via --region all) ─────
  // These are not queried directly — see resolveRegionKeys() below.
};

const ENGLAND_REGIONS = [
  "cornwall", "dartmoor", "exmoor", "dorset", "somerset", "new-forest",
  "south-downs", "kent", "cotswolds", "welsh-marches", "shropshire",
  "cheshire", "midlands-central", "peak-district", "lancashire",
  "yorkshire", "lake-district", "northumberland", "east-anglia",
] as const;

const REGION_GROUPS: Record<string, readonly string[]> = {
  "england-north": ["yorkshire", "lake-district", "peak-district", "northumberland", "lancashire"],
  "england-midlands": ["shropshire", "welsh-marches", "midlands-central", "cheshire", "peak-district"],
  "england-south": [
    "cornwall", "dartmoor", "exmoor", "dorset", "somerset", "new-forest",
    "south-downs", "kent", "cotswolds",
  ],
  england: ENGLAND_REGIONS,
};

/**
 * Keys to use when --region all is specified.
 * Lists every leaf region in a sensible south→north order.
 */
const ALL_REGIONS = [
  ...ENGLAND_REGIONS,
  "wales",
  "scotland",
];

function resolveRegionKeys(region: string): string[] {
  if (region === "all") return [...ALL_REGIONS];
  const group = REGION_GROUPS[region];
  if (group) return [...group];
  return [region];
}

// ---------------------------------------------------------------------------
// Overpass types
// ---------------------------------------------------------------------------

interface OsmNode { type: "node"; id: number; lat: number; lon: number }
interface OsmWayGeom { lat: number; lon: number }
interface OsmWay {
  type: "way";
  id: number;
  nodes: number[];
  geometry: OsmWayGeom[];
  tags: Record<string, string>;
}
type OsmElement = OsmNode | OsmWay;

interface OverpassResponse {
  elements: OsmElement[];
}

// ---------------------------------------------------------------------------
// Overpass query
// ---------------------------------------------------------------------------

/**
 * Standard query — covers all legal motorcycle trail tags for England/Wales.
 * Each clause uses a small focused bbox to stay under the 60s Overpass timeout.
 */
function buildOverpassQuery(bbox: [number, number, number, number]): string {
  const [s, w, n, e] = bbox;
  const b = `${s},${w},${n},${e}`;
  return (
    `[out:json][timeout:120];(` +
    `way["highway"="track"]["motor_vehicle"="yes"](${b});` +
    `way["highway"="track"]["motor_vehicle"="permissive"](${b});` +
    `way["highway"="track"]["designation"="byway_open_to_all_traffic"](${b});` +
    `way["highway"="byway"](${b});` +
    `way["highway"="track"]["tracktype"="grade2"](${b});` +
    `way["highway"="track"]["tracktype"="grade3"](${b});` +
    `way["highway"="track"]["tracktype"="grade4"](${b});` +
    `way["highway"="track"]["tracktype"="grade5"](${b});` +
    `);out geom;`
  );
}

/**
 * Scotland query — adds forest road clauses (access=yes / foot=yes on tracks)
 * which are commonly used by Forestry & Land Scotland.
 */
function buildScotlandQuery(bbox: [number, number, number, number]): string {
  const [s, w, n, e] = bbox;
  const b = `${s},${w},${n},${e}`;
  return (
    `[out:json][timeout:120];(` +
    `way["highway"="track"]["motor_vehicle"="yes"](${b});` +
    `way["highway"="track"]["motor_vehicle"="permissive"](${b});` +
    `way["highway"="track"]["designation"="byway_open_to_all_traffic"](${b});` +
    `way["highway"="byway"](${b});` +
    `way["highway"="track"]["tracktype"="grade2"](${b});` +
    `way["highway"="track"]["tracktype"="grade3"](${b});` +
    `way["highway"="track"]["tracktype"="grade4"](${b});` +
    `way["highway"="track"]["tracktype"="grade5"](${b});` +
    `way["highway"="track"]["access"="yes"](${b});` +
    `way["highway"="track"]["foot"="yes"](${b});` +
    `);out geom;`
  );
}

/**
 * Simple single-clause query for smoke-testing a region.
 */
function buildSimpleQuery(bbox: [number, number, number, number]): string {
  const [s, w, n, e] = bbox;
  return `[out:json][timeout:120];(way["highway"="track"]["motor_vehicle"="yes"](${s},${w},${n},${e}););out geom;`;
}

/** Sleep helper */
function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

function isTransientNetworkError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /fetch failed|ECONNRESET|ETIMEDOUT|socket hang up|network/i.test(msg);
}

/** Retry Supabase calls on transient network blips (common on long imports). */
async function withDbRetry<T extends { error: { message: string } | null }>(
  label: string,
  fn: () => Promise<T>,
  attempts = 4,
): Promise<T> {
  let last: T | undefined;
  for (let i = 1; i <= attempts; i++) {
    try {
      last = await fn();
      if (!last.error || !isTransientNetworkError(last.error)) return last;
      if (i === attempts) return last;
      const wait = i * 3000;
      console.warn(`  [DB] ${label} failed (${last.error.message}) — retry ${i}/${attempts - 1} in ${wait / 1000}s`);
      await sleep(wait);
    } catch (err) {
      if (!isTransientNetworkError(err) || i === attempts) throw err;
      const wait = i * 3000;
      console.warn(`  [DB] ${label} failed (${(err as Error).message}) — retry ${i}/${attempts - 1} in ${wait / 1000}s`);
      await sleep(wait);
    }
  }
  return last!;
}

/** Public Overpass mirrors — rotate on 504/503/429. */
const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
];

const OVERPASS_MAX_ATTEMPTS_PER_ENDPOINT = 4;

async function postOverpass(url: string, query: string): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "Accept": "application/json",
      "User-Agent": "TrailForge/1.0 (trail-navigation-app)",
    },
    body: `data=${encodeURIComponent(query)}`,
  });
}

async function fetchOverpass(
  query: string,
  endpointIdx = 0,
  attempt = 1,
): Promise<OverpassResponse> {
  const url = OVERPASS_ENDPOINTS[endpointIdx] ?? OVERPASS_ENDPOINTS[0];
  const mirrorLabel = `${new URL(url).hostname} (${attempt}/${OVERPASS_MAX_ATTEMPTS_PER_ENDPOINT})`;

  console.log(`  [Overpass] POST ${mirrorLabel}`);

  let res: Response;
  try {
    res = await postOverpass(url, query);
  } catch (err) {
    if (endpointIdx + 1 < OVERPASS_ENDPOINTS.length) {
      console.warn(`  [Overpass] Network error on ${new URL(url).hostname}: ${(err as Error).message}`);
      console.log(`  [Overpass] Switching mirror → ${new URL(OVERPASS_ENDPOINTS[endpointIdx + 1]).hostname}`);
      await sleep(45_000);
      return fetchOverpass(query, endpointIdx + 1, 1);
    }
    throw err;
  }

  console.log(`  [Overpass] Response: HTTP ${res.status} (${new URL(url).hostname})`);

  // 429 = rate limit, 503 = server busy, 504 = gateway timeout
  if (res.status === 429 || res.status === 503 || res.status === 504) {
    if (attempt < OVERPASS_MAX_ATTEMPTS_PER_ENDPOINT) {
      const wait = attempt === 1 ? 60_000 : attempt === 2 ? 90_000 : 120_000;
      console.log(`  Overpass busy (${res.status}), waiting ${wait / 1000}s before retry...`);
      await sleep(wait);
      return fetchOverpass(query, endpointIdx, attempt + 1);
    }
    if (endpointIdx + 1 < OVERPASS_ENDPOINTS.length) {
      console.log(`  [Overpass] Mirror exhausted — trying ${new URL(OVERPASS_ENDPOINTS[endpointIdx + 1]).hostname}`);
      await sleep(60_000);
      return fetchOverpass(query, endpointIdx + 1, 1);
    }
    throw new Error(`Overpass server error (${res.status}) after all mirrors and retries`);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "(could not read body)");
    console.error(`  [Overpass] Error body:\n${text.slice(0, 400)}`);
    throw new Error(`Overpass HTTP ${res.status}`);
  }

  return res.json() as Promise<OverpassResponse>;
}

/** Quick connectivity check — sends a minimal query to verify the API is reachable. */
async function testOverpassConnectivity(): Promise<void> {
  const testQuery = [
    "[out:json][timeout:10];",
    "node(51.5,-0.1,51.51,-0.09)[\"amenity\"=\"bench\"];",
    "out count;",
  ].join("\n");

  console.log("\n[Overpass] Running connectivity test...");
  const res = await fetch("https://overpass-api.de/api/interpreter", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "Accept": "application/json",
      "User-Agent": "TrailForge/1.0",
    },
    body: `data=${encodeURIComponent(testQuery)}`,
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`Overpass connectivity test failed: HTTP ${res.status}\n${txt.slice(0, 200)}`);
  }
  const data = await res.json() as { elements?: unknown[] };
  console.log(`[Overpass] Connectivity OK — got ${data.elements?.length ?? 0} element(s) in test response\n`);
}

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

function haversineKm(a: OsmWayGeom, b: OsmWayGeom): number {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLon = ((b.lon - a.lon) * Math.PI) / 180;
  const sinLat = Math.sin(dLat / 2);
  const sinLon = Math.sin(dLon / 2);
  const h = sinLat * sinLat + Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * sinLon * sinLon;
  return R * 2 * Math.asin(Math.sqrt(h));
}

function wayDistance(pts: OsmWayGeom[]): number {
  let d = 0;
  for (let i = 1; i < pts.length; i++) d += haversineKm(pts[i - 1], pts[i]);
  return d;
}

function wayBbox(pts: OsmWayGeom[]) {
  let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity;
  for (const p of pts) {
    if (p.lat < minLat) minLat = p.lat;
    if (p.lat > maxLat) maxLat = p.lat;
    if (p.lon < minLng) minLng = p.lon;
    if (p.lon > maxLng) maxLng = p.lon;
  }
  return { minLat, maxLat, minLng, maxLng };
}

function segmentHash(wayIds: number[], pts: OsmWayGeom[]): string {
  const payload = `${[...wayIds].sort((a, b) => a - b).join("+")}:${pts.map(p => `${p.lat.toFixed(5)},${p.lon.toFixed(5)}`).join("|")}`;
  return createHash("sha256").update(payload).digest("hex").slice(0, 16);
}

// ---------------------------------------------------------------------------
// Legal status + confidence from OSM tags
// ---------------------------------------------------------------------------

function legalStatusFromTags(tags: Record<string, string>): { legal_status: string; legal_confidence: string } {
  const designation = tags["designation"] ?? "";
  const motorVehicle = tags["motor_vehicle"] ?? "";

  if (designation === "byway_open_to_all_traffic") {
    return { legal_status: "BOAT", legal_confidence: "osm_legal" };
  }
  if (motorVehicle === "yes") {
    return { legal_status: "legal", legal_confidence: "osm_legal" };
  }
  if (motorVehicle === "permissive") {
    return { legal_status: "permissive", legal_confidence: "osm_legal" };
  }
  // tracktype criteria — less certain but still usable
  const tracktype = tags["tracktype"] ?? "";
  if (["grade2", "grade3", "grade4", "grade5"].includes(tracktype)) {
    return { legal_status: "unverified", legal_confidence: "unverified" };
  }
  return { legal_status: "unverified", legal_confidence: "unverified" };
}

// ---------------------------------------------------------------------------
// Grade from OSM tags (heuristic)
// ---------------------------------------------------------------------------

function gradeFromOsmTags(tags: Record<string, string>): number {
  const tracktype = tags["tracktype"] ?? "";
  const surface = tags["surface"] ?? "";
  const smoothness = tags["smoothness"] ?? "";

  let base = 4;
  if (tracktype === "grade2") base = 3;
  else if (tracktype === "grade3") base = 5;
  else if (tracktype === "grade4") base = 7;
  else if (tracktype === "grade5") base = 9;

  // Surface modifiers
  if (["asphalt", "paved", "concrete"].includes(surface)) base = Math.max(1, base - 2);
  if (["mud", "clay"].includes(surface)) base = Math.min(10, base + 2);
  if (["rock", "rocky"].includes(surface)) base = Math.min(10, base + 1);

  // Smoothness modifiers
  if (smoothness === "horrible" || smoothness === "very_horrible") base = Math.min(10, base + 2);
  if (smoothness === "impassable") base = 10;

  return Math.max(1, Math.min(10, base));
}

// ---------------------------------------------------------------------------
// Trail name from OSM tags
// ---------------------------------------------------------------------------

function nameFromTags(tags: Record<string, string>, wayId: number): string {
  return tags["name"] ?? tags["ref"] ?? tags["description"] ?? `OSM Way ${wayId}`;
}

// ---------------------------------------------------------------------------
// GeoJSON path from way geometry
// ---------------------------------------------------------------------------

function toGeoJsonPath(pts: OsmWayGeom[]): { type: "LineString"; coordinates: [number, number][] } {
  return {
    type: "LineString",
    coordinates: pts.map(p => [p.lon, p.lat]),
  };
}

interface OsmSegment {
  pts: OsmWayGeom[];
  distKm: number;
  wayIds: number[];
  tags: Record<string, string>;
  grade: number;
}

function mergedToSegments(merged: MergedOsmSegment[]): OsmSegment[] {
  return merged.map(m => ({
    pts: m.pts,
    distKm: m.distKm,
    wayIds: m.wayIds,
    tags: m.tags,
    grade: m.grade,
  }));
}

// ---------------------------------------------------------------------------
// Database row builder
// ---------------------------------------------------------------------------

interface TrailRow {
  name: string;
  source: string;
  source_region: string;
  type: string;
  terrain: string;
  difficulty: number;
  distance_km: number;
  path_geojson: object;
  is_public: boolean;
  bbox_min_lat: number;
  bbox_max_lat: number;
  bbox_min_lng: number;
  bbox_max_lng: number;
  centroid_lat: number;
  centroid_lon: number;
  legal_status: string;
  legal_confidence: string;
  legal_source: string;
  osm_way_ids: string[];
  segment_hash: string;
  source_url: string;
  verification_status: string;
}

// ---------------------------------------------------------------------------
// Main import
// ---------------------------------------------------------------------------

function geometryPatch(
  reg: { label: string },
  name: string,
  difficulty: number,
  seg: OsmSegment,
  bbox: ReturnType<typeof wayBbox>,
  geojson: ReturnType<typeof toGeoJsonPath>,
  legal_status: string,
  legal_confidence: string,
  hash: string,
  wayIds: number[],
) {
  return {
    name,
    source_region: reg.label,
    difficulty,
    distance_km: Math.round(seg.distKm * 100) / 100,
    path_geojson: geojson,
    bbox_min_lat: bbox.minLat,
    bbox_max_lat: bbox.maxLat,
    bbox_min_lng: bbox.minLng,
    bbox_max_lng: bbox.maxLng,
    centroid_lat: (bbox.minLat + bbox.maxLat) / 2,
    centroid_lon: (bbox.minLng + bbox.maxLng) / 2,
    legal_status,
    legal_confidence,
    legal_source: "OpenStreetMap",
    verification_status: "verified",
    segment_hash: hash,
    source_url: `osm://ways/${wayIds.join("+")}#${hash}`,
  };
}

interface ImportResult {
  queried: number;
  segments: number;
  inserted: number;
  updated: number;
  skipped: number;
  errors: number;
}

async function importRegion(
  regionKey: string,
  opts: Opts,
  supabase: ReturnType<typeof createClient>,
): Promise<ImportResult> {
  const reg = REGIONS[regionKey];
  if (!reg) throw new Error(`Unknown region: ${regionKey}`);

  console.log(`\n[${reg.label}] Querying Overpass...`);
  const query = opts.simple
    ? buildSimpleQuery(reg.bbox)
    : reg.scotland
      ? buildScotlandQuery(reg.bbox)
      : buildOverpassQuery(reg.bbox);
  if (opts.simple) console.log(`  [Overpass] Using simplified single-clause query (--simple mode)`);
  if (reg.scotland && !opts.simple) console.log(`  [Overpass] Using Scotland query (includes forest road clauses)`);
  const response = await fetchOverpass(query);
  const ways = response.elements.filter((e): e is OsmWay => e.type === "way" && e.geometry?.length >= 2);
  console.log(`[${reg.label}] ${ways.length} ways received`);

  const merged = mergeOsmWays(
    ways.map(w => ({ id: w.id, geometry: w.geometry, tags: w.tags ?? {} })),
    gradeFromOsmTags,
  );
  const segsAll = mergedToSegments(merged);
  console.log(`[${reg.label}] ${segsAll.length} merged trail section(s) from ${ways.length} ways`);

  if (!opts.dryRun) {
    const { count: removedRegion } = await supabase
      .from("trails")
      .delete({ count: "exact" })
      .eq("source", "OSM-UK")
      .eq("source_region", reg.label);
    if (removedRegion) {
      console.log(`[${reg.label}] Replaced ${removedRegion} existing OSM row(s) for region`);
    }

    const { count: removedStubs } = await supabase
      .from("trails")
      .delete({ count: "exact" })
      .eq("source", "OSM-UK")
      .is("path_geojson", null)
      .is("bbox_min_lat", null);
    if (removedStubs) {
      console.log(`[${reg.label}] Removed ${removedStubs} geometry-less OSM stub(s)`);
    }
  }

  let segments = 0, inserted = 0, updated = 0, skipped = 0, errors = 0;

  for (let si = 0; si < segsAll.length; si++) {
    const seg = segsAll[si];
    segments += 1;
    const primaryWayId = seg.wayIds[0];
    const tags = seg.tags;
    const hash = segmentHash(seg.wayIds, seg.pts);
    const bbox = wayBbox(seg.pts);
    const geojson = toGeoJsonPath(seg.pts);
    const { legal_status, legal_confidence } = legalStatusFromTags(tags);
    const baseName = nameFromTags(tags, primaryWayId);
    const name = segsAll.length > 1 && !tags.name
      ? `${baseName} — Section ${si + 1}`
      : baseName;
    const osmGrade = seg.grade;

    // Grade with AI (or heuristic)
    const gpxPoints = seg.pts.map(p => ({ lat: p.lat, lon: p.lon, ele: null as number | null }));
    const gradeResult = await gradeSegment({
      name,
      segmentHash: hash,
      source: "tet",
      region: reg.label,
      points: gpxPoints,
      distanceKm: seg.distKm,
      elevationGainM: null,
      skipAi: opts.skipAi,
    });

    const difficulty = gradeResult.fallback
      ? osmGrade
      : gradeResult.grade;

    // Upsert by segment_hash; repair legacy stubs missing geometry.
    if (!opts.dryRun) {
      const byHash = await withDbRetry(`lookup ${name}`, () =>
        supabase
          .from("trails")
          .select("id, path_geojson, bbox_min_lat")
          .eq("source", "OSM-UK")
          .eq("segment_hash", hash)
          .maybeSingle(),
      );

      if (byHash.data) {
        const needsGeometry = !byHash.data.path_geojson && byHash.data.bbox_min_lat == null;
        if (needsGeometry) {
          const { error } = await withDbRetry(`update ${name}`, () =>
            supabase
              .from("trails")
              .update(geometryPatch(reg, name, difficulty, seg, bbox, geojson, legal_status, legal_confidence, hash, seg.wayIds))
              .eq("id", byHash.data!.id),
          );
          if (error) { console.error(`  Error updating ${name}: ${error.message}`); errors++; }
          else updated++;
        } else skipped++;
        continue;
      }
    }

    if (opts.dryRun) {
      console.log(`  [DRY] ${name} | ${seg.distKm.toFixed(2)} km | Grade ${difficulty} | ways=${seg.wayIds.length} | ${legal_status}`);
      inserted++;
      continue;
    }

    // Insert without geometry columns first — BEFORE INSERT triggers on gpx_data
    // null out path_geojson/bbox when gpx_data is absent. Apply geometry via UPDATE.
    const row: TrailRow = {
      name,
      source: "OSM-UK",
      source_region: reg.label,
      type: legal_status === "BOAT" ? "BOAT" : "green-lane",
      terrain: "trail",
      difficulty,
      distance_km: Math.round(seg.distKm * 100) / 100,
      is_public: true,
      legal_status,
      legal_confidence,
      legal_source: "OpenStreetMap",
      osm_way_ids: seg.wayIds.map(String),
      segment_hash: hash,
      source_url: `osm://ways/${seg.wayIds.join("+")}#${hash}`,
      verification_status: "verified",
    };

    const { data: newRow, error } = await withDbRetry(`insert ${name}`, () =>
      supabase
        .from("trails")
        .insert(row as never)
        .select("id")
        .maybeSingle(),
    );
    if (error) {
      console.error(`  Error inserting ${name}: ${error.message}`);
      errors++;
    } else if (newRow?.id) {
      const { error: patchError } = await withDbRetry(`patch ${name}`, () =>
        supabase
          .from("trails")
          .update(geometryPatch(reg, name, difficulty, seg, bbox, geojson, legal_status, legal_confidence, hash, seg.wayIds))
          .eq("id", newRow.id),
      );
      if (patchError) {
        console.error(`  Error patching geometry for ${name}: ${patchError.message}`);
        errors++;
      } else {
        inserted++;
        if (inserted % 250 === 0) {
          console.log(`  [${reg.label}] ${inserted} trail(s) written…`);
        }
      }
    }
  }

  return { queried: ways.length, segments, inserted, updated, skipped, errors };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main() {
  loadEnv();
  const opts = parseCli();

  console.log("=== TrailForge OSM Legal Trail Import ===");
  console.log(`Region: ${opts.region}`);
  if (opts.dryRun) console.log("DRY RUN — no database writes");
  if (opts.simple) console.log("SIMPLE MODE — single-clause motor_vehicle=yes query only");

  // Verify Overpass connectivity — non-fatal; a 504 is often a transient load spike.
  try {
    await testOverpassConnectivity();
  } catch (e) {
    console.warn(`[Overpass] Connectivity check failed: ${(e as Error).message}`);
    console.warn("[Overpass] Proceeding anyway — the actual query may still succeed.\n");
  }

  const supabaseUrl = process.env["SUPABASE_URL"];
  const supabaseKey = process.env["SUPABASE_SERVICE_ROLE_KEY"];
  if (!supabaseUrl || !supabaseKey) {
    console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
    process.exit(1);
  }

  const supabase = createClient(supabaseUrl, supabaseKey, {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
  });

  const regionKeys = resolveRegionKeys(opts.region);

  // Validate region keys
  for (const key of regionKeys) {
    if (!REGIONS[key]) {
      console.error(`Unknown region: "${key}". Valid regions: ${Object.keys(REGIONS).join(", ")}, groups: ${Object.keys(REGION_GROUPS).join(", ")}`);
      process.exit(1);
    }
  }

  let totalQueried = 0, totalSegments = 0, totalInserted = 0, totalUpdated = 0, totalSkipped = 0, totalErrors = 0;
  const failedRegions: string[] = [];

  for (let i = 0; i < regionKeys.length; i++) {
    const regionKey = regionKeys[i];

    // Pause between regions — longer after failures to let Overpass recover.
    if (i > 0) {
      const pauseMs = failedRegions.length > 0 ? 90_000 : 60_000;
      console.log(`\n[Overpass] Waiting ${pauseMs / 1000}s before next region (rate limit courtesy)...`);
      await sleep(pauseMs);
    }

    try {
      const result = await importRegion(regionKey, opts, supabase);
      totalQueried  += result.queried;
      totalSegments += result.segments;
      totalInserted += result.inserted;
      totalUpdated  += result.updated;
      totalSkipped  += result.skipped;
      totalErrors   += result.errors;
    } catch (err) {
      console.error(`[${regionKey}] Failed: ${(err as Error).message} — skipping to next region`);
      failedRegions.push(regionKey);
      totalErrors++;
    }
  }

  console.log("\n=== Summary ===");
  console.log(`Ways queried:   ${totalQueried}`);
  console.log(`Segments:       ${totalSegments}`);
  console.log(`Inserted:       ${totalInserted}`);
  console.log(`Updated:        ${totalUpdated}`);
  console.log(`Skipped (dup):  ${totalSkipped}`);
  console.log(`Errors:         ${totalErrors}`);
  if (failedRegions.length > 0) {
    console.log("\nFailed regions — re-run individually when Overpass is quieter:");
    for (const key of failedRegions) {
      console.log(`  pnpm exec tsx ./src/importOSM/index.ts --region ${key} --skip-ai`);
    }
  }
}

main().catch(err => { console.error(err); process.exit(1); });
