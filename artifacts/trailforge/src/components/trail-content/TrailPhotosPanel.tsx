import { useEffect, useRef, useState } from "react";
import {
  fetchTrailPhotos,
  requestPhotoUploadUrl,
  createTrailPhoto,
  deleteTrailPhoto,
  trailPhotoUrl,
  type TrailPhoto,
} from "@/lib/trailContent";
import { preparePhotoForUpload, MAX_PHOTOS_PER_UPLOAD } from "@/lib/photoUpload";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import PhotoLightbox from "./PhotoLightbox";

interface Props {
  trailId: string;
  onCountsChanged?: () => void;
}

export default function TrailPhotosPanel({ trailId, onCountsChanged }: Props) {
  const { isSignedIn, userId } = useCurrentUser();
  const [photos, setPhotos] = useState<TrailPhoto[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [uploadStatus, setUploadStatus] = useState<string | null>(null);
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetchTrailPhotos(trailId).then((items) => {
      if (cancelled) return;
      setPhotos(items);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [trailId]);

  const onPickFiles = () => fileInputRef.current?.click();

  const handleFiles = async (eventFiles: FileList | null) => {
    if (!eventFiles || eventFiles.length === 0) return;
    if (!isSignedIn) {
      setUploadStatus("Sign in to upload photos");
      return;
    }
    const files = Array.from(eventFiles).slice(0, MAX_PHOTOS_PER_UPLOAD);
    if (eventFiles.length > MAX_PHOTOS_PER_UPLOAD) {
      setUploadStatus(`Max ${MAX_PHOTOS_PER_UPLOAD} photos per upload — only the first ${MAX_PHOTOS_PER_UPLOAD} were taken`);
    } else {
      setUploadStatus(null);
    }
    setUploading(true);
    const newRows: TrailPhoto[] = [];
    for (const file of files) {
      try {
        const prepared = await preparePhotoForUpload(file);
        const ticket = await requestPhotoUploadUrl(trailId, "image/jpeg");
        if (!ticket) throw new Error("Could not get upload URL");
        const putRes = await fetch(ticket.uploadURL, {
          method: "PUT",
          body: prepared.blob,
          headers: { "Content-Type": "image/jpeg" },
        });
        if (!putRes.ok) throw new Error(`Upload failed: ${putRes.status}`);
        const created = await createTrailPhoto(trailId, {
          storageKey: ticket.storageKey,
          width: prepared.width,
          height: prepared.height,
        });
        if (created) newRows.push(created);
      } catch (err) {
        console.error("photo upload failed", err);
        setUploadStatus(err instanceof Error ? err.message : "Upload failed");
      }
    }
    setUploading(false);
    if (newRows.length > 0) {
      setPhotos((prev) => [...newRows, ...prev]);
      onCountsChanged?.();
    }
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const remove = async (photo: TrailPhoto) => {
    if (!confirm("Remove this photo?")) return;
    const ok = await deleteTrailPhoto(trailId, photo.id);
    if (ok) {
      setPhotos((prev) => prev.filter((p) => p.id !== photo.id));
      onCountsChanged?.();
    }
  };

  return (
    <div className="px-4 pt-3 pb-5 space-y-3" data-testid="trail-photos-panel">
      <div className="flex items-center justify-between">
        <p className="text-xs text-stone-400">
          {loading ? "Loading photos…" : `${photos.length} photo${photos.length === 1 ? "" : "s"}`}
        </p>
        {isSignedIn ? (
          <>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              multiple
              className="hidden"
              onChange={(e) => handleFiles(e.target.files)}
              data-testid="photo-file-input"
            />
            <button
              onClick={onPickFiles}
              disabled={uploading}
              className="px-3 py-1.5 rounded-lg text-xs font-bold uppercase tracking-wider text-stone-900 disabled:opacity-50"
              style={{ background: "linear-gradient(135deg, #d4870c, #f0a832)" }}
              data-testid="photo-upload-btn"
            >
              {uploading ? "Uploading…" : `Upload (max ${MAX_PHOTOS_PER_UPLOAD})`}
            </button>
          </>
        ) : (
          <span className="text-[11px] text-stone-500">Sign in to upload</span>
        )}
      </div>
      {uploadStatus ? (
        <p className="text-[11px] text-amber-400" data-testid="photo-upload-status">
          {uploadStatus}
        </p>
      ) : null}

      {!loading && photos.length === 0 ? (
        <p className="text-xs text-stone-500 text-center py-6">
          No photos yet — be the first to share what this trail looks like.
        </p>
      ) : null}

      <div className="grid grid-cols-3 gap-2">
        {photos.map((photo, idx) => {
          const isOwn = photo.author_user_id === userId;
          return (
            <div
              key={photo.id}
              className="relative aspect-square rounded-lg overflow-hidden bg-stone-800 group"
              data-testid={`photo-${photo.id}`}
            >
              <button
                type="button"
                onClick={() => setLightboxIndex(idx)}
                className="absolute inset-0"
                aria-label="Open photo"
              >
                <img
                  src={trailPhotoUrl(photo)}
                  alt={photo.caption ?? "Trail photo"}
                  className="w-full h-full object-cover"
                  loading="lazy"
                />
              </button>
              {isOwn ? (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    remove(photo);
                  }}
                  className="absolute top-1 right-1 w-6 h-6 rounded-full bg-stone-900/80 text-stone-200 hover:text-red-400 flex items-center justify-center text-xs opacity-0 group-hover:opacity-100 transition-opacity"
                  aria-label="Remove photo"
                  data-testid={`photo-delete-${photo.id}`}
                >
                  ×
                </button>
              ) : null}
            </div>
          );
        })}
      </div>

      {lightboxIndex !== null ? (
        <PhotoLightbox
          photos={photos}
          index={lightboxIndex}
          onClose={() => setLightboxIndex(null)}
          onPrev={() => setLightboxIndex((i) => (i === null ? null : (i - 1 + photos.length) % photos.length))}
          onNext={() => setLightboxIndex((i) => (i === null ? null : (i + 1) % photos.length))}
        />
      ) : null}
    </div>
  );
}
