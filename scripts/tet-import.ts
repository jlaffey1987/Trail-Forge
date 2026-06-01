/**
 * TET GPX Import Script
 * =====================
 * Imports official Trans Euro Trail GPX files into the TrailForge database.
 *
 * USAGE:
 *   npx tsx scripts/tet-import.ts [file.gpx ...] [flags]
 *
 * FLAGS:
 *   --dry-run          Preview what would be imported without writing to DB
 *   --skip-ai          Use keyword terrain detection only
 *   --source <label>   Override source tag (default: TET-UK)
 *   --use-osrm         Fetch actual road routes for liaison connectors via OSRM
 *                      (requires internet; adds ~0.1s/road section; default: off)
 *
 * NAMING POLICY:
 *   Section names are preserved EXACTLY as the TET organisation named them in
 *   the GPX file.  TrailForge never renames or translates TET route names.
 *   When a source <trk> is split into multiple sections, "— Section N" is
 *   appended as the only TrailForge-added suffix.
 *
 * WHAT IT DOES:
 *   - Deduplicates consecutive GPS points and checks section quality
 *   - Splits each <trk> into off-road sections wherever consecutive points
 *     are > 500 m apart (road/liaison crossings)
 *   - Merges sections < 0.5 km with a neighbour; discards any still < 0.1 km
 *   - Preserves original TET track names exactly; adds "— Section N" suffix
 *     only when a single track produces multiple sections
 *   - Road liaison connectors optionally routed via OSRM for map accuracy
 *   - Extracts elevation gain/loss, centroid, start/end coords per section
 *   - Tags: source, tet_track (exact original name), tet_section_number, is_seasonal
 *   - Road sections: terrain="road", shown as grey dashed connectors in-app
 *
 * DB MIGRATION (run once before first import):
 *   ALTER TABLE trails
 *     ADD COLUMN IF NOT EXISTS start_lat     DOUBLE PRECISION,
 *     ADD COLUMN IF NOT EXISTS start_lon     DOUBLE PRECISION,
 *     ADD COLUMN IF NOT EXISTS end_lat       DOUBLE PRECISION,
 *     ADD COLUMN IF NOT EXISTS end_lon       DOUBLE PRECISION,
 *     ADD COLUMN IF NOT EXISTS elevation_loss_m INT,
 *     ADD COLUMN IF NOT EXISTS tet_track     TEXT,
 *     ADD COLUMN IF NOT EXISTS tet_section_number INT,
 *     ADD COLUMN IF NOT EXISTS is_seasonal   BOOLEAN DEFAULT FALSE,
 *     ADD COLUMN IF NOT EXISTS flagged_for_review BOOLEAN DEFAULT FALSE,
 *     ADD COLUMN IF NOT EXISTS flag_reasons  TEXT[];
 */

import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import { createClient } from "@supabase/supabase-js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---------------------------------------------------------------------------
// Env helpers
// ---------------------------------------------------------------------------

function getEnv(key: string): string {
  const val = process.env[key];
  if (!val) {
    console.error(`❌ Missing environment variable: ${key}`);
    console.error(`   Set it in artifacts/api-server/.env.local`);
    process.exit(1);
  }
  return val;
}

/**
 * Decode a JWT payload and return it as a plain object.
 * We don't verify the signature — we only need the claims for a startup check.
 */
function decodeJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const padded = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const json = Buffer.from(padded, "base64").toString("utf8");
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Abort with a clear message if the key is an anon key.
 *
 * Supabase issues two styles of service-role key:
 *   - Legacy JWT  — three base64url segments; payload contains `"role":"service_role"`
 *   - Modern secret — starts with `sb_secret_` or `sbp_` prefix (no JWT structure)
 *
 * Anon JWTs contain `"role":"anon"` — they respect Row Level Security and
 * cannot write to tables that lack explicit INSERT policies (like `trails`).
 */
function assertServiceRoleKey(key: string): void {
  // Modern Supabase secret key formats — these always bypass RLS.
  if (key.startsWith("sb_secret_") || key.startsWith("sbp_")) {
    console.log(`✅ Key type: service_role secret (RLS bypass confirmed)`);
    return;
  }

  // Try to decode as a legacy JWT.
  const payload = decodeJwtPayload(key);
  if (!payload) {
    console.warn("⚠️  SUPABASE_SERVICE_ROLE_KEY is not a recognised format (expected JWT or sb_secret_/sbp_ prefix).");
    console.warn("   If imports fail with RLS errors, get the service_role key from:");
    console.warn("   Supabase dashboard → Project Settings → API → service_role secret");
    return;
  }

  const role = payload["role"];
  if (role === "anon") {
    console.error("❌ SUPABASE_SERVICE_ROLE_KEY contains an ANON key (role=anon).");
    console.error("   This key respects Row Level Security and cannot insert trails.");
    console.error("   Copy the SERVICE ROLE key from:");
    console.error("   Supabase dashboard → Project Settings → API → service_role secret");
    console.error("   and set SUPABASE_SERVICE_ROLE_KEY in artifacts/api-server/.env.local");
    process.exit(1);
  }
  if (role !== "service_role") {
    console.warn(`⚠️  SUPABASE_SERVICE_ROLE_KEY has unexpected role="${role}". Proceeding, but if you see RLS errors, check this key.`);
  } else {
    console.log(`✅ Key type: service_role (RLS bypass confirmed)`);
  }
}

function loadEnvLocal() {
  const candidates = [
    path.join(process.cwd(), ".env.local"),
    path.join(process.cwd(), "artifacts", "api-server", ".env.local"),
    path.join(__dirname, "..", ".env.local"),
    path.join(__dirname, "..", "artifacts", "api-server", ".env.local"),
  ];
  let loaded = false;
  for (const envPath of candidates) {
    if (!fs.existsSync(envPath)) continue;
    for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      const k = trimmed.slice(0, eq).trim();
      const v = trimmed.slice(eq + 1).trim();
      if (!process.env[k]) process.env[k] = v;
    }
    console.log(`✅ Loaded env from: ${envPath}`);
    loaded = true;
  }
  if (!loaded) console.warn("⚠️  No .env.local found — using environment variables only.");
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Points > this far apart are treated as a road/liaison crossing. */
const GAP_THRESHOLD_KM = 0.5;
/** Trail sections shorter than this are merged with a neighbour. */
const MERGE_MIN_KM = 0.5;
/** Sections still shorter than this after merging are discarded. */
const DISCARD_MIN_KM = 0.1;
/** Nominatim usage policy: max 1 request / second. */
const NOMINATIM_DELAY_MS = 1150;
/** Cache geocoding by rounding to this many decimal places (~1 km cells). */
const GEO_CACHE_PRECISION = 2;
const NOMINATIM_BASE = "https://nominatim.openstreetmap.org";
const OSRM_BASE = "http://router.project-osrm.org";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TrackPoint {
  lat: number;
  lon: number;
  ele?: number;
}

interface QualityFlag {
  level: "info" | "warn";
  reason: string;
}

interface ParsedTrack {
  // Core
  name: string;
  type: string | null;
  terrain: "trail" | "road";
  points: TrackPoint[];
  distanceKm: number;
  gpxData: string;

  // Bounding box
  bboxMinLat: number;
  bboxMaxLat: number;
  bboxMinLon: number;
  bboxMaxLon: number;

  // Geometry
  startLat: number;
  startLon: number;
  endLat: number;
  endLon: number;
  centroidLat: number;
  centroidLon: number;

  // Elevation
  elevationGainM: number;
  elevationLossM: number;
  hasElevationData: boolean;

  // TET metadata
  tetTrackName: string;       // exact original GPX track name, e.g. "TET_UK-03-Great Northern Trail_20250704"
  tetSectionNumber: number;   // sequential within this source track
  isSeasonal: boolean;

  // Quality
  qualityFlags: QualityFlag[];
}

interface RawSection {
  points: TrackPoint[];
  distanceKm: number;
}

interface ParseStats {
  sourceTrackCount: number;
  gapsFound: number;
  mergeCount: number;
  discardCount: number;
  roadSectionCount: number;
  duplicatePointsRemoved: number;
  sectionsWithElevation: number;
  sectionsWithFlags: number;
}

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function polylineDistanceKm(pts: TrackPoint[]): number {
  let d = 0;
  for (let i = 1; i < pts.length; i++) {
    d += haversineKm(pts[i - 1].lat, pts[i - 1].lon, pts[i].lat, pts[i].lon);
  }
  return d;
}

function computeBbox(pts: TrackPoint[]) {
  let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
  for (const p of pts) {
    if (p.lat < minLat) minLat = p.lat;
    if (p.lat > maxLat) maxLat = p.lat;
    if (p.lon < minLon) minLon = p.lon;
    if (p.lon > maxLon) maxLon = p.lon;
  }
  return { minLat, maxLat, minLon, maxLon };
}

function computeCentroid(pts: TrackPoint[]): { lat: number; lon: number } {
  const lat = pts.reduce((s, p) => s + p.lat, 0) / pts.length;
  const lon = pts.reduce((s, p) => s + p.lon, 0) / pts.length;
  return { lat, lon };
}

/**
 * Compute elevation gain and loss by walking the elevation profile.
 * Applies a 1 m noise floor to ignore GPS rounding artefacts.
 */
function computeElevation(pts: TrackPoint[]): {
  gainM: number;
  lossM: number;
  hasData: boolean;
} {
  const withEle = pts.filter((p) => p.ele != null);
  if (withEle.length < 2) return { gainM: 0, lossM: 0, hasData: false };
  let gain = 0, loss = 0;
  for (let i = 1; i < pts.length; i++) {
    if (pts[i].ele == null || pts[i - 1].ele == null) continue;
    const diff = pts[i].ele! - pts[i - 1].ele!;
    if (diff > 1) gain += diff;
    else if (diff < -1) loss += Math.abs(diff);
  }
  return { gainM: Math.round(gain), lossM: Math.round(loss), hasData: true };
}

/**
 * Remove consecutive duplicate points (same coordinate to 5 decimal places ≈ 1 m).
 */
function deduplicatePoints(pts: TrackPoint[]): {
  points: TrackPoint[];
  removed: number;
} {
  if (pts.length === 0) return { points: [], removed: 0 };
  const out: TrackPoint[] = [pts[0]];
  let removed = 0;
  for (let i = 1; i < pts.length; i++) {
    const prev = out[out.length - 1];
    if (
      Math.abs(pts[i].lat - prev.lat) > 0.00001 ||
      Math.abs(pts[i].lon - prev.lon) > 0.00001
    ) {
      out.push(pts[i]);
    } else {
      removed++;
    }
  }
  return { points: out, removed };
}

// ---------------------------------------------------------------------------
// Quality checks
// ---------------------------------------------------------------------------

function checkQuality(pts: TrackPoint[], distanceKm: number): QualityFlag[] {
  const flags: QualityFlag[] = [];

  // Point density — very sparse sections may have lost detail
  const ptsPerKm = pts.length / Math.max(distanceKm, 0.01);
  if (ptsPerKm < 2 && distanceKm > 1) {
    flags.push({
      level: "info",
      reason: `Low point density (${ptsPerKm.toFixed(1)} pts/km) — section may be over-simplified`,
    });
  }

  // A jump inside a section that exceeds the split threshold means this section
  // was merged across a road crossing — flag it so it can be reviewed on the map.
  // Normal TET waypoint spacing (100–490 m) is intentionally below this threshold.
  let maxGapM = 0;
  for (let i = 1; i < pts.length; i++) {
    const d = haversineKm(pts[i - 1].lat, pts[i - 1].lon, pts[i].lat, pts[i].lon) * 1000;
    if (d > maxGapM) maxGapM = d;
  }
  if (maxGapM > GAP_THRESHOLD_KM * 1000) {
    flags.push({
      level: "warn",
      reason: `Contains merged road gap: ${maxGapM.toFixed(0)} m jump (section merged across a road crossing)`,
    });
  }

  // Suspicious elevation jump (> 200 m between adjacent points)
  for (let i = 1; i < pts.length; i++) {
    if (pts[i].ele == null || pts[i - 1].ele == null) continue;
    const jump = Math.abs(pts[i].ele! - pts[i - 1].ele!);
    if (jump > 200) {
      flags.push({
        level: "warn",
        reason: `Suspicious elevation jump: ${jump.toFixed(0)} m — possible GPS error`,
      });
      break;
    }
  }

  return flags;
}

// ---------------------------------------------------------------------------
// Terrain detection (for source tracks without gaps)
// ---------------------------------------------------------------------------

function detectTerrain(name: string, type: string | null): "trail" | "road" {
  const combined = `${name} ${type ?? ""}`.toLowerCase();
  const roadKw = ["road", "tarmac", "asphalt", "paved", "liaison", "transfer", "route"];
  if (roadKw.some((kw) => combined.includes(kw))) return "road";
  const trailKw = ["trail", "track", "offroad", "off-road", "gravel", "dirt", "lane", "byway", "boat", "green"];
  if (trailKw.some((kw) => combined.includes(kw))) return "trail";
  return "trail";
}

// ---------------------------------------------------------------------------
// Section splitting and merging
// ---------------------------------------------------------------------------

/**
 * Walk through `points` and split wherever consecutive points are > GAP_THRESHOLD_KM
 * apart.  Returns:
 *   trailSections — runs of closely-spaced points (off-road sections)
 *   roadSections  — 2-point connectors bridging each gap (road liaisons)
 */
function splitAtGaps(points: TrackPoint[]): {
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
      points[i].lat,     points[i].lon,
    );
    if (dist > GAP_THRESHOLD_KM) {
      gapCount++;
      if (run.length >= 2) {
        trailSections.push({ points: run, distanceKm: polylineDistanceKm(run) });
      }
      roadSections.push({ points: [points[i - 1], points[i]], distanceKm: dist });
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

/**
 * Merge sections shorter than MERGE_MIN_KM into a neighbour (prefers the
 * shorter neighbour to keep section lengths balanced).  Sections still under
 * DISCARD_MIN_KM after merging are dropped.
 */
function mergeShortSections(rawSections: RawSection[]): {
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

// ---------------------------------------------------------------------------
// GPX point extraction and single-track builder
// ---------------------------------------------------------------------------

function extractTrackPoints(trkContent: string): TrackPoint[] {
  const m1 = [...trkContent.matchAll(/<trkpt\s+lat="([^"]+)"\s+lon="([^"]+)"[^>]*>([\s\S]*?)<\/trkpt>/g)];
  if (m1.length > 0) {
    return m1.flatMap((m) => {
      const lat = parseFloat(m[1]);
      const lon = parseFloat(m[2]);
      if (isNaN(lat) || isNaN(lon)) return [];
      const eleM = m[3].match(/<ele>([\d.-]+)<\/ele>/);
      return [{ lat, lon, ele: eleM ? parseFloat(eleM[1]) : undefined }];
    });
  }
  // Fallback: lon-first attribute order
  const m2 = [...trkContent.matchAll(/<trkpt\s+lon="([^"]+)"\s+lat="([^"]+)"[^>]*>([\s\S]*?)<\/trkpt>/g)];
  return m2.flatMap((m) => {
    const lon = parseFloat(m[1]);
    const lat = parseFloat(m[2]);
    if (isNaN(lat) || isNaN(lon)) return [];
    const eleM = m[3].match(/<ele>([\d.-]+)<\/ele>/);
    return [{ lat, lon, ele: eleM ? parseFloat(eleM[1]) : undefined }];
  });
}

function buildSingleTrackGpx(name: string, type: string | null, points: TrackPoint[]): string {
  const trkpts = points
    .map((p) => {
      const ele = p.ele != null ? `<ele>${p.ele}</ele>` : "";
      return `    <trkpt lat="${p.lat}" lon="${p.lon}">${ele}</trkpt>`;
    })
    .join("\n");
  const typeTag = type ? `<type>${type}</type>` : "";
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="TrailForge TET Import">
  <trk>
    <name>${name.replace(/&/g, "&amp;")}</name>
    ${typeTag}
    <trkseg>
${trkpts}
    </trkseg>
  </trk>
</gpx>`;
}

// ---------------------------------------------------------------------------
// TET name helpers
// ---------------------------------------------------------------------------

/**
 * Extract the human-readable trail name from TET's file naming convention.
 * "TET_UK-03-Great Northern Trail_20250704" → "Great Northern Trail"
 */
function extractTrackBaseName(rawName: string): string {
  const m = rawName.match(/^TET_UK-\d+-(.+?)(?:_\d{6,8})?$/i);
  if (m) return m[1].replace(/_/g, " ").trim();
  return rawName.replace(/_\d{6,8}$/, "").replace(/_/g, " ").trim();
}

function isTetSeasonal(rawName: string): boolean {
  return /seasonal/i.test(rawName);
}

// ---------------------------------------------------------------------------
// Nominatim reverse geocoding
// ---------------------------------------------------------------------------

let lastGeoRequestMs = 0;
const geoCache = new Map<string, string | null>();

function geoCacheKey(lat: number, lon: number): string {
  return `${lat.toFixed(GEO_CACHE_PRECISION)},${lon.toFixed(GEO_CACHE_PRECISION)}`;
}

async function reverseGeocode(lat: number, lon: number): Promise<string | null> {
  const key = geoCacheKey(lat, lon);
  if (geoCache.has(key)) return geoCache.get(key)!;

  const wait = NOMINATIM_DELAY_MS - (Date.now() - lastGeoRequestMs);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastGeoRequestMs = Date.now();

  try {
    const url = `${NOMINATIM_BASE}/reverse?lat=${lat}&lon=${lon}&format=json&zoom=10&accept-language=en`;
    const res = await fetch(url, {
      headers: { "User-Agent": "TrailForge-TET-Import/1.0 (https://trailforge.app)" },
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) { geoCache.set(key, null); return null; }
    const data = await res.json() as { address?: Record<string, string> };
    const addr = data.address ?? {};
    const name =
      addr.village ?? addr.hamlet ?? addr.suburb ??
      addr.town ?? addr.city ?? addr.county ?? addr.state ?? null;
    geoCache.set(key, name);
    return name;
  } catch {
    geoCache.set(key, null);
    return null;
  }
}

/**
 * Geocode all unique coordinate cells in batch (rate-limited).
 * Then walk every trail section and apply the rider-friendly name.
 *
 * NOTE: TET section names are preserved exactly as the TET organisation named
 * them — this function is retained for potential future analytics use only.
 * It never modifies section names.
 */
async function reverseGeocodeSection(lat: number, lon: number): Promise<string | null> {
  return reverseGeocode(lat, lon);
}

// ---------------------------------------------------------------------------
// OSRM road routing
// ---------------------------------------------------------------------------

/**
 * Fetch the actual road route between two points via the OSRM public API.
 * Falls back gracefully to null (straight-line connector) on any error.
 */
async function fetchOsrmRoute(
  fromLat: number, fromLon: number,
  toLat: number,   toLon: number,
): Promise<TrackPoint[] | null> {
  try {
    const url =
      `${OSRM_BASE}/route/v1/driving/${fromLon},${fromLat};${toLon},${toLat}` +
      `?geometries=geojson&overview=full`;
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return null;
    const data = await res.json() as {
      code?: string;
      routes?: Array<{ geometry?: { coordinates?: Array<[number, number]> } }>;
    };
    if (data.code !== "Ok") return null;
    const coords = data.routes?.[0]?.geometry?.coordinates;
    if (!Array.isArray(coords) || coords.length < 2) return null;
    return coords.map(([lon, lat]) => ({ lat, lon }));
  } catch {
    return null;
  }
}

/**
 * Replace every road liaison section's 2-point straight line with the actual
 * routed road path from OSRM.
 */
async function enrichRoadSectionsWithOsrm(tracks: ParsedTrack[]): Promise<void> {
  const roadTracks = tracks.filter((t) => t.terrain === "road");
  console.log(`\n🛣️  Fetching OSRM routes for ${roadTracks.length} road sections...`);

  let enriched = 0;
  let failed = 0;
  for (let i = 0; i < roadTracks.length; i++) {
    const t = roadTracks[i];
    const routed = await fetchOsrmRoute(t.startLat, t.startLon, t.endLat, t.endLon);
    if (routed && routed.length >= 2) {
      t.points = routed;
      const bbox = computeBbox(routed);
      const centroid = computeCentroid(routed);
      t.bboxMinLat = bbox.minLat; t.bboxMaxLat = bbox.maxLat;
      t.bboxMinLon = bbox.minLon; t.bboxMaxLon = bbox.maxLon;
      t.centroidLat = centroid.lat; t.centroidLon = centroid.lon;
      t.distanceKm = Math.round(polylineDistanceKm(routed) * 10) / 10;
      t.gpxData = buildSingleTrackGpx(t.name, t.type, routed);
      enriched++;
    } else {
      failed++;
    }
    if ((i + 1) % 50 === 0) {
      console.log(`   ${i + 1}/${roadTracks.length} processed...`);
    }
    // Small delay to be polite to the OSRM public instance
    await new Promise((r) => setTimeout(r, 80));
  }
  console.log(`   ✅ ${enriched} routed, ${failed} fell back to straight-line`);
}

// ---------------------------------------------------------------------------
// Main GPX file parser
// ---------------------------------------------------------------------------

function parseGpxFile(filePath: string): { tracks: ParsedTrack[]; stats: ParseStats } {
  console.log(`\n📂 Parsing: ${path.basename(filePath)}`);
  const content = fs.readFileSync(filePath, "utf8");

  const trkMatches = [...content.matchAll(/<trk>([\s\S]*?)<\/trk>/g)];
  if (trkMatches.length === 0) {
    console.warn(`  ⚠️  No <trk> elements found in ${path.basename(filePath)}`);
    return {
      tracks: [],
      stats: {
        sourceTrackCount: 0, gapsFound: 0, mergeCount: 0,
        discardCount: 0, roadSectionCount: 0,
        duplicatePointsRemoved: 0, sectionsWithElevation: 0, sectionsWithFlags: 0,
      },
    };
  }

  console.log(`  Found ${trkMatches.length} source track(s)`);

  const tracks: ParsedTrack[] = [];
  const stats: ParseStats = {
    sourceTrackCount: trkMatches.length,
    gapsFound: 0, mergeCount: 0, discardCount: 0,
    roadSectionCount: 0, duplicatePointsRemoved: 0,
    sectionsWithElevation: 0, sectionsWithFlags: 0,
  };

  for (const trkMatch of trkMatches) {
    const trkContent = trkMatch[1];

    // --- Track metadata ---
    const nameMatch = trkContent.match(/<name>([\s\S]*?)<\/name>/);
    const rawName = nameMatch
      ? nameMatch[1].trim()
          .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
      : "Unnamed TET Section";

    const typeMatch = trkContent.match(/<type>([\s\S]*?)<\/type>/);
    const type = typeMatch ? typeMatch[1].trim() : null;
    const sourceTerrain = detectTerrain(rawName, type);
    // Preserve the original TET name exactly — TrailForge never renames TET routes.
    const tetTrackName = rawName;
    const isSeasonal = isTetSeasonal(rawName);

    // --- Extract and clean points ---
    const rawPoints = extractTrackPoints(trkContent);
    if (rawPoints.length < 2) {
      console.warn(`  ⚠️  Skipping "${rawName}" — only ${rawPoints.length} point(s)`);
      continue;
    }

    const { points: cleanPoints, removed } = deduplicatePoints(rawPoints);
    stats.duplicatePointsRemoved += removed;

    if (cleanPoints.length < 2) {
      console.warn(`  ⚠️  Skipping "${rawName}" — only ${cleanPoints.length} point(s) after dedup`);
      continue;
    }

    // --- Split at road/liaison gaps ---
    const { trailSections: rawTrailSections, roadSections: rawRoadSections, gapCount } =
      splitAtGaps(cleanPoints);
    stats.gapsFound += gapCount;

    // --- Merge trail stubs ---
    const { sections: trailSections, mergeCount, discardCount } =
      mergeShortSections(rawTrailSections);
    stats.mergeCount += mergeCount;
    stats.discardCount += discardCount;
    stats.roadSectionCount += rawRoadSections.length;

    // --- Emit trail section ParsedTracks ---
    const trailTerrain = gapCount === 0 ? sourceTerrain : "trail";
    const multiSection = trailSections.length > 1;

    for (let idx = 0; idx < trailSections.length; idx++) {
      const sec = trailSections[idx];
      const sectionLabel = `Section ${idx + 1}`;
      // Geocoded name is filled in later; use fallback for now
      const name = multiSection
        ? `${tetTrackName} — ${sectionLabel}`
        : tetTrackName;

      const bbox = computeBbox(sec.points);
      const centroid = computeCentroid(sec.points);
      const elev = computeElevation(sec.points);
      const flags = checkQuality(sec.points, sec.distanceKm);
      const distanceKm = Math.round(sec.distanceKm * 10) / 10;

      if (elev.hasData) stats.sectionsWithElevation++;
      if (flags.length > 0) stats.sectionsWithFlags++;

      tracks.push({
        name,
        type,
        terrain: trailTerrain,
        points: sec.points,
        distanceKm,
        gpxData: buildSingleTrackGpx(name, type, sec.points),
        bboxMinLat: bbox.minLat, bboxMaxLat: bbox.maxLat,
        bboxMinLon: bbox.minLon, bboxMaxLon: bbox.maxLon,
        startLat: sec.points[0].lat,
        startLon: sec.points[0].lon,
        endLat:   sec.points[sec.points.length - 1].lat,
        endLon:   sec.points[sec.points.length - 1].lon,
        centroidLat: centroid.lat,
        centroidLon: centroid.lon,
        elevationGainM: elev.gainM,
        elevationLossM: elev.lossM,
        hasElevationData: elev.hasData,
        tetTrackName,
        tetSectionNumber: idx + 1,
        isSeasonal,
        qualityFlags: flags,
      });
    }

    // --- Emit road liaison connector ParsedTracks ---
    for (let idx = 0; idx < rawRoadSections.length; idx++) {
      const sec = rawRoadSections[idx];
      const name = `${tetTrackName} — Road Section ${idx + 1}`;
      const bbox = computeBbox(sec.points);
      const centroid = computeCentroid(sec.points);
      const distanceKm = Math.round(sec.distanceKm * 10) / 10;

      tracks.push({
        name,
        type,
        terrain: "road",
        points: sec.points,
        distanceKm,
        gpxData: buildSingleTrackGpx(name, type, sec.points),
        bboxMinLat: bbox.minLat, bboxMaxLat: bbox.maxLat,
        bboxMinLon: bbox.minLon, bboxMaxLon: bbox.maxLon,
        startLat: sec.points[0].lat,
        startLon: sec.points[0].lon,
        endLat:   sec.points[sec.points.length - 1].lat,
        endLon:   sec.points[sec.points.length - 1].lon,
        centroidLat: centroid.lat,
        centroidLon: centroid.lon,
        elevationGainM: 0,
        elevationLossM: 0,
        hasElevationData: false,
        tetTrackName,
        tetSectionNumber: idx + 1,
        isSeasonal: false,
        qualityFlags: [],
      });
    }
  }

  return { tracks, stats };
}

// ---------------------------------------------------------------------------
// Supabase insert
// ---------------------------------------------------------------------------

async function importTracks(
  tracks: ParsedTrack[],
  supabaseUrl: string,
  supabaseKey: string,
  sourceLabel: string,
): Promise<{ inserted: number; skipped: number; errors: number }> {
  // Service-role clients must disable the browser-oriented auth helpers so
  // the key is sent as-is on every request rather than being swapped for a
  // user session token.  Without these options the JS client can silently
  // downgrade to anon-level access and hit RLS rejections.
  const supabase = createClient(supabaseUrl, supabaseKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
      detectSessionInUrl: false,
    },
  });
  let inserted = 0, skipped = 0, errors = 0;

  for (const track of tracks) {
    const { data: existing } = await supabase
      .from("trails")
      .select("id")
      .eq("name", track.name)
      .eq("source", sourceLabel)
      .maybeSingle();

    if (existing) {
      skipped++;
      continue;
    }

    // ── Core row — columns that have existed since migration 0001/0011 ────
    // centroid_lat/lon are NOT included here; they are added by migration 0030.
    // The migration's backfill UPDATE will compute centroid from bbox for any
    // rows inserted before 0030 is applied.
    const coreRow = {
      name:             track.name,
      gpx_data:         track.gpxData,
      is_public:        true,
      owner_user_id:    null,
      distance_km:      track.distanceKm,
      terrain:          track.terrain,
      legal_status:     track.terrain === "trail" ? "TET Route" : "Road Liaison",
      source:           sourceLabel,
      bbox_min_lat:     track.bboxMinLat,
      bbox_max_lat:     track.bboxMaxLat,
      bbox_min_lng:     track.bboxMinLon,
      bbox_max_lng:     track.bboxMaxLon,
      // elevation_gain_m / elevation_loss_m added in migration 0011
      elevation_gain_m: track.elevationGainM > 0 ? track.elevationGainM : null,
      elevation_loss_m: track.elevationLossM > 0 ? track.elevationLossM : null,
    };

    // ── Extended row — all columns added in migration 0030 ────────────────
    const row = {
      ...coreRow,
      centroid_lat:       track.centroidLat,
      centroid_lon:       track.centroidLon,
      start_lat:          track.startLat,
      start_lon:          track.startLon,
      end_lat:            track.endLat,
      end_lon:            track.endLon,
      tet_track:          track.tetTrackName,
      tet_section_number: track.tetSectionNumber,
      is_seasonal:        track.isSeasonal,
      flagged_for_review: track.qualityFlags.some((f) => f.level === "warn"),
      flag_reasons:       track.qualityFlags.length > 0
                            ? track.qualityFlags.map((f) => f.reason)
                            : null,
    };

    const { error } = await supabase.from("trails").insert(row);

    if (error) {
      // Migration 0030 not yet applied — fall back to core columns only.
      // centroid will be backfilled by the migration's UPDATE statement.
      if (
        error.code === "PGRST204" ||
        error.message?.toLowerCase().includes("column") ||
        error.message?.toLowerCase().includes("schema cache")
      ) {
        const { error: coreError } = await supabase.from("trails").insert(coreRow);
        if (coreError) {
          console.error(`  ❌ Error inserting "${track.name}": ${coreError.message}`);
          errors++;
        } else {
          const icon = track.terrain === "trail" ? "🏍️" : "🛣️";
          console.log(`  ${icon} Inserted (core — run migration 0030 for full metadata): ${track.name} (${track.distanceKm}km)`);
          inserted++;
        }
      } else {
        console.error(`  ❌ Error inserting "${track.name}": ${error.message}`);
        errors++;
      }
    } else {
      const icon = track.terrain === "trail" ? "🏍️" : "🛣️";
      console.log(`  ${icon} Inserted: ${track.name} (${track.distanceKm}km, ${track.terrain})`);
      inserted++;
    }

    await new Promise((r) => setTimeout(r, 100));
  }

  return { inserted, skipped, errors };
}

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

interface CliArgs {
  files: string[];
  dryRun: boolean;
  skipAi: boolean;
  source: string;
  useOsrm: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const files: string[] = [];
  let dryRun = false, skipAi = false, useOsrm = false;
  let source = "TET-UK";

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--dry-run")       { dryRun  = true; }
    else if (arg === "--skip-ai")  { skipAi  = true; }
    else if (arg === "--use-osrm") { useOsrm = true; }
    else if (arg === "--source" || arg.startsWith("--source=")) {
      source = arg.startsWith("--source=") ? arg.slice("--source=".length) : (argv[++i] ?? source);
    } else if (arg.startsWith("--")) {
      console.warn(`⚠️  Unknown flag: ${arg} (ignored)`);
    } else {
      files.push(arg);
    }
  }
  return { files, dryRun, skipAi, source, useOsrm };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const DEFAULT_GPX = path.resolve(__dirname, "..", "GB.gpx");

async function main() {
  loadEnvLocal();

  const { files: parsedFiles, dryRun, skipAi, source, useOsrm } =
    parseArgs(process.argv.slice(2));

  let files = parsedFiles;
  if (files.length === 0) {
    if (fs.existsSync(DEFAULT_GPX)) {
      console.log(`ℹ️  No file specified — using default: ${DEFAULT_GPX}`);
      files = [DEFAULT_GPX];
    } else {
      console.error(
        "❌ No GPX file specified and GB.gpx not found at the project root.\n" +
        "\nUsage: npx tsx scripts/tet-import.ts [file.gpx ...] [flags]\n" +
        "  --dry-run       Preview without writing to DB\n" +
        "  --use-osrm      Route road sections via OSRM (actual roads)\n" +
        "  --skip-ai       Keyword terrain detection only\n" +
        "  --source <lbl>  Override source tag (default: TET-UK)\n" +
        `\nExpected default file: ${DEFAULT_GPX}`,
      );
      process.exit(1);
    }
  }

  console.log("🗺️  TrailForge TET Import");
  console.log("========================");
  console.log(`🏷️  Source label:  ${source}`);
  if (dryRun)   console.log("🔍 DRY RUN — no data will be written to the database");
  if (skipAi)  console.log("⏭️  --skip-ai set");
  if (useOsrm) console.log("🛣️  --use-osrm set — will route road sections via OSRM");

  // ── 1. Parse GPX files ──────────────────────────────────────────────────
  const allTracks: ParsedTrack[] = [];
  const globalStats: ParseStats = {
    sourceTrackCount: 0, gapsFound: 0, mergeCount: 0, discardCount: 0,
    roadSectionCount: 0, duplicatePointsRemoved: 0,
    sectionsWithElevation: 0, sectionsWithFlags: 0,
  };

  for (const filePath of files) {
    if (!fs.existsSync(filePath)) { console.error(`❌ File not found: ${filePath}`); continue; }
    const { tracks, stats } = parseGpxFile(filePath);
    allTracks.push(...tracks);
    for (const k of Object.keys(globalStats) as (keyof ParseStats)[]) {
      globalStats[k] += stats[k];
    }
  }

  if (allTracks.length === 0) {
    console.error("❌ No tracks found in any GPX file");
    process.exit(1);
  }

  // ── 2. OSRM routing for road sections ──────────────────────────────────
  if (useOsrm && !dryRun) await enrichRoadSectionsWithOsrm(allTracks);

  // ── 3. Statistics ────────────────────────────────────────────────────────
  const trailSections = allTracks.filter((t) => t.terrain === "trail");
  const roadSections  = allTracks.filter((t) => t.terrain === "road");
  const seasonal      = trailSections.filter((t) => t.isSeasonal);
  const flagged       = trailSections.filter((t) => t.qualityFlags.some((f) => f.level === "warn"));

  const totalTrailKm  = trailSections.reduce((s, t) => s + t.distanceKm, 0);
  const avgKm         = trailSections.length > 0 ? totalTrailKm / trailSections.length : 0;
  const shortest      = trailSections.reduce((m, t) => t.distanceKm < m ? t.distanceKm : m, Infinity);
  const longest       = trailSections.reduce((m, t) => t.distanceKm > m ? t.distanceKm : m, 0);
  const shortestT     = trailSections.find((t) => t.distanceKm === shortest);
  const longestT      = trailSections.find((t) => t.distanceKm === longest);

  console.log(`\n📊 Parsing quality:`);
  console.log(`   Source tracks parsed:        ${globalStats.sourceTrackCount}`);
  console.log(`   Duplicate points removed:    ${globalStats.duplicatePointsRemoved}`);
  console.log(`   Road gaps detected:          ${globalStats.gapsFound}`);
  console.log(`   Stub sections merged:        ${globalStats.mergeCount}`);
  console.log(`   Sections discarded (tiny):   ${globalStats.discardCount}`);

  console.log(`\n📊 Trail sections:`);
  console.log(`   🏍️  Count:                  ${trailSections.length}`);
  console.log(`   📏  Total distance:          ${totalTrailKm.toFixed(1)} km`);
  console.log(`   📐  Average length:          ${avgKm.toFixed(1)} km`);
  console.log(`   📉  Shortest:                ${isFinite(shortest) ? shortest.toFixed(2) : "—"} km — "${shortestT?.name ?? ""}"`);
  console.log(`   📈  Longest:                 ${longest.toFixed(1)} km — "${longestT?.name ?? ""}"`);
  console.log(`   ⛰️  With elevation data:     ${globalStats.sectionsWithElevation} / ${trailSections.length}`);
  console.log(`   🚩  Flagged for review:      ${flagged.length}`);
  console.log(`   🍂  Seasonal sections:       ${seasonal.length}`);

  console.log(`\n📊 Road sections:`);
  console.log(`   🛣️  Count:                  ${roadSections.length}`);
  console.log(`   📦  Total to import:         ${allTracks.length}`);

  if (dryRun) {
    console.log("\n🔍 DRY RUN — example section names:\n");
    const examples = trailSections.slice(0, 20);
    for (const t of examples) {
      const elev = t.hasElevationData ? ` ↑${t.elevationGainM}m` : "";
      const flag = t.qualityFlags.some((f) => f.level === "warn") ? " ⚠️" : "";
      const seas = t.isSeasonal ? " 🍂" : "";
      console.log(`  🏍️  ${t.name}  (${t.distanceKm}km${elev}${flag}${seas})`);
    }
    if (trailSections.length > 20) {
      console.log(`  … and ${trailSections.length - 20} more trail sections`);
    }
    console.log();
    for (const t of roadSections.slice(0, 5)) {
      console.log(`  🛣️  ${t.name}  (${t.distanceKm}km)`);
    }
    if (roadSections.length > 5) {
      console.log(`  … and ${roadSections.length - 5} more road sections`);
    }

    if (flagged.length > 0) {
      console.log(`\n⚠️  Sections flagged for review:`);
      for (const t of flagged.slice(0, 10)) {
        for (const f of t.qualityFlags.filter((f) => f.level === "warn")) {
          console.log(`   ${t.name}: ${f.reason}`);
        }
      }
    }

    console.log(
      `\n✅ Dry run complete — ${trailSections.length} trail + ${roadSections.length} road = ${allTracks.length} total.` +
      `\n   Remove --dry-run to import.` +
      (!useOsrm ? `\n   Add --use-osrm for actual road routes on connectors.` : ""),
    );
    return;
  }

  // ── 4. Import ────────────────────────────────────────────────────────────
  const supabaseUrl = getEnv("SUPABASE_URL");
  const supabaseKey = getEnv("SUPABASE_SERVICE_ROLE_KEY");

  // Fail fast if someone has accidentally pasted the anon key here.
  assertServiceRoleKey(supabaseKey);

  console.log(`\n📡 Supabase: ${supabaseUrl}`);
  console.log(`\nReady to import ${allTracks.length} sections. Starting in 3 seconds... (Ctrl+C to cancel)\n`);
  await new Promise((r) => setTimeout(r, 3000));

  const result = await importTracks(allTracks, supabaseUrl, supabaseKey, source);

  console.log("\n========================");
  console.log("✅ Import complete!");
  console.log(`   Inserted: ${result.inserted}`);
  console.log(`   Skipped (duplicates): ${result.skipped}`);
  console.log(`   Errors: ${result.errors}`);
  if (result.errors > 0) {
    console.log("\n⚠️  Some inserts failed — check the DB migration in the script header.");
  }
  console.log("\nThe map should now show TET trails.");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
