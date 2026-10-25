import type Anthropic from "@anthropic-ai/sdk";
import type { SqlDriver } from "../db/driver";
import { uuidv7 } from "../lib/uuidv7";

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
  await db.run(
    `INSERT INTO chat_conversations (id, title, model, created_at, updated_at, origin_device_id) VALUES (?, ?, ?, ?, ?, ?)`,
    [id, opts.title ?? null, opts.model ?? null, now, now, deviceId],
  );
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
  const [{ next }] = await db.all<{ next: number }>(
    "SELECT COALESCE(MAX(seq), -1) + 1 AS next FROM chat_messages WHERE conversation_id = ?",
    [m.conversationId],
  );
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
}

export interface Disclosure {
  id: string;
  conversationId: string | null;
  messageId: string | null;
  sentAtMs: number;
  toolName: string | null;
  dataClass: "aggregate" | "raw" | "note";
  summary: string;
  bytes: number;
}

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

export async function disclosurePayload(db: SqlDriver, id: string): Promise<string | null> {
  const rows = await db.all<{ payload_json: string }>("SELECT payload_json FROM ai_disclosures WHERE id = ?", [id]);
  return rows[0]?.payload_json ?? null;
}
