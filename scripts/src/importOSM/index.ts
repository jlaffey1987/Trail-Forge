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
// ---------------------------------------------------------------------------

const REGIONS: Record<string, { bbox: [number, number, number, number]; label: string }> = {
  scotland: { bbox: [54.5, -7.6, 60.9, 1.8], label: "Scotland" },
  wales: { bbox: [51.3, -5.4, 53.5, -2.6], label: "Wales" },
  "england-north": { bbox: [52.5, -3.6, 55.5, 2.0], label: "England North" },
  "england-midlands": { bbox: [51.5, -3.5, 53.0, 1.8], label: "England Midlands" },
  "england-south": { bbox: [49.8, -5.6, 52.0, 1.8], label: "England South" },
};

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

function buildOverpassQuery(bbox: [number, number, number, number]): string {
  const [s, w, n, e] = bbox;
  const b = `${s},${w},${n},${e}`;
  // Timeout reduced to 60s — Overpass rejects queries with timeout>60 on the
  // public API when the server is under load, which can return HTTP 406.
  // Each union clause is a separate equality filter (no regex) for broadest
  // compatibility across all Overpass API versions.
  return `[out:json][timeout:60];(way["highway"="track"]["motor_vehicle"="yes"](${b});way["highway"="track"]["motor_vehicle"="permissive"](${b});way["highway"="track"]["designation"="byway_open_to_all_traffic"](${b});way["highway"="byway"](${b});way["highway"="track"]["tracktype"="grade2"](${b});way["highway"="track"]["tracktype"="grade3"](${b});way["highway"="track"]["tracktype"="grade4"](${b});way["highway"="track"]["tracktype"="grade5"](${b}););out geom;`;
}

/**
 * Single-clause query for smoke-testing a region.
 * Matches the exact format specified in the fix spec:
 *   data=[out:json][timeout:60];(way["highway"="track"]["motor_vehicle"="yes"](<bbox>););out geom;
 */
function buildSimpleQuery(bbox: [number, number, number, number]): string {
  const [s, w, n, e] = bbox;
  return `[out:json][timeout:60];(way["highway"="track"]["motor_vehicle"="yes"](${s},${w},${n},${e}););out geom;`;
}

async function fetchOverpass(query: string, attempt = 1): Promise<OverpassResponse> {
  const url = "https://overpass-api.de/api/interpreter";
  const body = `data=${encodeURIComponent(query)}`;

  console.log(`  [Overpass] POST ${url} (attempt ${attempt})`);
  console.log(`  [Overpass] Query:\n${query}\n`);

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "Accept": "application/json",
      "User-Agent": "TrailForge/1.0 (trail-navigation-app)",
    },
    body,
  });

  console.log(`  [Overpass] Response: HTTP ${res.status}`);

  if (res.status === 429 || res.status === 503) {
    if (attempt >= 4) throw new Error(`Overpass rate-limited after ${attempt} attempts`);
    const wait = attempt * 30_000;
    console.log(`  Overpass busy (${res.status}), waiting ${wait / 1000}s...`);
    await new Promise(r => setTimeout(r, wait));
    return fetchOverpass(query, attempt + 1);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "(could not read body)");
    console.error(`  [Overpass] Error body:\n${text}`);
    throw new Error(`Overpass HTTP ${res.status}: ${text.slice(0, 300)}`);
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

function segmentHash(wayId: number, pts: OsmWayGeom[]): string {
  const payload = `${wayId}:${pts.map(p => `${p.lat.toFixed(5)},${p.lon.toFixed(5)}`).join("|")}`;
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

// ---------------------------------------------------------------------------
// Segment splitting (split long ways at large gaps or junctions)
// ---------------------------------------------------------------------------

const GAP_THRESHOLD_KM = 0.5;
const MIN_SEGMENT_KM = 1.0;

interface OsmSegment {
  pts: OsmWayGeom[];
  distKm: number;
}

function splitAtGaps(pts: OsmWayGeom[]): OsmSegment[] {
  const segments: OsmSegment[] = [];
  let current: OsmWayGeom[] = [pts[0]];

  for (let i = 1; i < pts.length; i++) {
    const d = haversineKm(pts[i - 1], pts[i]);
    if (d > GAP_THRESHOLD_KM && current.length >= 2) {
      const dist = wayDistance(current);
      if (dist >= MIN_SEGMENT_KM) segments.push({ pts: current, distKm: dist });
      current = [pts[i]];
    } else {
      current.push(pts[i]);
    }
  }

  if (current.length >= 2) {
    const dist = wayDistance(current);
    if (dist >= MIN_SEGMENT_KM) segments.push({ pts: current, distKm: dist });
  }

  return segments;
}

// ---------------------------------------------------------------------------
// Database row builder
// ---------------------------------------------------------------------------

interface TrailRow {
  name: string;
  source: string;
  terrain: string;
  difficulty: number;
  distance_km: number;
  path_geojson: object;
  is_public: boolean;
  bbox_min_lat: number;
  bbox_max_lat: number;
  bbox_min_lng: number;
  bbox_max_lng: number;
  legal_status: string;
  legal_confidence: string;
  legal_source: string;
  osm_way_ids: string[];
  verification_status: string;
}

// ---------------------------------------------------------------------------
// Main import
// ---------------------------------------------------------------------------

interface ImportResult {
  queried: number;
  segments: number;
  inserted: number;
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
  const query = opts.simple ? buildSimpleQuery(reg.bbox) : buildOverpassQuery(reg.bbox);
  if (opts.simple) console.log(`  [Overpass] Using simplified single-clause query (--simple mode)`);
  const response = await fetchOverpass(query);
  const ways = response.elements.filter((e): e is OsmWay => e.type === "way" && e.geometry?.length >= 2);
  console.log(`[${reg.label}] ${ways.length} ways received`);

  let segments = 0, inserted = 0, skipped = 0, errors = 0;

  for (const way of ways) {
    const tags = way.tags ?? {};
    const segs = splitAtGaps(way.geometry);
    segments += segs.length;

    for (let si = 0; si < segs.length; si++) {
      const seg = segs[si];
      const hash = segmentHash(way.id, seg.pts);
      const bbox = wayBbox(seg.pts);
      const geojson = toGeoJsonPath(seg.pts);
      const { legal_status, legal_confidence } = legalStatusFromTags(tags);
      const name = segs.length > 1
        ? `${nameFromTags(tags, way.id)} — Section ${si + 1}`
        : nameFromTags(tags, way.id);
      const osmGrade = gradeFromOsmTags(tags);

      // Check for existing record by osm_way_ids to avoid duplicates
      if (!opts.dryRun) {
        const { data: existing } = await supabase
          .from("trails")
          .select("id")
          .contains("osm_way_ids", [String(way.id)])
          .maybeSingle();
        if (existing) { skipped++; continue; }
      }

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

      if (opts.dryRun) {
        console.log(`  [DRY] ${name} | ${seg.distKm.toFixed(2)} km | Grade ${difficulty} | ${legal_status}`);
        inserted++;
        continue;
      }

      const row: TrailRow = {
        name,
        source: "OSM-UK",
        terrain: "trail",
        difficulty,
        distance_km: Math.round(seg.distKm * 100) / 100,
        path_geojson: geojson,
        is_public: true,
        bbox_min_lat: bbox.minLat,
        bbox_max_lat: bbox.maxLat,
        bbox_min_lng: bbox.minLng,
        bbox_max_lng: bbox.maxLng,
        legal_status,
        legal_confidence,
        legal_source: "OpenStreetMap",
        osm_way_ids: [String(way.id)],
        verification_status: "approved",
      };

      const { error } = await supabase.from("trails").insert(row as never);
      if (error) {
        console.error(`  Error inserting ${name}: ${error.message}`);
        errors++;
      } else {
        inserted++;
      }
    }
  }

  return { queried: ways.length, segments, inserted, skipped, errors };
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

  // Verify Overpass connectivity before doing anything else.
  await testOverpassConnectivity();

  const supabaseUrl = process.env["SUPABASE_URL"];
  const supabaseKey = process.env["SUPABASE_SERVICE_ROLE_KEY"];
  if (!supabaseUrl || !supabaseKey) {
    console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
    process.exit(1);
  }

  const supabase = createClient(supabaseUrl, supabaseKey, {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
  });

  const regionKeys = opts.region === "all"
    ? Object.keys(REGIONS)
    : [opts.region];

  let totalQueried = 0, totalSegments = 0, totalInserted = 0, totalSkipped = 0, totalErrors = 0;

  for (const regionKey of regionKeys) {
    const result = await importRegion(regionKey, opts, supabase);
    totalQueried += result.queried;
    totalSegments += result.segments;
    totalInserted += result.inserted;
    totalSkipped += result.skipped;
    totalErrors += result.errors;
  }

  console.log("\n=== Summary ===");
  console.log(`Ways queried:   ${totalQueried}`);
  console.log(`Segments:       ${totalSegments}`);
  console.log(`Inserted:       ${totalInserted}`);
  console.log(`Skipped (dup):  ${totalSkipped}`);
  console.log(`Errors:         ${totalErrors}`);
}

main().catch(err => { console.error(err); process.exit(1); });
