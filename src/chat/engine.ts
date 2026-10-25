import Anthropic from "@anthropic-ai/sdk";
import type { SqlDriver } from "../db/driver";
import { uuidv7 } from "../lib/uuidv7";
import { CONSENT_TEXT, hasConsent, recordConsent, SCOPE_FOR, type ConsentScope, type DataClass } from "./consent";
import { dateContext, SYSTEM_PROMPT } from "./prompt";
import { appendMessage, createConversation, loadApiMessages, loadMessages, renameConversation } from "./store";
import { CHAT_TOOLS, TOOLS_BY_NAME } from "./tools";

type BetaMessage = Anthropic.Beta.Messages.BetaMessage;
type CreateParams = Anthropic.Beta.Messages.MessageCreateParamsNonStreaming;
type ContentBlockParam = Anthropic.Beta.Messages.BetaContentBlockParam;
type ToolResultBlockParam = Anthropic.Beta.Messages.BetaToolResultBlockParam;
type ToolUseBlock = Anthropic.Beta.Messages.BetaToolUseBlock;

export const CHAT_MODEL = "claude-opus-5-5";
export type Effort = "low" | "medium" | "high" | "xhigh" | "max";
/** Claude Opus 5.5 defaults to medium; set explicitly so a default change upstream does not move cost silently. */
export const DEFAULT_EFFORT: Effort = "medium";
const MAX_TOKENS = 16000; // non-streaming: native HTTP reads the whole reply at once
const DEFAULT_MAX_TOOL_ROUNDS = 8;

/** One non-streaming Messages API call. The real one is claudeCreate() in client.ts; tests pass a fake. */
export type ClaudeCreate = (params: CreateParams) => Promise<BetaMessage>;

export interface ChatDeps {
  db: SqlDriver;
  create: ClaudeCreate;
  deviceId: string;
  now?: () => number;
  /** Zone used for "today" in the prompt. Default: the device's zone. */
  timeZone?: string;
  effort?: Effort;
  /**
   * Asked when a kind of data has no consent yet. Show CONSENT_TEXT[scope] and resolve with
   * the user's answer; the decision is recorded either way. Without it, missing consent is a "no".
   */
  askConsent?: (scope: ConsentScope, text: string) => Promise<boolean>;
  maxToolRounds?: number;
}

export interface ToolCallReport {
  name: string;
  dataClass: DataClass | null;
  /** false when consent was missing; nothing was sent. */
  allowed: boolean;
  error?: string;
}

export interface ChatTurnResult {
  conversationId: string;
  /**
   * ok: answered. refusal: declined even after the fallback model. max_tokens: answer cut off.
   * tool_limit: stopped calling tools after maxToolRounds and answered with what it had.
   */
  status: "ok" | "refusal" | "max_tokens" | "tool_limit";
  text: string;
  /** Model that produced the final reply (differs from CHAT_MODEL after a fallback). */
  servedBy: string;
  fallbackUsed: boolean;
  refusal?: { category: string | null; explanation: string | null };
  toolCalls: ToolCallReport[];
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; requests: number };
}

/** No consent to send anything to Claude: show CONSENT_TEXT[scope] and record the answer first. */
export class ConsentRequiredError extends Error {
  constructor(readonly scope: ConsentScope) {
    super("Allow sending your questions and data summaries to Claude first");
    this.name = "ConsentRequiredError";
  }
}

export type ChatErrorKind = "auth" | "rate_limit" | "overloaded" | "network" | "bad_request" | "server" | "unknown";

/** A failed API call, with a message safe to show. The conversation stays valid: retry with continueConversation(). */
export class ChatApiError extends Error {
  constructor(
    readonly kind: ChatErrorKind,
    message: string,
    readonly retryable: boolean,
    readonly status?: number,
  ) {
    super(message);
    this.name = "ChatApiError";
  }
}

/** Typed SDK errors, most specific first. Never includes the API key (the SDK does not echo it). */
export function toChatError(err: unknown): ChatApiError {
  if (err instanceof ChatApiError) return err;
  if (err instanceof Anthropic.APIConnectionError) return new ChatApiError("network", "Could not reach Claude. Check the connection and try again.", true);
  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
    return new ChatApiError("auth", "Claude rejected the API key. Check it in Settings.", false, err.status);
  }
  if (err instanceof Anthropic.RateLimitError) return new ChatApiError("rate_limit", "Claude is rate-limiting this key. Wait a moment and try again.", true, 429);
  if (err instanceof Anthropic.BadRequestError) return new ChatApiError("bad_request", `Claude could not process the request: ${err.message}`, false, 400);
  if (err instanceof Anthropic.APIError) {
    const status = err.status;
    if (status === 529) return new ChatApiError("overloaded", "Claude is overloaded right now. Try again shortly.", true, status);
    return new ChatApiError("server", `Claude answered with an error${status ? ` (HTTP ${status})` : ""}. Try again.`, true, status);
  }
  return new ChatApiError("unknown", `Chat failed: ${(err as Error)?.message ?? String(err)}`, false);
}

/** Start a conversation with a first question. */
export async function startConversation(deps: ChatDeps, text: string): Promise<ChatTurnResult> {
  await requireBaseConsent(deps);
  const now = (deps.now ?? Date.now)();
  const id = await createConversation(deps.db, deps.deviceId, { title: titleFrom(text), model: CHAT_MODEL, now });
  return askClaude(deps, id, text);
}

/** Add a question to a conversation and run Claude (with local tools) until it answers. */
export async function askClaude(deps: ChatDeps, conversationId: string, text: string): Promise<ChatTurnResult> {
  const question = text.trim();
  if (!question) throw new Error("Empty question");
  await requireBaseConsent(deps);
  const history = await loadMessages(deps.db, conversationId);
  if (history.length === 0) await renameConversation(deps.db, conversationId, titleFrom(question), (deps.now ?? Date.now)());
  await appendMessage(deps.db, deps.deviceId, {
    conversationId,
    role: "user",
    content: [{ type: "text", text: question }],
    now: (deps.now ?? Date.now)(),
  });
  return runLoop(deps, conversationId);
}

/**
 * Resume after a ChatApiError: the stored history already ends with the user's question
 * (or tool results), so this only re-runs the loop.
 */
export async function continueConversation(deps: ChatDeps, conversationId: string): Promise<ChatTurnResult> {
  await requireBaseConsent(deps);
  const history = await loadMessages(deps.db, conversationId);
  if (history.at(-1)?.role !== "user") throw new Error("Nothing to continue: the last message is already an answer");
  return runLoop(deps, conversationId);
}

async function requireBaseConsent(deps: ChatDeps): Promise<void> {
  if (!(await consentFor(deps, "claude.aggregates"))) throw new ConsentRequiredError("claude.aggregates");
}

async function consentFor(deps: ChatDeps, scope: ConsentScope): Promise<boolean> {
  if (await hasConsent(deps.db, scope)) return true;
  if (!deps.askConsent) return false;
  const granted = await deps.askConsent(scope, CONSENT_TEXT[scope]);
  await recordConsent(deps.db, scope, granted, deps.deviceId, (deps.now ?? Date.now)());
  return granted;
}

async function runLoop(deps: ChatDeps, conversationId: string): Promise<ChatTurnResult> {
  const now = deps.now ?? Date.now;
  const timeZone = deps.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const maxRounds = deps.maxToolRounds ?? DEFAULT_MAX_TOOL_ROUNDS;
  const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, requests: 0 };
  const toolCalls: ToolCallReport[] = [];
  let fallbackUsed = false;
  let toolRounds = 0;

  for (;;) {
    const messages = await loadApiMessages(deps.db, conversationId);
    const params: CreateParams = {
      model: CHAT_MODEL,
      max_tokens: MAX_TOKENS,
      // Stable prefix first (tools, then this system text), date last, so the cache survives across turns.
      system: [
        { type: "text", text: SYSTEM_PROMPT },
        { type: "text", text: dateContext(now(), timeZone) },
      ],
      tools: CHAT_TOOLS.map((t) => t.definition),
      // Out of tool rounds: let Claude answer with what it has instead of asking for more.
      tool_choice: { type: toolRounds >= maxRounds ? "none" : "auto" },
      messages,
      output_config: { effort: deps.effort ?? DEFAULT_EFFORT },
      cache_control: { type: "ephemeral" },
      // A safety classifier can decline a benign health question; re-run it on the recommended fallback model.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
    };

    let res: BetaMessage;
    try {
      res = await deps.create(params);
    } catch (err) {
      throw toChatError(err);
    }

    usage.requests += 1;
    usage.inputTokens += res.usage.input_tokens;
    usage.outputTokens += res.usage.output_tokens;
    usage.cacheReadTokens += res.usage.cache_read_input_tokens ?? 0;
    usage.cacheWriteTokens += res.usage.cache_creation_input_tokens ?? 0;
    if (res.content.some((b) => b.type === "fallback") || (res.usage.iterations ?? []).some((i) => i.type === "fallback_message")) {
      fallbackUsed = true;
    }

    // Append the reply verbatim: thinking and fallback blocks must be replayed unchanged.
    await appendMessage(deps.db, deps.deviceId, {
      conversationId,
      role: "assistant",
      content: res.content as unknown as ContentBlockParam[],
      model: res.model,
      stopReason: res.stop_reason,
      inputTokens: res.usage.input_tokens,
      outputTokens: res.usage.output_tokens,
      now: now(),
    });

    const toolUses = res.content.filter((b): b is ToolUseBlock => b.type === "tool_use");

    if (res.stop_reason === "tool_use") {
      await answerToolCalls(deps, conversationId, toolUses, toolCalls);
      toolRounds += 1;
      continue;
    }
    if (res.stop_reason === "pause_turn") continue; // re-send as is; Claude resumes its turn

    // Any other stop with unanswered tool_use blocks (cut off by max_tokens, a refusal): close them,
    // or the next request would be rejected for tool_use without tool_result.
    if (toolUses.length > 0) {
      await appendMessage(deps.db, deps.deviceId, {
        conversationId,
        role: "user",
        content: toolUses.map((t) => ({
          type: "tool_result" as const,
          tool_use_id: t.id,
          is_error: true,
          content: "Not run: the reply ended before the tool could be used.",
        })),
        now: now(),
      });
    }

    const text = res.content
      .filter((b): b is Anthropic.Beta.Messages.BetaTextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();
    const base = { conversationId, text, servedBy: res.model, fallbackUsed, toolCalls, usage };
    if (res.stop_reason === "refusal") {
      return {
        ...base,
        status: "refusal",
        refusal: { category: res.stop_details?.category ?? null, explanation: res.stop_details?.explanation ?? null },
      };
    }
    if (res.stop_reason === "max_tokens") return { ...base, status: "max_tokens" };
    return { ...base, status: toolRounds >= maxRounds ? "tool_limit" : "ok" };
  }
}

/** Run every tool call of one reply and return all results in a single user message (parallel calls stay parallel). */
async function answerToolCalls(deps: ChatDeps, conversationId: string, toolUses: ToolUseBlock[], report: ToolCallReport[]) {
  const now = deps.now ?? Date.now;
  const results: ToolResultBlockParam[] = [];
  const disclosures: { toolName: string; dataClass: DataClass; summary: string; payload: string }[] = [];

  for (const call of toolUses) {
    const tool = TOOLS_BY_NAME.get(call.name);
    if (!tool) {
      results.push({ type: "tool_result", tool_use_id: call.id, is_error: true, content: `Unknown tool ${call.name}` });
      report.push({ name: call.name, dataClass: null, allowed: false, error: "unknown tool" });
      continue;
    }
    const scope = SCOPE_FOR[tool.dataClass];
    if (!(await consentFor(deps, scope))) {
      results.push({
        type: "tool_result",
        tool_use_id: call.id,
        is_error: true,
        content: `The owner has not allowed sending this kind of data (${scope}). Answer without it and mention it can be allowed in Settings.`,
      });
      report.push({ name: call.name, dataClass: tool.dataClass, allowed: false });
      continue;
    }
    try {
      const out = await tool.run(deps.db, call.input);
      const payload = JSON.stringify(out.result);
      results.push({ type: "tool_result", tool_use_id: call.id, content: payload });
      disclosures.push({ toolName: call.name, dataClass: tool.dataClass, summary: out.summary, payload });
      report.push({ name: call.name, dataClass: tool.dataClass, allowed: true });
    } catch (err) {
      // Validation and query errors carry no health data; let Claude correct its arguments.
      const message = errorText(err);
      results.push({ type: "tool_result", tool_use_id: call.id, is_error: true, content: message });
      report.push({ name: call.name, dataClass: tool.dataClass, allowed: true, error: message });
    }
  }

  const t = now();
  const messageId = await appendMessage(deps.db, deps.deviceId, { conversationId, role: "user", content: results, now: t });
  // Logged when queued: the next request sends them (and a retry after a failure would send the same).
  for (const d of disclosures) {
    await deps.db.run(
      `INSERT INTO ai_disclosures
         (id, conversation_id, message_id, sent_at_ms, tool_name, data_class, summary, payload_json, bytes,
          created_at, updated_at, origin_device_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [uuidv7(t), conversationId, messageId, t, d.toolName, d.dataClass, d.summary, d.payload, utf8Bytes(d.payload), t, t, deps.deviceId],
    );
  }
}

function errorText(err: unknown): string {
  const issues = (err as { issues?: { message: string; path: (string | number)[] }[] }).issues;
  if (Array.isArray(issues)) return `Invalid arguments: ${issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ")}`;
  return `Tool failed: ${(err as Error)?.message ?? String(err)}`;
}

function utf8Bytes(s: string): number {
  return new TextEncoder().encode(s).length;
}

function titleFrom(text: string): string {
  const t = text.trim().replace(/\s+/g, " ");
  return t.length > 60 ? `${t.slice(0, 57)}...` : t;
}
