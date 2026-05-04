import { useCallback, useEffect, useRef, useState } from "react";
import {
  type GroupPhoto,
  createGroupPhoto,
  deleteGroupPhoto,
  updateGroupPhoto,
  fetchGroupPhotos,
  groupPhotoUrl,
  requestGroupPhotoUploadUrl,
} from "@/lib/groups";
import { preparePhotoForUpload } from "@/lib/photoUpload";

interface Props {
  groupId: string;
  callerUserId: string;
  canModerate: boolean;
}

export default function GroupGallerySection({
  groupId,
  callerUserId,
  canModerate,
}: Props) {
  const [photos, setPhotos] = useState<GroupPhoto[]>([]);
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<{
    done: number;
    total: number;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lightbox, setLightbox] = useState<GroupPhoto | null>(null);
  const [editingCaption, setEditingCaption] = useState(false);
  const [captionDraft, setCaptionDraft] = useState("");
  const [savingCaption, setSavingCaption] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    const items = await fetchGroupPhotos(groupId);
    setPhotos(items);
    setLoading(false);
  }, [groupId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setError(null);
    setUploading(true);
    const total = files.length;
    setUploadProgress({ done: 0, total });
    try {
      for (let i = 0; i < files.length; i += 1) {
        const file = files[i];
        const prepared = await preparePhotoForUpload(file);
        const ticket = await requestGroupPhotoUploadUrl(groupId);
        if (!ticket) throw new Error("Could not get upload URL");
        const putRes = await fetch(ticket.uploadURL, {
          method: "PUT",
          body: prepared.blob,
          headers: { "Content-Type": "image/jpeg" },
        });
        if (!putRes.ok) throw new Error(`Upload failed: ${putRes.status}`);
        const created = await createGroupPhoto(groupId, {
          storageKey: ticket.storageKey,
          width: prepared.width,
          height: prepared.height,
        });
        if (!created) throw new Error("Failed to save photo");
        setUploadProgress({ done: i + 1, total });
      }
      await refresh();
    } catch (err) {
      console.error("group photo upload failed", err);
      setError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setUploading(false);
      setUploadProgress(null);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const handleDelete = async (photo: GroupPhoto) => {
    setError(null);
    const ok = await deleteGroupPhoto(groupId, photo.id);
    if (!ok) {
      setError("Could not remove photo");
      return;
    }
    setLightbox((cur) => (cur?.id === photo.id ? null : cur));
    await refresh();
  };

  const openLightbox = (photo: GroupPhoto) => {
    setLightbox(photo);
    setEditingCaption(false);
    setCaptionDraft(photo.caption ?? "");
    setSavingCaption(false);
  };

  const startEditCaption = () => {
    if (!lightbox) return;
    setCaptionDraft(lightbox.caption ?? "");
    setEditingCaption(true);
  };

  const handleSaveCaption = async () => {
    if (!lightbox) return;
    setSavingCaption(true);
    const caption = captionDraft.trim() || null;
    const updated = await updateGroupPhoto(groupId, lightbox.id, { caption });
    setSavingCaption(false);
    if (!updated) {
      setError("Could not save caption");
      return;
    }
    setLightbox(updated);
    setPhotos((prev) =>
      prev.map((p) => (p.id === updated.id ? updated : p)),
    );
    setEditingCaption(false);
  };

  return (
    <div className="space-y-2" data-testid="group-gallery-section">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-[11px] font-bold uppercase tracking-widest text-stone-400">
          Gallery {photos.length > 0 && (
            <span className="text-stone-500 font-normal normal-case tracking-normal">
              · {photos.length}
            </span>
          )}
        </h3>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          multiple
          className="hidden"
          onChange={(e) => void handleFiles(e.target.files)}
          data-testid="group-gallery-input"
        />
        <button
          type="button"
          disabled={uploading}
          onClick={() => fileInputRef.current?.click()}
          className="px-2.5 py-1 rounded-md text-[10px] font-bold uppercase tracking-wider text-stone-900 disabled:opacity-50"
          style={{ background: "linear-gradient(135deg, #d4870c, #f0a832)" }}
          data-testid="group-gallery-upload-btn"
        >
          {uploading
            ? uploadProgress
              ? `Uploading ${uploadProgress.done}/${uploadProgress.total}…`
              : "Uploading…"
            : "Add Photos"}
        </button>
      </div>

      {loading && photos.length === 0 ? (
        <div className="text-[11px] text-stone-500 py-3 text-center">Loading…</div>
      ) : photos.length === 0 ? (
        <div
          className="rounded-lg border border-dashed border-[hsl(30,12%,22%)] bg-[hsl(22,15%,11%)] py-6 text-center text-[11px] text-stone-500"
          data-testid="group-gallery-empty"
        >
          No photos yet — be the first to share a shot from a group ride.
        </div>
      ) : (
        <div className="grid grid-cols-3 gap-1.5" data-testid="group-gallery-grid">
          {photos.map((p) => {
            const isUploader = p.uploader_user_id === callerUserId;
            const canDelete = isUploader || canModerate;
            return (
              <div
                key={p.id}
                className="relative aspect-square rounded-md overflow-hidden bg-stone-800 group"
                data-testid={`group-gallery-photo-${p.id}`}
              >
                <button
                  type="button"
                  onClick={() => openLightbox(p)}
                  className="block w-full h-full"
                  aria-label={`Open photo by ${p.users?.display_name ?? "member"}`}
                >
                  <img
                    src={groupPhotoUrl(p)}
                    alt={p.caption ?? "Group photo"}
                    className="w-full h-full object-cover"
                    loading="lazy"
                  />
                </button>
                {canDelete && (
                  <button
                    type="button"
                    onClick={() => void handleDelete(p)}
                    className="absolute top-1 right-1 px-1.5 py-0.5 rounded text-[9px] font-bold uppercase tracking-wider text-red-300 bg-black/70 opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity"
                    data-testid={`group-gallery-delete-${p.id}`}
                    aria-label="Remove photo"
                  >
                    {isUploader ? "Delete" : "Hide"}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}

      {error && (
        <p className="text-[11px] text-red-300" data-testid="group-gallery-error">
          {error}
        </p>
      )}

      {lightbox && (() => {
        const isLightboxUploader = lightbox.uploader_user_id === callerUserId;
        const canEditCaption = isLightboxUploader || canModerate;
        return (
          <div
            className="fixed inset-0 z-[3070] flex items-center justify-center bg-black/90 p-4"
            role="dialog"
            aria-modal="true"
            onClick={() => setLightbox(null)}
            data-testid="group-gallery-lightbox"
          >
            <div
              className="relative max-w-3xl w-full"
              onClick={(e) => e.stopPropagation()}
            >
              <img
                src={groupPhotoUrl(lightbox)}
                alt={lightbox.caption ?? "Group photo"}
                className="w-full max-h-[80vh] object-contain rounded-lg"
              />
              {lightbox.caption && !editingCaption && (
                <p
                  className="mt-2 text-sm text-stone-200 leading-snug"
                  data-testid="group-gallery-lightbox-caption"
                >
                  {lightbox.caption}
                </p>
              )}
              {editingCaption && (
                <div className="mt-2 flex items-center gap-2" data-testid="group-gallery-caption-editor">
                  <input
                    type="text"
                    value={captionDraft}
                    onChange={(e) => setCaptionDraft(e.target.value)}
                    maxLength={500}
                    placeholder="Add a caption…"
                    className="flex-1 rounded-md bg-stone-800 border border-stone-600 px-2 py-1 text-sm text-stone-200 placeholder:text-stone-500 focus:outline-none focus:border-amber-500"
                    autoFocus
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void handleSaveCaption();
                      if (e.key === "Escape") setEditingCaption(false);
                    }}
                    data-testid="group-gallery-caption-input"
                  />
                  <button
                    type="button"
                    disabled={savingCaption}
                    onClick={() => void handleSaveCaption()}
                    className="px-2.5 py-1 rounded-md text-[10px] font-bold uppercase tracking-wider text-stone-900 disabled:opacity-50"
                    style={{ background: "linear-gradient(135deg, #d4870c, #f0a832)" }}
                    data-testid="group-gallery-caption-save"
                  >
                    {savingCaption ? "Saving…" : "Save"}
                  </button>
                  <button
                    type="button"
                    onClick={() => setEditingCaption(false)}
                    className="px-2 py-1 rounded-md text-[10px] font-bold uppercase tracking-wider text-stone-400 hover:text-stone-200"
                    data-testid="group-gallery-caption-cancel"
                  >
                    Cancel
                  </button>
                </div>
              )}
              <div className="mt-2 flex items-center justify-between gap-2 text-[11px] text-stone-400">
                <div className="flex items-center gap-2 min-w-0">
                  {lightbox.users?.avatar_url ? (
                    <img
                      src={lightbox.users.avatar_url}
                      alt=""
                      className="w-6 h-6 rounded-full"
                    />
                  ) : null}
                  <span className="truncate">
                    {lightbox.users?.display_name ?? "Member"}
                    {" · "}
                    {new Date(lightbox.created_at).toLocaleDateString()}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  {canEditCaption && !editingCaption && (
                    <button
                      type="button"
                      onClick={startEditCaption}
                      className="text-stone-500 hover:text-amber-400"
                      data-testid="group-gallery-edit-caption-btn"
                    >
                      {lightbox.caption ? "Edit caption" : "Add caption"}
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => setLightbox(null)}
                    className="text-stone-500 hover:text-amber-400"
                    data-testid="group-gallery-lightbox-close"
                  >
                    Close
                  </button>
                </div>
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
}
