import type { PhotoInput } from "../food";

/**
 * Shrink a camera photo to at most maxSide px and re-encode it as JPEG. Re-encoding through a
 * canvas also drops EXIF (GPS position, device). A 12 MP photo becomes roughly 80 to 150 kB.
 */
export async function downscalePhoto(file: Blob, maxSide = 1024, quality = 0.8): Promise<PhotoInput> {
  const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  const k = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const width = Math.round(bitmap.width * k);
  const height = Math.round(bitmap.height * k);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Cannot process the photo on this device");
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  const url = canvas.toDataURL("image/jpeg", quality);
  return { mime: "image/jpeg", dataB64: url.slice(url.indexOf(",") + 1), width, height };
}

export const photoInputUrl = (p: PhotoInput) => `data:${p.mime};base64,${p.dataB64}`;
