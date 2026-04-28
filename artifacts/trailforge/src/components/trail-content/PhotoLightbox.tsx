import { useEffect } from "react";
import { trailPhotoUrl, type TrailPhoto } from "@/lib/trailContent";

interface Props {
  photos: TrailPhoto[];
  index: number;
  onClose: () => void;
  onPrev: () => void;
  onNext: () => void;
}

export default function PhotoLightbox({ photos, index, onClose, onPrev, onNext }: Props) {
  const photo = photos[index];

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowLeft") onPrev();
      else if (e.key === "ArrowRight") onNext();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose, onPrev, onNext]);

  if (!photo) return null;
  const author = photo.users?.display_name ?? "Anonymous";
  return (
    <div
      className="fixed inset-0 z-[2000] flex items-center justify-center"
      style={{ background: "rgba(0,0,0,0.92)" }}
      onClick={onClose}
      data-testid="photo-lightbox"
    >
      <button
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
        aria-label="Close"
        className="absolute top-3 right-3 w-9 h-9 rounded-full bg-stone-800/80 text-stone-200 flex items-center justify-center"
      >
        <svg viewBox="0 0 24 24" className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2">
          <line x1="18" y1="6" x2="6" y2="18" />
          <line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      </button>
      {photos.length > 1 ? (
        <>
          <button
            onClick={(e) => {
              e.stopPropagation();
              onPrev();
            }}
            aria-label="Previous"
            className="absolute left-3 w-9 h-9 rounded-full bg-stone-800/80 text-stone-200 flex items-center justify-center"
          >
            ‹
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation();
              onNext();
            }}
            aria-label="Next"
            className="absolute right-3 w-9 h-9 rounded-full bg-stone-800/80 text-stone-200 flex items-center justify-center"
          >
            ›
          </button>
        </>
      ) : null}
      <figure className="max-w-full max-h-full p-6" onClick={(e) => e.stopPropagation()}>
        <img
          src={trailPhotoUrl(photo)}
          alt={photo.caption ?? "Trail photo"}
          className="max-w-full max-h-[80vh] object-contain rounded"
        />
        <figcaption className="mt-3 text-xs text-stone-400 text-center">
          {photo.caption ? <span className="text-stone-200">{photo.caption} · </span> : null}
          {author} · {new Date(photo.created_at).toLocaleDateString()}
        </figcaption>
      </figure>
    </div>
  );
}
