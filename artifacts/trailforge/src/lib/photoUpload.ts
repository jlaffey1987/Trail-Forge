/**
 * Client-side photo preparation: re-encode the user's image to JPEG via a
 * canvas so EXIF (which contains GPS, camera serials, etc.) is stripped, and
 * resize to a maximum edge of 1600px to keep payloads reasonable.
 *
 * Returns the prepared blob plus its decoded dimensions.
 */
export interface PreparedPhoto {
  blob: Blob;
  width: number;
  height: number;
}

const MAX_EDGE = 1600;
const JPEG_QUALITY = 0.85;

export async function preparePhotoForUpload(file: File): Promise<PreparedPhoto> {
  if (!file.type.startsWith("image/")) {
    throw new Error("Only image files can be uploaded");
  }

  // createImageBitmap drops the EXIF orientation; we re-paint into a canvas
  // and re-encode to JPEG so the resulting bytes contain no metadata.
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    bitmap = await createImageBitmap(file);
  }

  let { width, height } = bitmap;
  if (width === 0 || height === 0) {
    throw new Error("Could not decode image");
  }
  const longest = Math.max(width, height);
  if (longest > MAX_EDGE) {
    const scale = MAX_EDGE / longest;
    width = Math.round(width * scale);
    height = Math.round(height * scale);
  }

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas unavailable");
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();

  const blob: Blob | null = await new Promise((resolve) =>
    canvas.toBlob(resolve, "image/jpeg", JPEG_QUALITY),
  );
  if (!blob) throw new Error("Failed to encode JPEG");
  return { blob, width, height };
}

/** Limit imposed by the API on a single upload batch. */
export const MAX_PHOTOS_PER_UPLOAD = 5;
