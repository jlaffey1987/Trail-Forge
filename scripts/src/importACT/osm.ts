import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Minimal Overpass client used by the ACT importer to classify each
 * sampled point along a day-track as `tarmac` or `offroad`.
 *
 * Rate-limit / etiquette:
 *   - Tile-based caching on disk (rounded lat/lng to 0.05° ≈ 5 km).
 *   - Sequential requests with a small delay between calls.
 *   - 25 s timeout, 25 MB max body.
 *
 * The cache lives outside the importer dir (in `.local/act-osm-cache/`) so
 * we do not check externally-fetched OSM data into the repo.
 */

const OVERPASS_URL = process.env.OVERPASS_URL ?? "https://overpass-api.de/api/interpreter";
const CACHE_DIR = process.env.ACT_OSM_CACHE_DIR ?? ".local/act-osm-cache";
const REQUEST_DELAY_MS = Number(process.env.ACT_OVERPASS_DELAY_MS) || 2000;
const MAX_RETRIES = 4;
const TILE_SIZE_DEG = 0.05;

let lastRequestAt = 0;

export interface OsmHighwayWay {
  id: number;
  highway: string;
  surface: string | null;
  tracktype: string | null;
  geometry: Array<{ lat: number; lon: number }>;
}

export interface OsmTile {
  bbox: { south: number; west: number; north: number; east: number };
  ways: OsmHighwayWay[];
  fetchedAt: string;
  cached: boolean;
}

function ensureCacheDir(): void {
  if (!existsSync(CACHE_DIR)) {
    mkdirSync(CACHE_DIR, { recursive: true });
  }
}

function tileKey(lat: number, lon: number): string {
  const south = Math.floor(lat / TILE_SIZE_DEG) * TILE_SIZE_DEG;
  const west = Math.floor(lon / TILE_SIZE_DEG) * TILE_SIZE_DEG;
  // Six decimals is plenty for tile IDs at 0.05° resolution.
  return `${south.toFixed(3)}_${west.toFixed(3)}`;
}

function tileBbox(lat: number, lon: number): { south: number; west: number; north: number; east: number } {
  const south = Math.floor(lat / TILE_SIZE_DEG) * TILE_SIZE_DEG;
  const west = Math.floor(lon / TILE_SIZE_DEG) * TILE_SIZE_DEG;
  return {
    south,
    west,
    north: south + TILE_SIZE_DEG,
    east: west + TILE_SIZE_DEG,
  };
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchTileFromOverpass(
  bbox: { south: number; west: number; north: number; east: number },
): Promise<OsmHighwayWay[]> {
  const query = `[out:json][timeout:25];
(
  way["highway"](${bbox.south},${bbox.west},${bbox.north},${bbox.east});
);
out tags geom;`;

  let attempt = 0;
  let lastErr = "";
  while (attempt < MAX_RETRIES) {
    const elapsed = Date.now() - lastRequestAt;
    if (elapsed < REQUEST_DELAY_MS) {
      await sleep(REQUEST_DELAY_MS - elapsed);
    }
    lastRequestAt = Date.now();

    const res = await fetch(OVERPASS_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
        // Overpass requires a descriptive UA per fair-use policy.
        "User-Agent": "TrailForge-ACT-importer/1.0 (+https://adventurecountrytracks.com/)",
      },
      body: `data=${encodeURIComponent(query)}`,
    }).catch((err: Error) => ({ ok: false, status: 0, statusText: err.message } as Response));

    if (res.ok) {
      const json = await (res as Response).json();
      return parseOverpassJson(json);
    }
    lastErr = `HTTP ${res.status}`;
    if (res.status === 429 || res.status === 503 || res.status === 504 || res.status === 0) {
      // Rate-limited / overloaded: back off and retry.
      const backoff = Math.min(30000, 2000 * 2 ** attempt);
      await sleep(backoff);
      attempt += 1;
      continue;
    }
    // Non-retryable error.
    throw new Error(`Overpass ${lastErr}`);
  }
  throw new Error(`Overpass ${lastErr} (exhausted ${MAX_RETRIES} retries)`);
}

function parseOverpassJson(json: unknown): OsmHighwayWay[] {
  const j = json as {
    elements?: Array<{
      type: string;
      id: number;
      tags?: Record<string, string>;
      geometry?: Array<{ lat: number; lon: number }>;
    }>;
  };
  const ways: OsmHighwayWay[] = [];
  for (const el of j.elements ?? []) {
    if (el.type !== "way") continue;
    const tags = el.tags ?? {};
    const highway = tags["highway"];
    if (!highway) continue;
    ways.push({
      id: el.id,
      highway,
      surface: tags["surface"] ?? null,
      tracktype: tags["tracktype"] ?? null,
      geometry: el.geometry ?? [],
    });
  }
  return ways;
}

/**
 * Fetch the OSM tile that contains (lat, lon). Hits disk cache first; on
 * miss, fires one Overpass query and persists the result.
 */
export async function fetchTile(lat: number, lon: number): Promise<OsmTile> {
  ensureCacheDir();
  const key = tileKey(lat, lon);
  const cachePath = join(CACHE_DIR, `${key}.json`);
  if (existsSync(cachePath)) {
    try {
      const parsed = JSON.parse(readFileSync(cachePath, "utf8")) as OsmTile;
      return { ...parsed, cached: true };
    } catch {
      /* fall through and refetch */
    }
  }
  const bbox = tileBbox(lat, lon);
  const ways = await fetchTileFromOverpass(bbox);
  const tile: OsmTile = { bbox, ways, fetchedAt: new Date().toISOString(), cached: false };
  writeFileSync(cachePath, JSON.stringify(tile));
  return tile;
}

// ---------- Geometry helpers ----------

function distMeters(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Distance in meters from point P to segment AB (planar approximation; fine at < 1 km). */
function distToSegmentMeters(
  p: { lat: number; lon: number },
  a: { lat: number; lon: number },
  b: { lat: number; lon: number },
): number {
  const latRad = (p.lat * Math.PI) / 180;
  const mPerDegLat = 111_320;
  const mPerDegLon = 111_320 * Math.cos(latRad);
  const px = (p.lon - a.lon) * mPerDegLon;
  const py = (p.lat - a.lat) * mPerDegLat;
  const bx = (b.lon - a.lon) * mPerDegLon;
  const by = (b.lat - a.lat) * mPerDegLat;
  const len2 = bx * bx + by * by;
  if (len2 === 0) return Math.hypot(px, py);
  const t = Math.max(0, Math.min(1, (px * bx + py * by) / len2));
  const cx = bx * t;
  const cy = by * t;
  return Math.hypot(px - cx, py - cy);
}

export interface NearestWay {
  way: OsmHighwayWay;
  distanceMeters: number;
}

/**
 * Return the OSM `highway=*` way closest to `point`, within `maxMeters`.
 * `null` when nothing close enough was found.
 */
export function nearestHighwayWay(
  point: { lat: number; lon: number },
  ways: OsmHighwayWay[],
  maxMeters: number,
): NearestWay | null {
  let best: NearestWay | null = null;
  for (const w of ways) {
    const geom = w.geometry;
    if (geom.length < 2) continue;
    let minD = Infinity;
    for (let i = 1; i < geom.length; i += 1) {
      const d = distToSegmentMeters(point, geom[i - 1], geom[i]);
      if (d < minD) minD = d;
      if (minD === 0) break;
    }
    if (minD <= maxMeters && (!best || minD < best.distanceMeters)) {
      best = { way: w, distanceMeters: minD };
    }
  }
  return best;
}

/**
 * Aggregate ways from the tile containing `point` + the 1–3 neighbouring
 * tiles needed to cover any way that might be near a tile boundary.
 *
 * In practice we only fetch the neighbour tiles when the point sits within
 * `EDGE_BAND_DEG` of a tile edge — most samples need a single tile fetch.
 * This is the dominant cost-saver vs. blindly fetching a 3×3 grid.
 */
export async function fetchNeighbourhoodWays(
  point: { lat: number; lon: number },
): Promise<OsmHighwayWay[]> {
  const EDGE_BAND_DEG = 0.0008; // ~90 m
  const south = Math.floor(point.lat / TILE_SIZE_DEG) * TILE_SIZE_DEG;
  const west = Math.floor(point.lon / TILE_SIZE_DEG) * TILE_SIZE_DEG;
  const dLatTop = south + TILE_SIZE_DEG - point.lat;
  const dLatBottom = point.lat - south;
  const dLonRight = west + TILE_SIZE_DEG - point.lon;
  const dLonLeft = point.lon - west;

  const seen = new Set<string>();
  const out: OsmHighwayWay[] = [];
  const visit = async (lat: number, lon: number): Promise<void> => {
    const key = tileKey(lat, lon);
    if (seen.has(key)) return;
    seen.add(key);
    const tile = await fetchTile(lat, lon);
    for (const w of tile.ways) out.push(w);
  };

  await visit(point.lat, point.lon);
  if (dLatTop < EDGE_BAND_DEG) await visit(point.lat + EDGE_BAND_DEG * 2, point.lon);
  if (dLatBottom < EDGE_BAND_DEG) await visit(point.lat - EDGE_BAND_DEG * 2, point.lon);
  if (dLonRight < EDGE_BAND_DEG) await visit(point.lat, point.lon + EDGE_BAND_DEG * 2);
  if (dLonLeft < EDGE_BAND_DEG) await visit(point.lat, point.lon - EDGE_BAND_DEG * 2);
  return out;
}

// ---------- Surface classification ----------

const TARMAC_HIGHWAYS = new Set([
  "motorway",
  "motorway_link",
  "trunk",
  "trunk_link",
  "primary",
  "primary_link",
  "secondary",
  "secondary_link",
  "tertiary",
  "tertiary_link",
  "unclassified",
  "residential",
  "living_street",
  "service",
]);

const OFFROAD_HIGHWAYS = new Set([
  "track",
  "path",
  "bridleway",
  "cycleway",
  "footway",
]);

const PAVED_SURFACES = new Set([
  "paved",
  "asphalt",
  "concrete",
  "concrete:plates",
  "concrete:lanes",
  "paving_stones",
  "sett",
  "cobblestone",
  "metal",
  "chipseal",
]);

const UNPAVED_SURFACES = new Set([
  "unpaved",
  "compacted",
  "fine_gravel",
  "gravel",
  "pebblestone",
  "ground",
  "dirt",
  "earth",
  "grass",
  "mud",
  "sand",
  "rock",
  "stone",
  "wood",
  "woodchips",
]);

export type SurfaceClass = "tarmac" | "offroad" | "unknown";

export function classifyWay(way: OsmHighwayWay | null): SurfaceClass {
  if (!way) return "unknown";
  const surface = (way.surface ?? "").toLowerCase();
  if (UNPAVED_SURFACES.has(surface)) return "offroad";
  if (PAVED_SURFACES.has(surface)) return "tarmac";
  if (OFFROAD_HIGHWAYS.has(way.highway)) return "offroad";
  if (TARMAC_HIGHWAYS.has(way.highway)) return "tarmac";
  return "unknown";
}

export { distMeters };
