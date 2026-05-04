import type { Trail } from "@/lib/supabase";
import { fetchTrailGpxByIds } from "@/lib/supabase";
import { getTrailBbox } from "@/lib/trailLayer";
import type { TrailPhoto } from "@/lib/trailContent";
import {
  type OfflinePhoto,
  type OfflineTrail,
  saveTrailOffline,
  tilesToDownload,
  cacheTiles,
} from "@/lib/offlineStore";

export interface DownloadProgress {
  phase: "metadata" | "gpx" | "photos" | "tiles" | "done" | "error";
  label: string;
  done: number;
  total: number;
  bytes: number;
}

export type DownloadCallback = (progress: DownloadProgress) => void;

const AVG_TILE_BYTES = 15_000;
const SIZE_WARN_BYTES = 100 * 1024 * 1024;

export function estimateDownloadSize(trail: Trail): {
  tileCount: number;
  estimatedBytes: number;
  needsConfirm: boolean;
} {
  const bbox = getTrailBbox(trail);
  if (!bbox) return { tileCount: 0, estimatedBytes: 0, needsConfirm: false };
  const urls = tilesToDownload(bbox);
  const estimatedBytes = urls.length * AVG_TILE_BYTES;
  return {
    tileCount: urls.length,
    estimatedBytes,
    needsConfirm: estimatedBytes > SIZE_WARN_BYTES,
  };
}

export async function downloadTrailForOffline(
  trail: Trail,
  onProgress: DownloadCallback,
  signal?: AbortSignal,
): Promise<boolean> {
  let totalBytes = 0;

  try {
    onProgress({
      phase: "gpx",
      label: "Fetching trail data…",
      done: 0,
      total: 3,
      bytes: 0,
    });

    if (signal?.aborted) return false;

    const gpxMap = await fetchTrailGpxByIds([trail.id]);
    const gpxData = gpxMap.get(trail.id) ?? trail.gpx_data ?? null;
    const gpxSize =
      typeof gpxData === "string" ? new Blob([gpxData]).size : 0;
    totalBytes += gpxSize;

    onProgress({
      phase: "photos",
      label: "Downloading photos…",
      done: 1,
      total: 3,
      bytes: totalBytes,
    });

    if (signal?.aborted) return false;

    const photos = await fetchTrailPhotos(trail.id);
    const offlinePhotos: OfflinePhoto[] = [];
    for (const photo of photos) {
      if (signal?.aborted) return false;
      try {
        const res = await fetch(`/api/storage/objects/${photo.storage_key}`, {
          signal,
        });
        if (res.ok) {
          const blob = await res.blob();
          totalBytes += blob.size;
          offlinePhotos.push({
            storageKey: photo.storage_key,
            blob,
            width: photo.width,
            height: photo.height,
            caption: photo.caption,
          });
        }
      } catch {
        /* skip failed photo */
      }
    }

    onProgress({
      phase: "tiles",
      label: "Caching map tiles…",
      done: 2,
      total: 3,
      bytes: totalBytes,
    });

    if (signal?.aborted) return false;

    const bbox = getTrailBbox(trail);
    let tileCount = 0;
    if (bbox) {
      const tileUrls = tilesToDownload(bbox);
      tileCount = tileUrls.length;
      const tileBytes = await cacheTiles(
        tileUrls,
        (done, total) => {
          onProgress({
            phase: "tiles",
            label: `Caching tiles ${done}/${total}…`,
            done: 2,
            total: 3,
            bytes: totalBytes + done * AVG_TILE_BYTES,
          });
        },
        signal,
      );
      totalBytes += tileBytes;
    }

    if (signal?.aborted) return false;

    const entry: OfflineTrail = {
      id: trail.id,
      trail,
      gpxData,
      photos: offlinePhotos,
      downloadedAt: new Date().toISOString(),
      tileCount,
      estimatedSizeBytes: totalBytes,
    };

    await saveTrailOffline(entry);

    onProgress({
      phase: "done",
      label: "Downloaded!",
      done: 3,
      total: 3,
      bytes: totalBytes,
    });

    return true;
  } catch (err) {
    if (signal?.aborted) return false;
    onProgress({
      phase: "error",
      label:
        err instanceof Error ? err.message : "Download failed",
      done: 0,
      total: 0,
      bytes: totalBytes,
    });
    return false;
  }
}

async function fetchTrailPhotos(trailId: string): Promise<TrailPhoto[]> {
  try {
    const res = await fetch(`/api/trails/${trailId}/photos`);
    if (!res.ok) return [];
    const json = await res.json();
    return (json.photos ?? json) as TrailPhoto[];
  } catch {
    return [];
  }
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
