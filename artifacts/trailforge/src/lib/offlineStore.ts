import type { Trail } from "@/lib/supabase";

const DB_NAME = "trailforge-offline";
const DB_VERSION = 1;
const TRAIL_STORE = "trails";
const QUEUE_STORE = "actionQueue";
const TILE_CACHE_NAME = "trailforge-tiles-v1";

type ChangeListener = () => void;
const changeListeners = new Set<ChangeListener>();

export function subscribeOfflineStoreChanges(fn: ChangeListener): () => void {
  changeListeners.add(fn);
  return () => changeListeners.delete(fn);
}

function notifyStoreChange(): void {
  for (const fn of changeListeners) {
    try { fn(); } catch { /* listener errors must not propagate */ }
  }
}

export interface OfflineTrail {
  id: string;
  trail: Trail;
  gpxData: unknown;
  photos: OfflinePhoto[];
  downloadedAt: string;
  tileCount: number;
  estimatedSizeBytes: number;
}

export interface OfflinePhoto {
  storageKey: string;
  blob: Blob;
  width: number | null;
  height: number | null;
  caption: string | null;
}

export interface QueuedAction {
  id: string;
  type: string;
  payload: Record<string, unknown>;
  createdAt: string;
  retries: number;
}

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(TRAIL_STORE)) {
        db.createObjectStore(TRAIL_STORE, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(QUEUE_STORE)) {
        db.createObjectStore(QUEUE_STORE, { keyPath: "id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function saveTrailOffline(entry: OfflineTrail): Promise<void> {
  const db = await openDB();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(TRAIL_STORE, "readwrite");
    tx.objectStore(TRAIL_STORE).put(entry);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  notifyStoreChange();
}

export async function getOfflineTrail(
  id: string,
): Promise<OfflineTrail | null> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(TRAIL_STORE, "readonly");
    const req = tx.objectStore(TRAIL_STORE).get(id);
    req.onsuccess = () => resolve((req.result as OfflineTrail) ?? null);
    req.onerror = () => reject(req.error);
  });
}

export async function removeOfflineTrail(id: string): Promise<void> {
  const db = await openDB();
  const tx = db.transaction(TRAIL_STORE, "readwrite");
  tx.objectStore(TRAIL_STORE).delete(id);
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  await removeTilesForTrail(id);
  notifyStoreChange();
}

export async function listOfflineTrails(): Promise<OfflineTrail[]> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(TRAIL_STORE, "readonly");
    const req = tx.objectStore(TRAIL_STORE).getAll();
    req.onsuccess = () => resolve((req.result as OfflineTrail[]) ?? []);
    req.onerror = () => reject(req.error);
  });
}

export async function isTrailOffline(id: string): Promise<boolean> {
  const entry = await getOfflineTrail(id);
  return entry != null;
}

export async function getOfflineStorageStats(): Promise<{
  trailCount: number;
  totalBytes: number;
}> {
  const trails = await listOfflineTrails();
  let totalBytes = 0;
  for (const t of trails) totalBytes += t.estimatedSizeBytes;
  return { trailCount: trails.length, totalBytes };
}

export async function clearAllOffline(): Promise<void> {
  const db = await openDB();
  const tx = db.transaction(TRAIL_STORE, "readwrite");
  tx.objectStore(TRAIL_STORE).clear();
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  try {
    await caches.delete(TILE_CACHE_NAME);
  } catch {
    /* non-fatal */
  }
  notifyStoreChange();
}

export function getTileCacheName(): string {
  return TILE_CACHE_NAME;
}

const ESRI_SAT_PREFIX =
  "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/";
const ESRI_LABEL_PREFIX =
  "https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/";

function tileUrl(
  prefix: string,
  z: number,
  x: number,
  y: number,
): string {
  return `${prefix}${z}/${y}/${x}`;
}

export function tilesToDownload(
  bbox: { minLat: number; maxLat: number; minLng: number; maxLng: number },
  zoomRange: [number, number] = [10, 15],
  pad = 0.01,
): string[] {
  const urls: string[] = [];
  const minLat = bbox.minLat - pad;
  const maxLat = bbox.maxLat + pad;
  const minLng = bbox.minLng - pad;
  const maxLng = bbox.maxLng + pad;

  for (let z = zoomRange[0]; z <= zoomRange[1]; z++) {
    const n = 1 << z;
    const xMin = Math.max(0, Math.floor(((minLng + 180) / 360) * n));
    const xMax = Math.min(n - 1, Math.floor(((maxLng + 180) / 360) * n));
    const yMin = Math.max(
      0,
      Math.floor(
        ((1 -
          Math.log(
            Math.tan((maxLat * Math.PI) / 180) +
              1 / Math.cos((maxLat * Math.PI) / 180),
          ) /
            Math.PI) /
          2) *
          n,
      ),
    );
    const yMax = Math.min(
      n - 1,
      Math.floor(
        ((1 -
          Math.log(
            Math.tan((minLat * Math.PI) / 180) +
              1 / Math.cos((minLat * Math.PI) / 180),
          ) /
            Math.PI) /
          2) *
          n,
      ),
    );

    for (let x = xMin; x <= xMax; x++) {
      for (let y = yMin; y <= yMax; y++) {
        urls.push(tileUrl(ESRI_SAT_PREFIX, z, x, y));
        urls.push(tileUrl(ESRI_LABEL_PREFIX, z, x, y));
      }
    }
  }
  return urls;
}

export async function cacheTiles(
  tileUrls: string[],
  onProgress?: (done: number, total: number) => void,
  signal?: AbortSignal,
): Promise<number> {
  const cache = await caches.open(TILE_CACHE_NAME);
  let done = 0;
  let totalBytes = 0;
  const BATCH = 6;

  for (let i = 0; i < tileUrls.length; i += BATCH) {
    if (signal?.aborted) break;
    const batch = tileUrls.slice(i, i + BATCH);
    const results = await Promise.allSettled(
      batch.map(async (url) => {
        const existing = await cache.match(url);
        if (existing) {
          const size = Number(existing.headers.get("content-length")) || 15000;
          totalBytes += size;
          return;
        }
        const res = await fetch(url, { signal });
        if (res.ok) {
          const clone = res.clone();
          const blob = await res.blob();
          totalBytes += blob.size;
          await cache.put(url, clone);
        }
      }),
    );
    done += results.length;
    onProgress?.(done, tileUrls.length);
  }
  return totalBytes;
}

async function removeTilesForTrail(_trailId: string): Promise<void> {
  /* noop — tiles are shared across trails, cleaned up by clearAllOffline */
}

export async function enqueueAction(action: Omit<QueuedAction, "id" | "createdAt" | "retries">): Promise<void> {
  const db = await openDB();
  const entry: QueuedAction = {
    ...action,
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    createdAt: new Date().toISOString(),
    retries: 0,
  };
  const tx = db.transaction(QUEUE_STORE, "readwrite");
  tx.objectStore(QUEUE_STORE).put(entry);
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function getQueuedActions(): Promise<QueuedAction[]> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(QUEUE_STORE, "readonly");
    const req = tx.objectStore(QUEUE_STORE).getAll();
    req.onsuccess = () => resolve((req.result as QueuedAction[]) ?? []);
    req.onerror = () => reject(req.error);
  });
}

export async function removeQueuedAction(id: string): Promise<void> {
  const db = await openDB();
  const tx = db.transaction(QUEUE_STORE, "readwrite");
  tx.objectStore(QUEUE_STORE).delete(id);
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function updateQueuedAction(action: QueuedAction): Promise<void> {
  const db = await openDB();
  const tx = db.transaction(QUEUE_STORE, "readwrite");
  tx.objectStore(QUEUE_STORE).put(action);
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
