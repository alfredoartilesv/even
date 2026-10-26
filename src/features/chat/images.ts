/** A photo attached to a chat message, as the Messages API takes it (base64, no data: prefix). */
export interface ImageAttachment {
  mediaType: "image/jpeg" | "image/png" | "image/webp" | "image/gif";
  data: string;
}

export const MAX_IMAGES_PER_MESSAGE = 4;
/** The API's limit per image is 5 MB. Photos are resized before this (camera.ts), so this is a backstop. */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MEDIA_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);

export function imageBytes(base64: string): number {
  const clean = base64.replace(/\s/g, "");
  const padding = clean.endsWith("==") ? 2 : clean.endsWith("=") ? 1 : 0;
  return Math.floor((clean.length * 3) / 4) - padding;
}

/** Accepts a data: URL too, and returns the clean attachment. Throws a message safe to show. */
export function toAttachment(input: string, mediaType?: string): ImageAttachment {
  let data = input.trim();
  let type = mediaType;
  const m = /^data:([^;]+);base64,(.*)$/s.exec(data);
  if (m) {
    type = m[1];
    data = m[2];
  }
  data = data.replace(/\s/g, "");
  if (!type || !MEDIA_TYPES.has(type)) throw new Error("Only JPEG, PNG, WebP or GIF photos can be sent");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(data)) throw new Error("The photo data is not valid base64");
  if (imageBytes(data) > MAX_IMAGE_BYTES) throw new Error("The photo is larger than 5 MB");
  return { mediaType: type as ImageAttachment["mediaType"], data };
}

/**
 * A photo from the app's own picker (src/screens/food/photo.ts downscalePhoto: JPEG, at most
 * 1024 px, EXIF dropped) as a chat attachment. The same photo can then be kept with a saved meal.
 */
export function attachmentFromPhoto(p: { mime: "image/jpeg" | "image/webp"; dataB64: string }): ImageAttachment {
  return toAttachment(p.dataB64, p.mime);
}

export function validateAttachments(images: ImageAttachment[]): ImageAttachment[] {
  if (images.length > MAX_IMAGES_PER_MESSAGE) throw new Error(`At most ${MAX_IMAGES_PER_MESSAGE} photos per message`);
  return images.map((i) => toAttachment(i.data, i.mediaType));
}
