/**
 * The profile picture: cropped to a centred square and re-encoded as a small JPEG, which also
 * drops EXIF (location, device). About 15 to 30 kB at 256 px.
 */
export async function squarePhoto(file: Blob, side = 256, quality = 0.85): Promise<string> {
  const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  const crop = Math.min(bitmap.width, bitmap.height);
  const canvas = document.createElement("canvas");
  canvas.width = side;
  canvas.height = side;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Cannot process the picture on this device");
  ctx.drawImage(bitmap, (bitmap.width - crop) / 2, (bitmap.height - crop) / 2, crop, crop, 0, 0, side, side);
  bitmap.close();
  return canvas.toDataURL("image/jpeg", quality);
}

/** "Sam Lee" -> "SL"; no name -> "Me". */
export function initials(name: string | null): string {
  const parts = (name ?? "").trim().split(/\s+/).filter(Boolean);
  return parts.length ? (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase() : "Me";
}

export function Avatar({ photo, name, size = 72 }: { photo: string | null; name: string | null; size?: number }) {
  return photo ? (
    <img className="avatar" src={photo} width={size} height={size} alt={name ? `${name}'s picture` : "Profile picture"} />
  ) : (
    <div className="avatar empty" style={{ width: size, height: size, fontSize: size * 0.38 }} aria-hidden>
      {initials(name)}
    </div>
  );
}
