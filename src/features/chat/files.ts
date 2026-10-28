import { imageBytes } from "./images";

/**
 * A document attached to a chat message: a PDF (sent as base64, Claude reads its text and pages)
 * or a plain-text file (CSV, TXT, Markdown, JSON exports from other apps), sent as text. Both go
 * as `document` blocks, so Claude knows they are material to read, not instructions.
 */
export type FileAttachment =
  { kind: "pdf"; name: string; mediaType: "application/pdf"; data: string } | { kind: "text"; name: string; mediaType: "text/plain"; data: string };

export const MAX_FILES_PER_MESSAGE = 3;
/** Kept with the chat on the phone and re-sent with every later question of the conversation, so smaller than the API's 32 MB. */
export const MAX_PDF_BYTES = 5 * 1024 * 1024;
/** About 75,000 tokens: plenty for a lab report or a month of exported rows. */
export const MAX_TEXT_CHARS = 300_000;

const TEXT_EXTENSIONS = new Set(["txt", "csv", "tsv", "md", "json", "xml", "log"]);
/** What the file picker offers: PDFs and the text formats above. */
export const FILE_ACCEPT = ".pdf,application/pdf,.txt,.csv,.tsv,.md,.json,.xml,.log,text/*";

const extension = (name: string) => /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase() ?? "";

/** Which kind a picked file is, from its type and name; null when it cannot be sent. */
export function fileKind(name: string, mimeType: string): FileAttachment["kind"] | null {
  if (mimeType === "application/pdf" || extension(name) === "pdf") return "pdf";
  if (mimeType.startsWith("text/") || TEXT_EXTENSIONS.has(extension(name))) return "text";
  return null;
}

/** File names travel to Claude as the document title: no paths, no control characters, bounded. */
export function cleanFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "";
  // eslint-disable-next-line no-control-regex
  const clean = base.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return (clean || "File").slice(0, 120);
}

/** Checks one attachment and returns it clean. Throws a message safe to show. */
export function toFileAttachment(f: FileAttachment): FileAttachment {
  const name = cleanFileName(f.name);
  if (f.kind === "pdf") {
    const data = f.data.replace(/\s/g, "");
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(data)) throw new Error(`${name}: the PDF data is not valid base64`);
    // Every PDF starts with "%PDF-", which is "JVBERi0" in base64.
    if (!data.startsWith("JVBERi0")) throw new Error(`${name} is not a PDF`);
    if (imageBytes(data) > MAX_PDF_BYTES) throw new Error(`${name} is larger than ${MAX_PDF_BYTES / 1024 / 1024} MB`);
    return { kind: "pdf", name, mediaType: "application/pdf", data };
  }
  if (f.kind === "text") {
    const data = f.data.replace(/^﻿/, "");
    if (!data.trim()) throw new Error(`${name} is empty`);
    if (data.length > MAX_TEXT_CHARS) throw new Error(`${name} is too long (more than ${MAX_TEXT_CHARS.toLocaleString("en")} characters)`);
    return { kind: "text", name, mediaType: "text/plain", data };
  }
  throw new Error("Only PDF and text files (CSV, TXT, JSON) can be sent");
}

export function validateFiles(files: FileAttachment[]): FileAttachment[] {
  if (files.length > MAX_FILES_PER_MESSAGE) throw new Error(`At most ${MAX_FILES_PER_MESSAGE} files per message`);
  return files.map(toFileAttachment);
}

/** Bytes that leave the phone for this file (for the disclosure log). */
export function fileBytes(f: FileAttachment): number {
  return f.kind === "pdf" ? imageBytes(f.data) : new TextEncoder().encode(f.data).length;
}

/** The Messages API block for one file. */
export function documentBlock(f: FileAttachment) {
  return f.kind === "pdf"
    ? { type: "document" as const, title: f.name, source: { type: "base64" as const, media_type: f.mediaType, data: f.data } }
    : { type: "document" as const, title: f.name, source: { type: "text" as const, media_type: f.mediaType, data: f.data } };
}
