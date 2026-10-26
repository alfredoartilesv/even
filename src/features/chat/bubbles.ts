import type { StoredMessage } from "./store";

/** A stored message as the chat screen shows it. */
export interface Bubble {
  id: string;
  role: "user" | "assistant";
  texts: string[];
  images: string[];
}

type Block = { type: string; text?: string; source?: { type: string; media_type?: string; data?: string } };

/** What the owner sees of a stored message: its text and photos, not tool calls, thinking or the app's clock line. */
export function toBubble(m: StoredMessage): Bubble | null {
  const blocks = (typeof m.content === "string" ? [{ type: "text", text: m.content }] : (m.content as unknown as Block[])) ?? [];
  const texts = blocks.filter((b) => b.type === "text" && b.text && !b.text.startsWith("[App] ")).map((b) => b.text!.trim());
  const images = blocks.filter((b) => b.type === "image" && b.source?.type === "base64").map((b) => `data:${b.source!.media_type};base64,${b.source!.data}`);
  return texts.length || images.length ? { id: m.id, role: m.role, texts, images } : null;
}
