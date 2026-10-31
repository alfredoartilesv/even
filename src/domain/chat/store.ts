import type Anthropic from "@anthropic-ai/sdk";
import type { SqlDriver } from "../../db/driver.js";
import { uuidv7 } from "../../core/uuidv7.js";
import { createLogger } from "../../core/log.js";
import type { DataClass } from "./consent.js";

const log = createLogger("chat.store");

type MessageParam = Anthropic.Beta.Messages.BetaMessageParam;
type Content = Anthropic.Beta.Messages.BetaMessageContentParam;

/**
 * Conversations are append-only. Messages are stored exactly as sent or received
 * (content_json = the Anthropic content blocks, thinking and fallback blocks included) and
 * replayed in seq order. Editing or dropping earlier turns would invalidate the model's
 * thinking blocks ("preserved thinking") and the prompt cache, so nothing here rewrites a
 * message; deleting a conversation is a soft delete of the whole thing.
 */

export interface Conversation {
  id: string;
  title: string | null;
  model: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface StoredMessage {
  id: string;
  seq: number;
  role: "user" | "assistant";
  content: Content;
  model: string | null;
  stopReason: string | null;
  createdAt: number;
}

export async function createConversation(
  db: SqlDriver,
  deviceId: string,
  opts: { title?: string | null; model?: string | null; now?: number } = {},
): Promise<string> {
  const now = opts.now ?? Date.now();
  const id = uuidv7(now);
  await db.run(`INSERT INTO chat_conversations (id, title, model, created_at, updated_at, origin_device_id) VALUES (?, ?, ?, ?, ?, ?)`, [
    id,
    opts.title ?? null,
    opts.model ?? null,
    now,
    now,
    deviceId,
  ]);
  log.debug("conversation created", { id });
  return id;
}

export async function appendMessage(
  db: SqlDriver,
  deviceId: string,
  m: {
    conversationId: string;
    role: "user" | "assistant";
    content: Content;
    model?: string | null;
    stopReason?: string | null;
    inputTokens?: number | null;
    outputTokens?: number | null;
    now?: number;
  },
): Promise<string> {
  const now = m.now ?? Date.now();
  const id = uuidv7(now);
  const [{ next }] = await db.all<{ next: number }>("SELECT COALESCE(MAX(seq), -1) + 1 AS next FROM chat_messages WHERE conversation_id = ?", [
    m.conversationId,
  ]);
  await db.run(
    `INSERT INTO chat_messages
       (id, conversation_id, seq, role, content_json, model, stop_reason, input_tokens, output_tokens,
        created_at, updated_at, origin_device_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      m.conversationId,
      next,
      m.role,
      JSON.stringify(m.content),
      m.model ?? null,
      m.stopReason ?? null,
      m.inputTokens ?? null,
      m.outputTokens ?? null,
      now,
      now,
      deviceId,
    ],
  );
  await db.run("UPDATE chat_conversations SET updated_at = ? WHERE id = ?", [now, m.conversationId]);
  return id;
}

export async function loadMessages(db: SqlDriver, conversationId: string): Promise<StoredMessage[]> {
  const rows = await db.all<{
    id: string;
    seq: number;
    role: "user" | "assistant";
    content_json: string;
    model: string | null;
    stop_reason: string | null;
    created_at: number;
  }>(
    `SELECT id, seq, role, content_json, model, stop_reason, created_at FROM chat_messages
     WHERE conversation_id = ? AND deleted_at IS NULL ORDER BY seq`,
    [conversationId],
  );
  return rows.map((r) => ({
    id: r.id,
    seq: r.seq,
    role: r.role,
    content: JSON.parse(r.content_json) as Content,
    model: r.model,
    stopReason: r.stop_reason,
    createdAt: r.created_at,
  }));
}

/** The history in API shape. */
export async function loadApiMessages(db: SqlDriver, conversationId: string): Promise<MessageParam[]> {
  return (await loadMessages(db, conversationId)).map((m) => ({ role: m.role, content: m.content }) as MessageParam);
}

export async function listConversations(db: SqlDriver): Promise<Conversation[]> {
  const rows = await db.all<{ id: string; title: string | null; model: string | null; created_at: number; updated_at: number }>(
    `SELECT id, title, model, created_at, updated_at FROM chat_conversations
     WHERE deleted_at IS NULL ORDER BY updated_at DESC, id DESC`,
  );
  return rows.map((r) => ({ id: r.id, title: r.title, model: r.model, createdAt: r.created_at, updatedAt: r.updated_at }));
}

export async function renameConversation(db: SqlDriver, id: string, title: string, now: number = Date.now()): Promise<void> {
  await db.run("UPDATE chat_conversations SET title = ?, updated_at = ? WHERE id = ?", [title.trim() || null, now, id]);
}

/** Soft delete of the conversation; its messages stay attached but are no longer listed. */
export async function deleteConversation(db: SqlDriver, id: string, now: number = Date.now()): Promise<void> {
  await db.run("UPDATE chat_conversations SET deleted_at = ?, updated_at = ? WHERE id = ?", [now, now, id]);
  log.info("conversation deleted", { id });
}

export interface Disclosure {
  id: string;
  conversationId: string | null;
  messageId: string | null;
  sentAtMs: number;
  toolName: string | null;
  dataClass: DataClass;
  summary: string;
  bytes: number;
}

/**
 * One thing sent to Claude, for the "what was sent" panel: by the chat (engine.ts) or the health
 * connector (server/healthMcp.ts). `bytes` is the payload's size unless given (a photo's own size).
 */
export async function recordDisclosure(
  db: SqlDriver,
  deviceId: string,
  d: {
    conversationId: string | null;
    messageId: string | null;
    at: number;
    toolName: string | null;
    dataClass: DataClass;
    summary: string;
    payload: string;
    bytes?: number;
  },
): Promise<void> {
  await db.run(
    `INSERT INTO ai_disclosures
       (id, conversation_id, message_id, sent_at_ms, tool_name, data_class, summary, payload_json, bytes,
        created_at, updated_at, origin_device_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [uuidv7(d.at), d.conversationId, d.messageId, d.at, d.toolName, d.dataClass, d.summary, d.payload, d.bytes ?? utf8Bytes(d.payload), d.at, d.at, deviceId],
  );
}

const utf8Bytes = (s: string) => new TextEncoder().encode(s).length;

/** For the "what was sent to Claude" panel. Payloads stay in the table; fetch one by id if shown. */
export async function listDisclosures(db: SqlDriver, conversationId?: string): Promise<Disclosure[]> {
  const rows = await db.all<{
    id: string;
    conversation_id: string | null;
    message_id: string | null;
    sent_at_ms: number;
    tool_name: string | null;
    data_class: Disclosure["dataClass"];
    summary: string;
    bytes: number;
  }>(
    `SELECT id, conversation_id, message_id, sent_at_ms, tool_name, data_class, summary, bytes FROM ai_disclosures
     WHERE deleted_at IS NULL ${conversationId ? "AND conversation_id = ?" : ""}
     ORDER BY sent_at_ms DESC, id DESC`,
    conversationId ? [conversationId] : [],
  );
  return rows.map((r) => ({
    id: r.id,
    conversationId: r.conversation_id,
    messageId: r.message_id,
    sentAtMs: r.sent_at_ms,
    toolName: r.tool_name,
    dataClass: r.data_class,
    summary: r.summary,
    bytes: r.bytes,
  }));
}
