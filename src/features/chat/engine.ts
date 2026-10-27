import Anthropic from "@anthropic-ai/sdk";
import type { SqlDriver } from "../../db/driver";
import { uuidv7 } from "../../core/uuidv7";
import { logAgentAction, WRITE_TOOLS, WRITE_TOOLS_BY_NAME, type ActionProposal } from "./actions";
import { CONSENT_TEXT, hasConsent, recordConsent, SCOPE_FOR, type ConsentScope, type DataClass } from "./consent";
import { imageBytes, validateAttachments, type ImageAttachment } from "./images";
import { dateContext, SYSTEM_PROMPT } from "./prompt";
import { appendMessage, createConversation, loadApiMessages, loadMessages, renameConversation } from "./store";
import { CHAT_TOOLS, TOOLS_BY_NAME } from "./tools";
import { createLogger } from "../../core/log";

const chatLog = createLogger("chat");

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
const DEFAULT_MAX_TOOL_ROUNDS = 10;
/** Read tools, then write tools, in a fixed order: the list is part of the cached prompt prefix. */
const TOOL_DEFINITIONS = [...CHAT_TOOLS.map((t) => t.definition), ...WRITE_TOOLS.map((t) => t.definition)];

/** One non-streaming Messages API call. The real one is claudeCreate() in client.ts; tests pass a fake. */
export type ClaudeCreate = (params: CreateParams) => Promise<BetaMessage>;

export interface ChatDeps {
  db: SqlDriver;
  create: ClaudeCreate;
  deviceId: string;
  now?: () => number;
  /** Zone for "now" and for the times of logged entries. Default: the device's zone. */
  timeZone?: string;
  effort?: Effort;
  /**
   * Asked when a kind of data has no consent yet. Show CONSENT_TEXT[scope] and resolve with
   * the owner's answer; the decision is recorded either way. Without it, missing consent is a "no".
   */
  askConsent?: (scope: ConsentScope, text: string) => Promise<boolean>;
  /**
   * Asked before every change the assistant wants to make. Show proposal.summary and
   * proposal.lines, resolve true to save. Without it, every change is declined.
   */
  confirmAction?: (proposal: ActionProposal) => Promise<boolean>;
  maxToolRounds?: number;
}

export interface ToolCallReport {
  name: string;
  dataClass: DataClass | null;
  /** false when consent was missing; nothing was sent. */
  allowed: boolean;
  error?: string;
}

export interface ActionReport {
  /** agent_actions id: pass to undoAgentAction. */
  id: string;
  tool: string;
  summary: string;
  status: "applied" | "declined" | "failed";
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
  /** Changes the assistant proposed in this turn and what happened to them. */
  actions: ActionReport[];
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; requests: number };
}

export interface AskOptions {
  /** Photos to send with the question (needs the claude.photos consent). */
  images?: ImageAttachment[];
}

/** No consent to send something: show CONSENT_TEXT[scope] and record the answer first. Nothing was sent or stored. */
export class ConsentRequiredError extends Error {
  constructor(readonly scope: ConsentScope) {
    super(scope === "claude.photos" ? "Allow sending photos to Claude first" : "Allow sending your questions and data summaries to Claude first");
    this.name = "ConsentRequiredError";
  }
}

export type ChatErrorKind = "auth" | "billing" | "rate_limit" | "overloaded" | "network" | "bad_request" | "server" | "unknown";

/** A failed API call, with a message safe to show. The conversation stays valid: retry with continueConversation(). */
export class ChatApiError extends Error {
  /**
   * The conversation the failed request belonged to. Set by the loop, so a screen that started a
   * new chat (and so has no id yet) can still offer Try again: the question is already stored.
   */
  conversationId?: string;

  constructor(
    readonly kind: ChatErrorKind,
    message: string,
    readonly retryable: boolean,
    readonly status?: number,
    /** The API's own wording and request id, for a "technical details" line. Never the key. */
    readonly detail?: string,
  ) {
    super(message);
    this.name = "ChatApiError";
  }
}

/** The API's message ("Your credit balance is too low...") plus the request id, without the JSON wrapping. */
function apiDetail(err: InstanceType<typeof Anthropic.APIError>): string {
  const body = err.error as { error?: { message?: unknown } } | undefined;
  const msg = typeof body?.error?.message === "string" ? body.error.message : err.message;
  const id = (err as { requestID?: string | null }).requestID ?? (err as { request_id?: string }).request_id;
  return id ? `${msg} (request ${id})` : msg;
}

/** Typed SDK errors, most specific first. Never includes the API key (the SDK does not echo it). */
export function toChatError(err: unknown): ChatApiError {
  if (err instanceof ChatApiError) return err;
  if (err instanceof Anthropic.APIConnectionError) return new ChatApiError("network", "Could not reach Claude. Check the connection and try again.", true);
  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
    return new ChatApiError("auth", "Claude rejected the API key. Check it in Settings.", false, err.status);
  }
  if (err instanceof Anthropic.RateLimitError) return new ChatApiError("rate_limit", "Claude is rate-limiting this key. Wait a moment and try again.", true, 429);
  if (err instanceof Anthropic.BadRequestError) {
    const detail = apiDetail(err);
    if (/credit balance|billing|purchase credits/i.test(detail)) {
      return new ChatApiError("billing", "Your Anthropic account is out of credits, so Claude can't answer. Add credits in the Anthropic Console, then try again.", true, 400, detail);
    }
    return new ChatApiError("bad_request", "Claude couldn't process this message. Try rewording it or starting a new chat.", false, 400, detail);
  }
  if (err instanceof Anthropic.APIError) {
    const status = err.status;
    if (status === 529) return new ChatApiError("overloaded", "Claude is overloaded right now. Try again shortly.", true, status);
    return new ChatApiError("server", `Claude answered with an error${status ? ` (HTTP ${status})` : ""}. Try again.`, true, status);
  }
  return new ChatApiError("unknown", `Chat failed: ${(err as Error)?.message ?? String(err)}`, false);
}

/** Start a conversation with a first question (and optional photos). */
export async function startConversation(deps: ChatDeps, text: string, opts: AskOptions = {}): Promise<ChatTurnResult> {
  await requireConsents(deps, opts);
  const now = (deps.now ?? Date.now)();
  const id = await createConversation(deps.db, deps.deviceId, { title: titleFrom(text, opts), model: CHAT_MODEL, now });
  return askClaude(deps, id, text, opts);
}

/** Add a question to a conversation and run Claude (with local tools) until it answers. */
export async function askClaude(deps: ChatDeps, conversationId: string, text: string, opts: AskOptions = {}): Promise<ChatTurnResult> {
  const question = text.trim();
  const images = validateAttachments(opts.images ?? []);
  if (!question && images.length === 0) throw new Error("Empty message");
  await requireConsents(deps, opts);
  const now = deps.now ?? Date.now;
  const timeZone = deps.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const history = await loadMessages(deps.db, conversationId);
  if (history.length === 0) await renameConversation(deps.db, conversationId, titleFrom(question, opts), now());

  // Photos first, then the question, then the app's clock line. Stored as sent, so the cache prefix stays stable.
  const content: ContentBlockParam[] = [
    ...images.map((i) => ({ type: "image" as const, source: { type: "base64" as const, media_type: i.mediaType, data: i.data } })),
    ...(question ? [{ type: "text" as const, text: question }] : []),
    { type: "text", text: `[App] ${dateContext(now(), timeZone)}` },
  ];
  const t = now();
  const messageId = await appendMessage(deps.db, deps.deviceId, { conversationId, role: "user", content, now: t });
  for (const img of images) {
    const bytes = imageBytes(img.data);
    await insertDisclosure(deps, {
      conversationId,
      messageId,
      at: t,
      toolName: null,
      dataClass: "photo",
      summary: `Photo (${img.mediaType}, ${Math.round(bytes / 1024)} KB)`,
      payload: JSON.stringify({ media_type: img.mediaType, bytes, stored_in: "chat_messages" }),
      bytes,
    });
  }
  return runLoop(deps, conversationId);
}

/**
 * Resume after a ChatApiError: the stored history already ends with the owner's question
 * (or tool results), so this only re-runs the loop.
 */
export async function continueConversation(deps: ChatDeps, conversationId: string): Promise<ChatTurnResult> {
  await requireConsents(deps, {});
  const history = await loadMessages(deps.db, conversationId);
  if (history.at(-1)?.role !== "user") throw new Error("Nothing to continue: the last message is already an answer");
  return runLoop(deps, conversationId);
}

async function requireConsents(deps: ChatDeps, opts: AskOptions): Promise<void> {
  if (!(await consentFor(deps, "claude.aggregates"))) throw new ConsentRequiredError("claude.aggregates");
  if ((opts.images?.length ?? 0) > 0 && !(await consentFor(deps, "claude.photos"))) throw new ConsentRequiredError("claude.photos");
}

async function consentFor(deps: ChatDeps, scope: ConsentScope): Promise<boolean> {
  if (await hasConsent(deps.db, scope)) return true;
  if (!deps.askConsent) return false;
  const granted = await deps.askConsent(scope, CONSENT_TEXT[scope]);
  await recordConsent(deps.db, scope, granted, deps.deviceId, (deps.now ?? Date.now)());
  chatLog.info("consent decided", { scope, granted });
  return granted;
}

async function runLoop(deps: ChatDeps, conversationId: string): Promise<ChatTurnResult> {
  const now = deps.now ?? Date.now;
  const maxRounds = deps.maxToolRounds ?? DEFAULT_MAX_TOOL_ROUNDS;
  const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, requests: 0 };
  const toolCalls: ToolCallReport[] = [];
  const actions: ActionReport[] = [];
  let fallbackUsed = false;
  let toolRounds = 0;

  for (;;) {
    const messages = await loadApiMessages(deps.db, conversationId);
    const params: CreateParams = {
      model: CHAT_MODEL,
      max_tokens: MAX_TOKENS,
      // Cached prefix: tools, then this fixed system text (explicit breakpoint), then the history
      // (automatic breakpoint at its end). The clock lives in each user message, not here.
      system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
      tools: TOOL_DEFINITIONS,
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
    const started = now();
    chatLog.debug("request", { conversationId, round: toolRounds + 1, messages: messages.length, toolChoice: params.tool_choice?.type });
    try {
      res = await deps.create(params);
    } catch (err) {
      const e = toChatError(err);
      // An empty credit balance or a rejected key is the account's state, not an app fault: warn, not error.
      const level = e.kind === "billing" || e.kind === "auth" ? "warn" : "error";
      chatLog[level]("request failed", { conversationId, kind: e.kind, err: e, ms: now() - started });
      e.conversationId = conversationId;
      throw e;
    }
    chatLog.info("reply", {
      conversationId,
      model: res.model,
      stop: res.stop_reason,
      ms: now() - started,
      inputTokens: res.usage.input_tokens,
      outputTokens: res.usage.output_tokens,
      cacheRead: res.usage.cache_read_input_tokens ?? 0,
      toolUses: res.content.filter((b) => b.type === "tool_use").length,
    });

    usage.requests += 1;
    usage.inputTokens += res.usage.input_tokens;
    usage.outputTokens += res.usage.output_tokens;
    usage.cacheReadTokens += res.usage.cache_read_input_tokens ?? 0;
    usage.cacheWriteTokens += res.usage.cache_creation_input_tokens ?? 0;
    if (res.content.some((b) => b.type === "fallback") || (res.usage.iterations ?? []).some((i) => i.type === "fallback_message")) {
      if (!fallbackUsed) chatLog.warn("served by the fallback model", { conversationId, model: res.model });
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
      await answerToolCalls(deps, conversationId, toolUses, toolCalls, actions);
      toolRounds += 1;
      continue;
    }
    if (res.stop_reason === "pause_turn") continue; // re-send as is; Claude resumes its turn

    // Any other stop with unanswered tool_use blocks (cut off by max_tokens, a refusal): close them,
    // or the next request would be rejected for tool_use without tool_result. Nothing was run.
    if (toolUses.length > 0) {
      await appendMessage(deps.db, deps.deviceId, {
        conversationId,
        role: "user",
        content: toolUses.map((tu) => ({
          type: "tool_result" as const,
          tool_use_id: tu.id,
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
    const base = { conversationId, text, servedBy: res.model, fallbackUsed, toolCalls, actions, usage };
    chatLog.info("turn finished", { conversationId, status: res.stop_reason, requests: usage.requests, toolCalls: toolCalls.length, actions: actions.length });
    if (res.stop_reason === "refusal") {
      chatLog.warn("refusal", { conversationId, category: res.stop_details?.category ?? null });
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
async function answerToolCalls(
  deps: ChatDeps,
  conversationId: string,
  toolUses: ToolUseBlock[],
  report: ToolCallReport[],
  actions: ActionReport[],
) {
  const now = deps.now ?? Date.now;
  const timeZone = deps.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const results: ToolResultBlockParam[] = [];
  const disclosures: { toolName: string; dataClass: DataClass; summary: string; payload: string }[] = [];
  const error = (id: string, content: string): ToolResultBlockParam => ({ type: "tool_result", tool_use_id: id, is_error: true, content });

  for (const call of toolUses) {
    const writer = WRITE_TOOLS_BY_NAME.get(call.name);
    if (writer) {
      // Validate and describe first; then the owner decides; only then write.
      let prepared;
      try {
        prepared = await writer.prepare({ db: deps.db, deviceId: deps.deviceId, now: now(), timeZone, conversationId }, call.input);
      } catch (err) {
        const message = errorText(err);
        chatLog.warn("write tool input rejected", { tool: call.name, err });
        results.push(error(call.id, message));
        report.push({ name: call.name, dataClass: null, allowed: true, error: message });
        continue;
      }
      const proposal: ActionProposal = { tool: prepared.tool, summary: prepared.summary, lines: prepared.lines };
      const approved = deps.confirmAction ? await deps.confirmAction(proposal) : false;
      chatLog.info("change proposed", { tool: call.name, approved });
      const log = { conversationId, tool: call.name, summary: prepared.summary, input: call.input, deviceId: deps.deviceId };
      if (!approved) {
        const id = await logAgentAction(deps.db, { ...log, status: "declined", now: now() });
        actions.push({ id, tool: call.name, summary: prepared.summary, status: "declined" });
        results.push(error(call.id, "The owner declined this change. Nothing was saved. Ask what they want different before proposing it again."));
        report.push({ name: call.name, dataClass: null, allowed: true });
        continue;
      }
      try {
        const applied = await prepared.apply();
        const id = await logAgentAction(deps.db, { ...log, status: "applied", rows: applied.rows, now: now() });
        actions.push({ id, tool: call.name, summary: prepared.summary, status: "applied" });
        results.push({ type: "tool_result", tool_use_id: call.id, content: JSON.stringify({ status: "saved", ...(applied.result as object) }) });
        report.push({ name: call.name, dataClass: null, allowed: true });
      } catch (err) {
        const message = errorText(err);
        chatLog.error("change failed, nothing saved", { tool: call.name, err });
        const id = await logAgentAction(deps.db, { ...log, status: "failed", error: message, now: now() });
        actions.push({ id, tool: call.name, summary: prepared.summary, status: "failed", error: message });
        results.push(error(call.id, `Saving failed, nothing was saved: ${message}`));
        report.push({ name: call.name, dataClass: null, allowed: true, error: message });
      }
      continue;
    }

    const tool = TOOLS_BY_NAME.get(call.name);
    if (!tool) {
      chatLog.warn("unknown tool requested", { tool: call.name });
      results.push(error(call.id, `Unknown tool ${call.name}`));
      report.push({ name: call.name, dataClass: null, allowed: false, error: "unknown tool" });
      continue;
    }
    const scope = SCOPE_FOR[tool.dataClass];
    if (!(await consentFor(deps, scope))) {
      chatLog.info("tool blocked: no consent", { tool: call.name, scope });
      results.push(error(call.id, `The owner has not allowed sending this kind of data (${scope}). Answer without it and mention it can be allowed in Settings.`));
      report.push({ name: call.name, dataClass: tool.dataClass, allowed: false });
      continue;
    }
    try {
      const ranAt = now();
      const out = await tool.run(deps.db, call.input);
      const payload = JSON.stringify(out.result);
      chatLog.debug("tool ran", { tool: call.name, dataClass: tool.dataClass, bytes: utf8Bytes(payload), ms: now() - ranAt });
      results.push({ type: "tool_result", tool_use_id: call.id, content: payload });
      disclosures.push({ toolName: call.name, dataClass: tool.dataClass, summary: out.summary, payload });
      report.push({ name: call.name, dataClass: tool.dataClass, allowed: true });
    } catch (err) {
      // Validation and query errors carry no health data; let Claude correct its arguments.
      const message = errorText(err);
      chatLog.warn("tool failed", { tool: call.name, err });
      results.push(error(call.id, message));
      report.push({ name: call.name, dataClass: tool.dataClass, allowed: true, error: message });
    }
  }

  const t = now();
  const messageId = await appendMessage(deps.db, deps.deviceId, { conversationId, role: "user", content: results, now: t });
  // Logged when queued: the next request sends them (and a retry after a failure would send the same).
  for (const d of disclosures) {
    await insertDisclosure(deps, { conversationId, messageId, at: t, ...d, bytes: utf8Bytes(d.payload) });
  }
}

async function insertDisclosure(
  deps: ChatDeps,
  d: { conversationId: string; messageId: string; at: number; toolName: string | null; dataClass: DataClass; summary: string; payload: string; bytes: number },
) {
  await deps.db.run(
    `INSERT INTO ai_disclosures
       (id, conversation_id, message_id, sent_at_ms, tool_name, data_class, summary, payload_json, bytes,
        created_at, updated_at, origin_device_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [uuidv7(d.at), d.conversationId, d.messageId, d.at, d.toolName, d.dataClass, d.summary, d.payload, d.bytes, d.at, d.at, deps.deviceId],
  );
}

function errorText(err: unknown): string {
  const issues = (err as { issues?: { message: string; path: (string | number)[] }[] }).issues;
  if (Array.isArray(issues)) return `Invalid arguments: ${issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ")}`;
  return `Tool failed: ${(err as Error)?.message ?? String(err)}`;
}

function utf8Bytes(s: string): number {
  return new TextEncoder().encode(s).length;
}

function titleFrom(text: string, opts: AskOptions = {}): string {
  const t = text.trim().replace(/\s+/g, " ") || ((opts.images?.length ?? 0) > 0 ? "Photo" : "Chat");
  return t.length > 60 ? `${t.slice(0, 57)}...` : t;
}
