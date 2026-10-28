import { useEffect, useState } from "react";
import type { SqlDriver } from "../../db/driver";
import { failed, MsgLine, type Msg } from "../../ui/common";
import { loadProfilePhoto, saveProfilePhoto } from "../../domain/settings/profile";

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

/**
 * The picture with a button to choose one from the phone and one to remove it. No `capture`
 * attribute: with it Android opens only the camera; without it the phone offers its gallery and files.
 */
export function PhotoPicker({ db, name, onChanged }: { db: SqlDriver; name: string | null; onChanged: () => void }) {
  const [photo, setPhoto] = useState<string | null>(null);
  const [msg, setMsg] = useState<Msg>(null);
  useEffect(() => {
    void loadProfilePhoto(db).then(setPhoto);
  }, [db]);

  async function store(url: string | null) {
    try {
      await saveProfilePhoto(db, url);
      setPhoto(url);
      setMsg(null);
      onChanged();
    } catch (err) {
      setMsg(failed(err, "profile.photo"));
    }
  }

  async function pick(file: File | undefined) {
    if (!file) return;
    try {
      await store(await squarePhoto(file));
    } catch (err) {
      setMsg(failed(err, "profile.photo"));
    }
  }

  return (
    <div className="stack tight">
      <div className="me-head">
        <Avatar photo={photo} name={name} />
        <div className="actions compact">
          <label className="file-button compact">
            <input type="file" accept="image/*" onChange={(e) => void pick(e.target.files?.[0])} aria-label="Choose a profile picture from the phone" />
            {photo ? "Change picture" : "Choose picture"}
          </label>
          {photo && (
            <button type="button" className="secondary" onClick={() => void store(null)}>
              Remove
            </button>
          )}
        </div>
      </div>
      <MsgLine msg={msg} />
    </div>
  );
}
