/**
 * Offline trail store for the TrailForge mobile app.
 *
 * Persists trail geometry + metadata to AsyncStorage so saved routes
 * remain viewable without an internet connection. Each entry is keyed by
 * trail ID and stores a compact snapshot sufficient to render polylines
 * and show the info sheet.
 *
 * Storage layout (AsyncStorage):
 *   "trailforge:offline:index"         → OfflineIndex  (all saved trail IDs + sizes)
 *   "trailforge:offline:trail:<id>"    → OfflineTrail  (trail data)
 *
 * Tile caching uses expo-file-system. Tiles are stored at:
 *   <documentDirectory>/trailforge/tiles/<z>/<x>/<y>.jpg
 *
 * NOTE: react-native-maps does NOT support loading tiles from the local
 * file system via a custom URL template on stock iOS/Android without native
 * customisation. The tile download functions here build the file-system
 * infrastructure so a future native tile overlay (Mapbox SDK, RN-Maps fork,
 * or a WebView tile proxy) can consume them. For now they improve cold-load
 * performance by pre-fetching tiles that would otherwise need to stream.
 */

import AsyncStorage from "@react-native-async-storage/async-storage";
import * as FileSystem from "expo-file-system/legacy";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface OfflineTrailPoint {
  lat: number;
  lon: number;
  alt?: number;
}

export interface OfflineTrail {
  id: string;
  name: string;
  difficulty: string | null;
  distance_km: number | null;
  /** Compressed polyline — array of [lon, lat] pairs. */
  path: Array<[number, number]>;
  altitudes?: number[];
  legal_status?: string | null;
  terrain?: string | null;
  savedAt: number;
  /** Bounding box for quick region computation. */
  bbox: { minLat: number; maxLat: number; minLon: number; maxLon: number };
  /** Approximate storage size in bytes. */
  sizeBytes: number;
}

export interface OfflineIndex {
  trailIds: string[];
  totalSizeBytes: number;
  lastUpdated: number;
}

// ---------------------------------------------------------------------------
// Storage keys
// ---------------------------------------------------------------------------

const INDEX_KEY = "trailforge:offline:index";
const trailKey = (id: string) => `trailforge:offline:trail:${id}`;

// ---------------------------------------------------------------------------
// Index helpers
// ---------------------------------------------------------------------------

async function readIndex(): Promise<OfflineIndex> {
  try {
    const raw = await AsyncStorage.getItem(INDEX_KEY);
    if (!raw) return { trailIds: [], totalSizeBytes: 0, lastUpdated: 0 };
    return JSON.parse(raw) as OfflineIndex;
  } catch {
    return { trailIds: [], totalSizeBytes: 0, lastUpdated: 0 };
  }
}

async function writeIndex(idx: OfflineIndex): Promise<void> {
  await AsyncStorage.setItem(INDEX_KEY, JSON.stringify(idx));
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

/** Save a trail for offline use. Idempotent — re-saves replace. */
export async function saveTrailOffline(
  trail: Omit<OfflineTrail, "savedAt" | "sizeBytes">,
): Promise<void> {
  const serialised = JSON.stringify(trail);
  const sizeBytes = new TextEncoder().encode(serialised).length;
  const entry: OfflineTrail = { ...trail, savedAt: Date.now(), sizeBytes };
  await AsyncStorage.setItem(trailKey(trail.id), JSON.stringify(entry));

  const idx = await readIndex();
  if (!idx.trailIds.includes(trail.id)) {
    idx.trailIds.push(trail.id);
    idx.totalSizeBytes += sizeBytes;
  } else {
    // Replace — recompute totalSizeBytes (best-effort; may drift slightly).
    idx.totalSizeBytes = Math.max(0, idx.totalSizeBytes - sizeBytes + sizeBytes);
  }
  idx.lastUpdated = Date.now();
  await writeIndex(idx);
}

/** Load a single offline trail by ID. Returns null if not saved. */
export async function getOfflineTrail(id: string): Promise<OfflineTrail | null> {
  try {
    const raw = await AsyncStorage.getItem(trailKey(id));
    if (!raw) return null;
    return JSON.parse(raw) as OfflineTrail;
  } catch {
    return null;
  }
}

/** List all offline trails (full data). */
export async function listOfflineTrails(): Promise<OfflineTrail[]> {
  const idx = await readIndex();
  const results = await Promise.all(idx.trailIds.map(getOfflineTrail));
  return results.filter((t): t is OfflineTrail => t != null);
}

/** Remove a single trail from offline storage. */
export async function removeOfflineTrail(id: string): Promise<void> {
  const existing = await getOfflineTrail(id);
  await AsyncStorage.removeItem(trailKey(id));
  const idx = await readIndex();
  idx.trailIds = idx.trailIds.filter((x) => x !== id);
  if (existing) {
    idx.totalSizeBytes = Math.max(0, idx.totalSizeBytes - existing.sizeBytes);
  }
  idx.lastUpdated = Date.now();
  await writeIndex(idx);
}

/** Remove all offline trails + tiles. */
export async function clearAllOffline(): Promise<void> {
  const idx = await readIndex();
  const keys = [INDEX_KEY, ...idx.trailIds.map(trailKey)];
  await AsyncStorage.multiRemove(keys);
  await removeTileCache();
}

/** Return storage usage stats. */
export async function getOfflineStorageStats(): Promise<{
  trailCount: number;
  trailSizeBytes: number;
  tileSizeBytes: number;
  totalSizeBytes: number;
}> {
  const idx = await readIndex();
  const tileSizeBytes = await getTileCacheSize();
  return {
    trailCount: idx.trailIds.length,
    trailSizeBytes: idx.totalSizeBytes,
    tileSizeBytes,
    totalSizeBytes: idx.totalSizeBytes + tileSizeBytes,
  };
}

/** True if the given trail ID is saved offline. */
export async function isTrailSavedOffline(id: string): Promise<boolean> {
  const idx = await readIndex();
  return idx.trailIds.includes(id);
}

// ---------------------------------------------------------------------------
// Tile cache (expo-file-system)
// ---------------------------------------------------------------------------

const TILE_BASE_DIR =
  (FileSystem.documentDirectory ?? "") + "trailforge/tiles/";

/** Tile provider: OpenTopoMap (free, topo overlay, good for off-road). */
export const TILE_URL_TEMPLATE =
  "https://a.tile.opentopomap.org/{z}/{x}/{y}.png";

/** Tile zoom levels to cache. Lower range = fewer files, still useful offline. */
const TILE_ZOOM_RANGE = [10, 11, 12, 13] as const;

function tileFilePath(z: number, x: number, y: number): string {
  return `${TILE_BASE_DIR}${z}/${x}/${y}.jpg`;
}

function tileUrl(z: number, x: number, y: number): string {
  return TILE_URL_TEMPLATE.replace("{z}", String(z))
    .replace("{x}", String(x))
    .replace("{y}", String(y));
}

/**
 * Convert lat/lon to OSM tile coordinates at a given zoom level.
 * https://wiki.openstreetmap.org/wiki/Slippy_map_tilenames
 */
function latLonToTile(lat: number, lon: number, zoom: number): { x: number; y: number } {
  const n = Math.pow(2, zoom);
  const x = Math.floor(((lon + 180) / 360) * n);
  const latRad = (lat * Math.PI) / 180;
  const y = Math.floor(((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n);
  return { x, y };
}

/**
 * Enumerate all tile coordinates needed to cover a bounding box at the
 * specified zoom levels.
 */
export function tilesToDownload(
  bbox: { minLat: number; maxLat: number; minLon: number; maxLon: number },
  zooms: readonly number[] = TILE_ZOOM_RANGE,
): Array<{ z: number; x: number; y: number }> {
  const tiles: Array<{ z: number; x: number; y: number }> = [];
  for (const z of zooms) {
    const topLeft = latLonToTile(bbox.maxLat, bbox.minLon, z);
    const bottomRight = latLonToTile(bbox.minLat, bbox.maxLon, z);
    for (let x = topLeft.x; x <= bottomRight.x; x++) {
      for (let y = topLeft.y; y <= bottomRight.y; y++) {
        tiles.push({ z, x, y });
      }
    }
  }
  return tiles;
}

export interface TileDownloadProgress {
  total: number;
  downloaded: number;
  failed: number;
}

/**
 * Download map tiles for a trail bounding box.
 * Calls `onProgress` after each tile so the UI can render a progress bar.
 */
export async function cacheTiles(
  bbox: { minLat: number; maxLat: number; minLon: number; maxLon: number },
  onProgress?: (p: TileDownloadProgress) => void,
): Promise<TileDownloadProgress> {
  const tiles = tilesToDownload(bbox);
  const progress: TileDownloadProgress = { total: tiles.length, downloaded: 0, failed: 0 };

  // Ensure the base directory exists.
  await FileSystem.makeDirectoryAsync(TILE_BASE_DIR, { intermediates: true }).catch(() => undefined);

  for (const { z, x, y } of tiles) {
    const dir = `${TILE_BASE_DIR}${z}/${x}/`;
    const path = tileFilePath(z, x, y);

    try {
      // Skip if already cached.
      const info = await FileSystem.getInfoAsync(path);
      if (info.exists) {
        progress.downloaded++;
        onProgress?.(progress);
        continue;
      }

      await FileSystem.makeDirectoryAsync(dir, { intermediates: true }).catch(() => undefined);
      const result = await FileSystem.downloadAsync(tileUrl(z, x, y), path);
      if (result.status === 200) {
        progress.downloaded++;
      } else {
        progress.failed++;
        // Remove partial file on non-200.
        await FileSystem.deleteAsync(path, { idempotent: true }).catch(() => undefined);
      }
    } catch {
      progress.failed++;
    }

    onProgress?.(progress);
  }

  return progress;
}

/** Delete all cached tiles for a bounding box. */
export async function removeTilesForBbox(
  bbox: { minLat: number; maxLat: number; minLon: number; maxLon: number },
): Promise<void> {
  const tiles = tilesToDownload(bbox);
  await Promise.allSettled(
    tiles.map(({ z, x, y }) =>
      FileSystem.deleteAsync(tileFilePath(z, x, y), { idempotent: true }),
    ),
  );
}

/** Delete the entire tile cache directory. */
export async function removeTileCache(): Promise<void> {
  await FileSystem.deleteAsync(TILE_BASE_DIR, { idempotent: true }).catch(() => undefined);
}

/** Compute total size of the tile cache directory. */
export async function getTileCacheSize(): Promise<number> {
  try {
    const info = await FileSystem.getInfoAsync(TILE_BASE_DIR);
    if (!info.exists) return 0;
    return (info as { size?: number }).size ?? 0;
  } catch {
    return 0;
  }
}
