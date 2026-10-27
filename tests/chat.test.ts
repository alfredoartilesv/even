import test from "node:test";
import assert from "node:assert/strict";
import Anthropic from "@anthropic-ai/sdk";
import { CONSENT_POLICY_VERSION, recordConsent } from "../src/features/chat/consent";
import {
  askClaude,
  CHAT_MODEL,
  ChatApiError,
  ConsentRequiredError,
  continueConversation,
  startConversation,
  type ChatDeps,
  type ClaudeCreate,
} from "../src/features/chat/engine";
import { SYSTEM_PROMPT } from "../src/features/chat/prompt";
import { deleteConversation, listConversations, listDisclosures, loadMessages } from "../src/features/chat/store";
import { upsertSamples } from "../src/features/metrics/samples";
import { localDayStart } from "../src/core/tz";
import { migratedDb } from "./helpers";

type BetaMessage = Anthropic.Beta.Messages.BetaMessage;
type Params = Anthropic.Beta.Messages.MessageCreateParamsNonStreaming;

const NOW = Date.UTC(2026, 9, 25, 18, 0, 0);
const DEV = "device-1";

function reply(content: unknown[], stop_reason: string, extra: Record<string, unknown> = {}): BetaMessage {
  return {
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: CHAT_MODEL,
    content,
    stop_reason,
    stop_sequence: null,
    stop_details: null,
    usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 80, cache_creation_input_tokens: 0 },
    ...extra,
  } as unknown as BetaMessage;
}
const text = (t: string) => ({ type: "text", text: t });
const toolUse = (id: string, name: string, input: unknown) => ({ type: "tool_use", id, name, input });

/** A scripted Messages API: returns the replies in order and records every request. */
function scripted(...replies: Array<BetaMessage | Error>) {
  const calls: Params[] = [];
  const create: ClaudeCreate = async (p) => {
    calls.push(structuredClone(p));
    const r = replies.shift();
    if (!r) throw new Error("no more scripted replies");
    if (r instanceof Error) throw r;
    return r;
  };
  return { create, calls };
}

async function seededDb() {
  const { db } = await migratedDb();
  const days = ["2026-10-19", "2026-10-20", "2026-10-21", "2026-10-22", "2026-10-23", "2026-10-24"];
  await upsertSamples(
    db,
    days.map((d, i) => ({
      source: "garmin",
      device: "Garmin",
      externalId: `${d}#0`,
      metric: "daily_steps",
      ...(() => {
        const s = localDayStart(d, "Europe/Madrid");
        return { startMs: s.startMs, offsetMin: s.offsetMin };
      })(),
      valueNum: 8000 + i * 1000,
    })),
    NOW,
  );
  await db.run(
    `INSERT INTO day_notes (id, local_day, mood, energy, body, created_at, updated_at, origin_device_id)
     VALUES ('n1', '2026-10-24', 4, 3, 'Long run, felt good', ?, ?, 'dev')`,
    [NOW, NOW],
  );
  return db;
}

async function consented(scopes: Array<"claude.aggregates" | "claude.raw_series" | "claude.notes"> = ["claude.aggregates"]) {
  const db = await seededDb();
  for (const s of scopes) await recordConsent(db, s, true, DEV, NOW - 1000);
  return db;
}

function deps(db: ChatDeps["db"], create: ClaudeCreate, extra: Partial<ChatDeps> = {}): ChatDeps {
  return { db, create, deviceId: DEV, now: () => NOW, timeZone: "Europe/Madrid", ...extra };
}

test("without consent nothing is stored or sent; asking records the decision either way", async () => {
  const db = await seededDb();
  const api = scripted(reply([text("hi")], "end_turn"));
  await assert.rejects(startConversation(deps(db, api.create), "How did I sleep?"), ConsentRequiredError);
  assert.equal(api.calls.length, 0);
  assert.equal((await listConversations(db)).length, 0);

  const asked: string[] = [];
  await assert.rejects(startConversation(deps(db, api.create, { askConsent: async (scope) => (asked.push(scope), false) }), "Q"), ConsentRequiredError);
  const res = await startConversation(deps(db, api.create, { askConsent: async (scope) => (asked.push(scope), true) }), "Q");
  assert.equal(res.status, "ok");
  assert.deepEqual(asked, ["claude.aggregates", "claude.aggregates"]);
  const rows = await db.all<{ granted: number; policy_version: string }>("SELECT granted, policy_version FROM consents ORDER BY decided_at_ms, granted");
  assert.deepEqual(
    rows.map((r) => r.granted),
    [0, 1],
  );
  assert.equal(rows[0].policy_version, CONSENT_POLICY_VERSION["claude.aggregates"]);
});

test("consent given under an older policy wording no longer counts", async () => {
  const db = await seededDb();
  await db.run(
    `INSERT INTO consents (id, scope, granted, decided_at_ms, policy_version, created_at, updated_at, origin_device_id)
     VALUES ('c', 'claude.aggregates', 1, ?, '2020-01-01', ?, ?, 'dev')`,
    [NOW, NOW, NOW],
  );
  await assert.rejects(startConversation(deps(db, scripted().create), "Q"), ConsentRequiredError);
});

test("request shape: model, effort, fallbacks, caching, stable prefix, strict tools", async () => {
  const db = await consented();
  const api = scripted(reply([text("Hello")], "end_turn"));
  await startConversation(deps(db, api.create), "Hola");
  const p = api.calls[0];
  assert.equal(p.model, "claude-opus-5-5");
  assert.equal(p.max_tokens, 16000);
  assert.deepEqual(p.output_config, { effort: "medium" });
  assert.equal(p.fallbacks, "default");
  assert.deepEqual(p.betas, ["server-side-fallback-2026-07-01"]);
  assert.deepEqual(p.cache_control, { type: "ephemeral" });
  assert.deepEqual(p.tool_choice, { type: "auto" });
  assert.equal("thinking" in p, false, "thinking stays at the model default (always on for Opus 5.5)");
  assert.deepEqual(p.system, [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }], "system is fixed: no clock in it");
  const tools = p.tools as Anthropic.Beta.Messages.BetaTool[];
  assert.deepEqual(
    tools.map((t) => t.name),
    [
      "list_metrics",
      "metric_summary",
      "compare_periods",
      "nutrition_summary",
      "manual_summary",
      "list_goals",
      "list_saved_meals",
      "list_meal_preps",
      "meal_prep_stock",
      "shopping_list",
      "get_profile",
      "energy_needs",
      "daily_series",
      "list_food_entries",
      "day_notes",
      "drink_types",
      "alcohol_impact",
      "log_food",
      "log_saved_meal",
      "save_meal",
      "create_meal_prep",
      "log_cooked_batch",
      "prep_portions",
      "add_shopping_items",
      "add_recipe_to_shopping",
      "add_drink_type",
      "log_drink",
      "log_measurement",
      "add_day_note",
      "create_goal",
    ],
  );
  for (const t of tools) {
    assert.equal(t.strict, true);
    assert.equal((t.input_schema as { additionalProperties?: boolean }).additionalProperties, false);
  }
  // The clock travels in the stored user message, so earlier turns never change.
  assert.deepEqual(p.messages, [
    {
      role: "user",
      content: [
        { type: "text", text: "Hola" },
        { type: "text", text: "[App] Now: Sunday 2026-10-25, 19:00 (time zone Europe/Madrid)." },
      ],
    },
  ]);
});

test("tool loop: parallel calls answered in one message, history replayed verbatim, disclosures logged", async () => {
  const db = await consented();
  const thinking = { type: "thinking", thinking: "", signature: "sig-abc" };
  const first = [
    thinking,
    toolUse("tu_1", "list_metrics", {}),
    toolUse("tu_2", "metric_summary", { metric: "daily_steps", from: "2026-10-19", to: "2026-10-24" }),
  ];
  const api = scripted(reply(first, "tool_use"), reply([text("You averaged 10,500 steps.")], "end_turn"));
  const res = await startConversation(deps(db, api.create), "How many steps this week?");

  assert.equal(res.status, "ok");
  assert.equal(res.text, "You averaged 10,500 steps.");
  assert.equal(res.usage.requests, 2);
  assert.equal(res.usage.inputTokens, 200);
  assert.equal(res.usage.cacheReadTokens, 160);
  assert.deepEqual(
    res.toolCalls.map((c) => [c.name, c.allowed]),
    [
      ["list_metrics", true],
      ["metric_summary", true],
    ],
  );

  const second = api.calls[1].messages;
  assert.equal(second.length, 3);
  assert.deepEqual(second[1], { role: "assistant", content: first }, "assistant turn replayed unchanged, thinking included");
  const results = second[2].content as Anthropic.Beta.Messages.BetaToolResultBlockParam[];
  assert.deepEqual(
    results.map((r) => r.tool_use_id),
    ["tu_1", "tu_2"],
  );
  const summary = JSON.parse(results[1].content as string);
  assert.equal(summary.series[0].avg, 10500);
  assert.equal(summary.series[0].days_with_data, 6);
  assert.equal(summary.series[0].trend_per_week, 7000);
  assert.equal(summary.series[0].device, "Garmin");

  const stored = await loadMessages(db, res.conversationId);
  assert.deepEqual(
    stored.map((m) => m.role),
    ["user", "assistant", "user", "assistant"],
  );
  assert.equal(stored[1].stopReason, "tool_use");

  const disclosures = await listDisclosures(db, res.conversationId);
  assert.equal(disclosures.length, 2);
  assert.ok(disclosures.every((d) => d.dataClass === "aggregate" && d.messageId === stored[2].id && d.bytes > 0));
  assert.ok(disclosures.some((d) => d.summary === "Summary of daily_steps, 2026-10-19 to 2026-10-24"));
  const [conv] = await listConversations(db);
  assert.equal(conv.title, "How many steps this week?");
});

test("raw series and notes need their own consent; refused calls send nothing", async () => {
  const db = await consented();
  const calls = [
    toolUse("tu_1", "daily_series", { metric: "daily_steps", from: "2026-10-19", to: "2026-10-24" }),
    toolUse("tu_2", "day_notes", { from: "2026-10-24", to: "2026-10-24" }),
  ];
  const api = scripted(reply(calls, "tool_use"), reply([text("ok")], "end_turn"));
  const res = await startConversation(deps(db, api.create), "Show my steps day by day");
  const results = api.calls[1].messages[2].content as Anthropic.Beta.Messages.BetaToolResultBlockParam[];
  assert.ok(results.every((r) => r.is_error === true));
  assert.match(String(results[0].content), /claude\.raw_series/);
  assert.ok(!JSON.stringify(results).includes("Long run"));
  assert.deepEqual(
    res.toolCalls.map((c) => c.allowed),
    [false, false],
  );
  assert.equal((await listDisclosures(db)).length, 0);

  const api2 = scripted(reply(calls, "tool_use"), reply([text("ok")], "end_turn"));
  const asked: string[] = [];
  await askClaude(deps(db, api2.create, { askConsent: async (s) => (asked.push(s), s === "claude.raw_series") }), res.conversationId, "Again");
  assert.deepEqual(asked, ["claude.raw_series", "claude.notes"]);
  const msgs = api2.calls[1].messages;
  const results2 = msgs[msgs.length - 1].content as Anthropic.Beta.Messages.BetaToolResultBlockParam[];
  assert.equal(results2[0].is_error, undefined);
  assert.equal(JSON.parse(results2[0].content as string).series[0].points.length, 6);
  assert.equal(results2[1].is_error, true);
  const d = await listDisclosures(db);
  assert.deepEqual(
    d.map((x) => x.dataClass),
    ["raw"],
  );
});

test("bad tool arguments come back as errors Claude can fix, and nothing is disclosed", async () => {
  const db = await consented();
  const api = scripted(
    reply([toolUse("tu_1", "metric_summary", { metric: "daily_steps", from: "2026-10-24", to: "2026-10-01" })], "tool_use"),
    reply([toolUse("tu_2", "nope", {})], "tool_use"),
    reply([text("fixed")], "end_turn"),
  );
  const res = await startConversation(deps(db, api.create), "Q");
  const r1 = api.calls[1].messages[2].content as Anthropic.Beta.Messages.BetaToolResultBlockParam[];
  assert.equal(r1[0].is_error, true);
  assert.match(String(r1[0].content), /Invalid arguments: .*from must not be after to/);
  const r2 = api.calls[2].messages[4].content as Anthropic.Beta.Messages.BetaToolResultBlockParam[];
  assert.match(String(r2[0].content), /Unknown tool nope/);
  assert.equal(res.status, "ok");
  assert.equal((await listDisclosures(db)).length, 0);
});

test("after maxToolRounds the last request forbids tools, and the result says so", async () => {
  const db = await consented();
  const api = scripted(reply([toolUse("tu_1", "list_metrics", {})], "tool_use"), reply([text("Best I can say...")], "end_turn"));
  const res = await startConversation(deps(db, api.create, { maxToolRounds: 1 }), "Q");
  assert.deepEqual(api.calls[0].tool_choice, { type: "auto" });
  assert.deepEqual(api.calls[1].tool_choice, { type: "none" });
  assert.equal(res.status, "tool_limit");
});

test("fallback and refusal are reported; a cut-off tool call is closed so the history stays valid", async () => {
  const db = await consented();
  const fb = { type: "fallback", from: { model: CHAT_MODEL }, to: { model: "claude-opus-4-8" } };
  const api = scripted(reply([fb, text("Answer from fallback")], "end_turn", { model: "claude-opus-4-8" }));
  const res = await startConversation(deps(db, api.create), "Q");
  assert.equal(res.fallbackUsed, true);
  assert.equal(res.servedBy, "claude-opus-4-8");

  const api2 = scripted(reply([text("I can't help with that.")], "refusal", { stop_details: { type: "refusal", category: "bio", explanation: "x" } }));
  const refused = await askClaude(deps(db, api2.create), res.conversationId, "Q2");
  assert.equal(refused.status, "refusal");
  assert.deepEqual(refused.refusal, { category: "bio", explanation: "x" });

  const api3 = scripted(reply([text("Let me check"), toolUse("tu_9", "list_metrics", {})], "max_tokens"), reply([text("ok")], "end_turn"));
  const cut = await askClaude(deps(db, api3.create), res.conversationId, "Q3");
  assert.equal(cut.status, "max_tokens");
  const stored = await loadMessages(db, res.conversationId);
  const last = stored.at(-1)!;
  assert.equal(last.role, "user");
  assert.deepEqual(
    (last.content as Anthropic.Beta.Messages.BetaToolResultBlockParam[]).map((b) => [b.tool_use_id, b.is_error]),
    [["tu_9", true]],
  );
  await askClaude(deps(db, api3.create), res.conversationId, "Q4"); // accepted: consecutive user turns merge
  assert.deepEqual(
    api3.calls[1].messages.slice(-2).map((m) => m.role),
    ["user", "user"],
  );
});

test("API errors become ChatApiError with safe messages, and continueConversation retries", async () => {
  const db = await consented();
  const rate = new Anthropic.RateLimitError(429, { type: "error" }, "rate limited", new Headers());
  const auth = new Anthropic.AuthenticationError(401, { type: "error" }, "invalid x-api-key", new Headers());
  const api = scripted(rate, reply([text("Back")], "end_turn"), auth);

  const err = await startConversation(deps(db, api.create), "Q").catch((e) => e);
  assert.ok(err instanceof ChatApiError);
  assert.equal(err.kind, "rate_limit");
  assert.equal(err.retryable, true);

  const [conv] = await listConversations(db);
  const resumed = await continueConversation(deps(db, api.create), conv.id);
  assert.equal(resumed.text, "Back");
  await assert.rejects(continueConversation(deps(db, api.create), conv.id), /Nothing to continue/);

  const e2 = await askClaude(deps(db, api.create), conv.id, "Q2").catch((e) => e);
  assert.equal(e2.kind, "auth");
  assert.equal(e2.retryable, false);
  assert.match(e2.message, /rejected the API key/);
});

test("conversations list newest first and soft-delete", async () => {
  const db = await consented();
  const a = await startConversation(deps(db, scripted(reply([text("a")], "end_turn")).create, { now: () => NOW }), "First");
  const b = await startConversation(deps(db, scripted(reply([text("b")], "end_turn")).create, { now: () => NOW + 1000 }), "Second ".repeat(20));
  assert.deepEqual(
    (await listConversations(db)).map((c) => c.id),
    [b.conversationId, a.conversationId],
  );
  assert.equal((await listConversations(db))[0].title!.length, 60);
  await deleteConversation(db, b.conversationId, NOW + 2000);
  assert.deepEqual(
    (await listConversations(db)).map((c) => c.id),
    [a.conversationId],
  );
});
