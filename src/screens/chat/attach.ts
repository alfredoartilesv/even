import { fileKind, MAX_PDF_BYTES, MAX_TEXT_CHARS, toFileAttachment, type FileAttachment } from "../../domain/chat/files";

/** A file from the picker as a chat attachment. Throws a message safe to show. */
export async function readAttachment(file: File): Promise<FileAttachment> {
  const kind = fileKind(file.name, file.type);
  if (!kind) throw new Error(`${file.name}: only PDF and text files (CSV, TXT, JSON) can be sent`);
  if (kind === "pdf") {
    // Checked before reading, so a large scan is not loaded into memory first.
    if (file.size > MAX_PDF_BYTES) throw new Error(`${file.name} is larger than ${MAX_PDF_BYTES / 1024 / 1024} MB`);
    return toFileAttachment({ kind, name: file.name, mediaType: "application/pdf", data: await base64(file) });
  }
  if (file.size > MAX_TEXT_CHARS * 4) throw new Error(`${file.name} is too long`);
  return toFileAttachment({ kind, name: file.name, mediaType: "text/plain", data: await file.text() });
}

function base64(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ""));
    r.onerror = () => reject(new Error("Could not read the file"));
    r.readAsDataURL(file);
  });
}
