import test from "node:test";
import assert from "node:assert/strict";
import type Anthropic from "@anthropic-ai/sdk";
import { toBubble } from "../src/features/chat/bubbles";
import { recordConsent, type ConsentScope } from "../src/features/chat/consent";
import { CONTEXT_TOOLS, contextSnapshot } from "../src/features/chat/context";
import { dictationError, dictationLanguage, withDictation } from "../src/features/chat/dictation";
import {
  askClaude,
  CHAT_MODEL,
  ChatApiError,
  ConsentRequiredError,
  DEFAULT_EFFORT,
  startConversation,
  type ChatDeps,
  type ClaudeCreate,
} from "../src/features/chat/engine";
import {
  cleanFileName,
  fileKind,
  MAX_FILES_PER_MESSAGE,
  MAX_TEXT_CHARS,
  toFileAttachment,
  validateFiles,
  type FileAttachment,
} from "../src/features/chat/files";
import { listDisclosures, loadMessages } from "../src/features/chat/store";
import { TOOLS_BY_NAME } from "../src/features/chat/tools";
import { localDayStart } from "../src/core/tz";
import { saveProfile } from "../src/features/settings/profile";
import { addTrip } from "../src/features/mealprep/spending";
import { upsertSamples } from "../src/features/metrics/samples";
import type { SampleInput } from "../src/features/sync/types";
import { listMeasurements } from "../src/features/journal/entries";
import { migratedDb } from "./helpers";
import { addRecognitionQuery } from "../scripts/android-manifest.mjs";
import { MICROPHONE_USAGE, patchInfoPlist, SPEECH_USAGE } from "../scripts/ios-project.mjs";

type BetaMessage = Anthropic.Beta.Messages.BetaMessage;
type Params = Anthropic.Beta.Messages.MessageCreateParamsNonStreaming;
type Block = Anthropic.Beta.Messages.BetaContentBlockParam;
type ToolResult = Anthropic.Beta.Messages.BetaToolResultBlockParam;

const NOW = Date.UTC(2026, 9, 28, 11, 0, 0); // Wednesday 28 Oct 2026, 12:00 in Madrid
const TZ = "Europe/Madrid";
const DEV = "device-1";
/** "%PDF-1.4\n%âãÏÓ\n" and a little more: enough to look like a PDF. */
const PDF = Buffer.from("%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n").toString("base64");
const IMG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

function reply(content: unknown[], stop_reason: string, extra: Record<string, unknown> = {}): BetaMessage {
  return {
    id: "msg",
    type: "message",
    role: "assistant",
    model: CHAT_MODEL,
    content,
    stop_reason,
    stop_sequence: null,
    stop_details: null,
    usage: { input_tokens: 50, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    ...extra,
  } as unknown as BetaMessage;
}
const text = (t: string) => ({ type: "text", text: t });
const call = (id: string, name: string, input: unknown) => ({ type: "tool_use", id, name, input });

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

const midnight = (day: string) => localDayStart(day, TZ);
const sample = (metric: string, day: string, v: number | string, externalId = `${day}#0`): SampleInput => ({
  source: "garmin",
  device: "Garmin",
  externalId,
  metric,
  startMs: midnight(day).startMs,
  offsetMin: midnight(day).offsetMin,
  ...(typeof v === "number" ? { valueNum: v } : { valueText: v }),
});
const run = (day: string, id: string, minutes: number, km: number): SampleInput[] => [
  sample("activity_activityType", day, "running", id),
  sample("activity_durationInSeconds", day, minutes * 60, id),
  sample("activity_distanceInMeters", day, km * 1000, id),
  sample("activity_activeKilocalories", day, minutes * 10, id),
];

/** A phone with a week of steps, two runs, a weigh-in, a profile and a shopping trip. */
async function phone(scopes: ConsentScope[] = ["claude.aggregates"]) {
  const { db } = await migratedDb();
  const days = ["2026-10-22", "2026-10-23", "2026-10-24", "2026-10-25", "2026-10-26", "2026-10-27"];
  await upsertSamples(db, [
    ...days.map((d, i) => sample("daily_steps", d, 9000 + i * 500)),
    sample("body_weightInGrams", "2026-10-27", 78_400),
    ...run("2026-10-24", "activity:1", 50, 10),
    ...run("2026-10-27", "activity:2", 30, 6),
  ]);
  await saveProfile(db, { sex: "male", birthDate: "1990-05-01", heightCm: 180, activity: "moderate", kgPerWeek: -0.25 }, "2026-10-28", NOW);
  await addTrip(db, { shop: "Mercadona", amount: 64.3, day: "2026-10-26", timeZone: TZ }, "user", NOW);
  for (const s of scopes) await recordConsent(db, s, true, DEV, NOW - 1000);
  return db;
}

function deps(db: ChatDeps["db"], create: ClaudeCreate, extra: Partial<ChatDeps> = {}): ChatDeps {
  return { db, create, deviceId: DEV, now: () => NOW, timeZone: TZ, ...extra };
}

const firstContent = (p: Params) => p.messages[0].content as Block[];
const snapshotOf = (p: Params) => {
  const b = firstContent(p).find((x) => x.type === "text" && x.text.startsWith("[App] Snapshot")) as { text: string } | undefined;
  return b ? JSON.parse(b.text.slice(b.text.indexOf("{"))) : null;
};
const pdf = (name = "Blood test.pdf"): FileAttachment => ({ kind: "pdf", name, mediaType: "application/pdf", data: PDF });

// ---- Model and request cost ----

test("the chat runs on Claude Haiku 5.5 at medium effort, without a fallback model", async () => {
  assert.equal(CHAT_MODEL, "claude-haiku-5-5");
  assert.equal(DEFAULT_EFFORT, "medium");
  const db = await phone();
  const api = scripted(reply([text("Hola")], "end_turn"));
  await startConversation(deps(db, api.create), "Hola");
  const p = api.calls[0];
  assert.equal(p.model, "claude-haiku-5-5");
  assert.deepEqual(p.output_config, { effort: "medium" });
  assert.equal("fallbacks" in p, false);
  assert.equal("temperature" in p, false, "Haiku 5.5 rejects sampling parameters");
  assert.equal("thinking" in p, false, "adaptive thinking is the default; budget_tokens would be rejected");
});

test("a question the snapshot answers costs one request: no lookup rounds for profile, goals or metric names", async () => {
  const db = await phone();
  const api = scripted(reply([text("Your target is about 2,500 kcal.")], "end_turn"));
  const res = await startConversation(deps(db, api.create), "What is my calorie target?");
  assert.equal(res.usage.requests, 1);
  assert.equal(res.toolCalls.length, 0);
  const snap = snapshotOf(api.calls[0]);
  assert.ok(snap.get_profile.tdee_kcal > 1500, "the profile with its estimates is in the first message");
  assert.equal(snap.get_profile.latest_weight.kg, 78.4);
  assert.ok(snap.list_metrics.metrics.some((m: { metric: string }) => m.metric === "daily_steps"));
  assert.ok(Array.isArray(snap.list_goals.goals));
  assert.equal(snap.food_today.from, "2026-10-28");
  assert.equal(snap.workouts_last_7_days.sessions, 2);
  assert.ok(Array.isArray(snap.meal_prep_stock.batches));
});

test("the snapshot is sent once, in the first message, and logged as a summary sent to Claude", async () => {
  const db = await phone();
  const api = scripted(reply([text("a")], "end_turn"), reply([text("b")], "end_turn"));
  const res = await startConversation(deps(db, api.create), "First");
  await askClaude(deps(db, api.create), res.conversationId, "Second");

  const second = api.calls[1].messages;
  assert.equal(second.length, 3);
  assert.deepEqual(second[0], api.calls[0].messages[0], "the first message is replayed unchanged, so the cached prefix holds");
  const later = second[2].content as Block[];
  assert.ok(!later.some((b) => b.type === "text" && b.text.startsWith("[App] Snapshot")), "later questions carry only the clock");

  const d = await listDisclosures(db, res.conversationId);
  const ctx = d.filter((x) => x.summary.startsWith("Chat context"));
  assert.equal(ctx.length, 1);
  assert.equal(ctx[0].dataClass, "aggregate");
  assert.equal(ctx[0].toolName, null);
  assert.match(ctx[0].summary, new RegExp(CONTEXT_TOOLS.join(", ")));
  const stored = await loadMessages(db, res.conversationId);
  assert.equal(ctx[0].messageId, stored[0].id);
});

test("the snapshot holds only summaries: no single food entries, notes or day-by-day values", async () => {
  const db = await phone();
  await db.run(
    `INSERT INTO day_notes (id, local_day, mood, energy, body, created_at, updated_at, origin_device_id)
     VALUES ('n1', '2026-10-27', 2, 2, 'Private worry', ?, ?, 'dev')`,
    [NOW, NOW],
  );
  const snap = await contextSnapshot(db, NOW, TZ);
  assert.ok(!snap.payload.includes("Private worry"));
  assert.ok(!snap.payload.includes('"points"'), "no daily series");
  for (const name of CONTEXT_TOOLS) assert.equal(TOOLS_BY_NAME.get(name)!.dataClass, "aggregate", `${name} needs no consent beyond aggregates`);
});

test("an empty phone still gets a snapshot, and a part that fails is left out instead of failing the chat", async () => {
  const { db } = await migratedDb();
  await recordConsent(db, "claude.aggregates", true, DEV, NOW - 1000);
  const snap = await contextSnapshot(db, NOW, TZ);
  assert.match(snap.summary, /list_metrics/);
  await db.run("DROP VIEW IF EXISTS daily_nutrition");
  const partial = await contextSnapshot(db, NOW, TZ);
  assert.ok(!partial.summary.includes("nutrition_summary"));
  assert.ok(partial.summary.includes("get_profile"));
});

// ---- Files ----

test("a PDF goes as a document block before the question, needs its own consent, and is logged", async () => {
  const db = await phone();
  const api = scripted(reply([text("Your LDL is above the range.")], "end_turn"));
  await assert.rejects(startConversation(deps(db, api.create), "Explain", { files: [pdf()] }), ConsentRequiredError);
  assert.equal(api.calls.length, 0, "nothing sent without the files consent");

  const asked: string[] = [];
  const res = await startConversation(deps(db, api.create, { askConsent: async (s) => (asked.push(s), true) }), "Explain this", { files: [pdf()] });
  assert.deepEqual(asked, ["claude.files"]);
  assert.equal(res.status, "ok");
  const content = firstContent(api.calls[0]);
  assert.deepEqual(content[0], { type: "document", title: "Blood test.pdf", source: { type: "base64", media_type: "application/pdf", data: PDF } });
  assert.deepEqual(content[1], { type: "text", text: "Explain this" });

  const files = (await listDisclosures(db, res.conversationId)).filter((d) => d.dataClass === "file");
  assert.equal(files.length, 1);
  assert.match(files[0].summary, /^File Blood test\.pdf \(PDF, \d+ KB\)$/);
  const [row] = await db.all<{ payload_json: string }>("SELECT payload_json FROM ai_disclosures WHERE id = ?", [files[0].id]);
  assert.equal(JSON.parse(row.payload_json).stored_in, "chat_messages", "the payload logs the file's size, not its content again");
  assert.ok(!row.payload_json.includes(PDF));
});

test("a CSV goes as a plain-text document, and a file alone (no question) starts a chat named after it", async () => {
  const db = await phone(["claude.aggregates", "claude.files"]);
  const csv: FileAttachment = { kind: "text", name: "glucose.csv", mediaType: "text/plain", data: "\uFEFFday,mg/dL\n2026-10-27,96\n" };
  const api = scripted(reply([text("One reading, 96 mg/dL.")], "end_turn"));
  const res = await startConversation(deps(db, api.create), "", { files: [csv] });
  const [doc] = firstContent(api.calls[0]);
  assert.deepEqual(doc, { type: "document", title: "glucose.csv", source: { type: "text", media_type: "text/plain", data: "day,mg/dL\n2026-10-27,96\n" } });
  const [conv] = await db.all<{ title: string }>("SELECT title FROM chat_conversations WHERE id = ?", [res.conversationId]);
  assert.equal(conv.title, "glucose.csv");
  const stored = await loadMessages(db, res.conversationId);
  assert.deepEqual(toBubble(stored[0])?.files, ["glucose.csv"]);
  assert.deepEqual(toBubble(stored[0])?.texts, [], "the app's own lines stay hidden");
});

test("files are checked before anything is stored: not a PDF, too long, too many, odd names", async () => {
  assert.throws(() => toFileAttachment({ ...pdf(), data: Buffer.from("hello").toString("base64") }), /is not a PDF/);
  assert.throws(() => toFileAttachment({ ...pdf(), data: "not base64!" }), /not valid base64/);
  assert.throws(() => toFileAttachment({ kind: "text", name: "a.txt", mediaType: "text/plain", data: "   " }), /is empty/);
  assert.throws(() => toFileAttachment({ kind: "text", name: "a.txt", mediaType: "text/plain", data: "x".repeat(MAX_TEXT_CHARS + 1) }), /too long/);
  assert.throws(() => validateFiles(Array.from({ length: MAX_FILES_PER_MESSAGE + 1 }, () => pdf())), /At most 3 files/);
  assert.equal(cleanFileName("C:\\Users\\me\\Downloads\\lab\u0007.pdf"), "lab.pdf");
  assert.equal(cleanFileName("/storage/emulated/0/"), "File");
  assert.equal(fileKind("report.PDF", ""), "pdf");
  assert.equal(fileKind("export.csv", "application/vnd.ms-excel"), "text");
  assert.equal(fileKind("notes", "text/markdown"), "text");
  assert.equal(fileKind("photo.heic", "image/heic"), null);

  const db = await phone(["claude.aggregates", "claude.files"]);
  const api = scripted();
  await assert.rejects(startConversation(deps(db, api.create), "Q", { files: [{ ...pdf(), data: "AAAA" }] }), /is not a PDF/);
  assert.equal((await db.all("SELECT id FROM chat_messages")).length, 0);
});

test("photo and PDF in one message: photos first, then files, then the question; each logged under its own kind", async () => {
  const db = await phone(["claude.aggregates", "claude.files", "claude.photos"]);
  const api = scripted(reply([text("ok")], "end_turn"));
  const res = await startConversation(deps(db, api.create), "Label and lab report", {
    images: [{ mediaType: "image/png", data: IMG }],
    files: [pdf("Lab.pdf")],
  });
  assert.deepEqual(
    firstContent(api.calls[0]).map((b) => b.type),
    ["image", "document", "text", "text", "text"],
  );
  const kinds = (await listDisclosures(db, res.conversationId)).map((d) => d.dataClass).sort();
  assert.deepEqual(kinds, ["aggregate", "file", "photo"]);
});

test("a lab report leads to a proposed measurement; the owner confirms and it is saved", async () => {
  const db = await phone(["claude.aggregates", "claude.files"]);
  const api = scripted(
    reply(
      [
        text("Fasting glucose 96 mg/dL, within range. Shall I log it?"),
        call("tu_1", "log_measurement", {
          kind: "glucose",
          value_num: 96,
          value_num2: null,
          value_text: null,
          unit: "mg/dL",
          day: "2026-10-27",
          time: "08:00",
          notes: "From lab report",
        }),
      ],
      "tool_use",
    ),
    reply([text("Logged.")], "end_turn"),
  );
  const proposals: string[] = [];
  const res = await startConversation(deps(db, api.create, { confirmAction: async (p) => (proposals.push(p.summary), true) }), "Log my glucose from this", {
    files: [pdf()],
  });
  assert.deepEqual(proposals, ["Log glucose: 96 mg/dL"]);
  assert.equal(res.actions[0].status, "applied");
  const rows = await listMeasurements(db, "2026-10-27", "2026-10-27", "glucose");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].value, 96);
  assert.equal(rows[0].createdBy, "assistant");
});

// ---- New tools ----

test("workout_summary totals sessions per sport and week; list_workouts needs the detailed-records consent", async () => {
  const db = await phone();
  const sum = await TOOLS_BY_NAME.get("workout_summary")!.run(db, { from: "2026-10-01", to: "2026-10-28" });
  const r = sum.result as {
    sessions: number;
    by_sport: { sport: string; sessions: number; minutes: number; km: number }[];
    by_week: { week_of: string; sessions: number }[];
  };
  assert.equal(r.sessions, 2);
  assert.deepEqual(r.by_sport[0], { sport: "running", sessions: 2, minutes: 80, km: 16, kcal: 800 });
  assert.deepEqual(
    r.by_week.filter((w) => w.sessions > 0).map((w) => [w.week_of, w.sessions]),
    [
      ["2026-10-19", 1],
      ["2026-10-26", 1],
    ],
  );

  const api = scripted(reply([call("tu_1", "list_workouts", { from: "2026-10-20", to: "2026-10-28" })], "tool_use"), reply([text("ok")], "end_turn"));
  const res = await startConversation(deps(db, api.create), "List my runs");
  const [blocked] = api.calls[1].messages.at(-1)!.content as ToolResult[];
  assert.equal(blocked.is_error, true);
  assert.match(String(blocked.content), /claude\.raw_series/);
  assert.deepEqual(res.toolCalls[0], { name: "list_workouts", dataClass: "raw", allowed: false });
});

test("list_workouts gives single sessions with pace; it is limited to 92 days", async () => {
  const db = await phone(["claude.aggregates", "claude.raw_series"]);
  const out = await TOOLS_BY_NAME.get("list_workouts")!.run(db, { from: "2026-10-20", to: "2026-10-28" });
  const w = (out.result as { workouts: { day: string; sport: string; minutes: number; km: number; pace: string | null }[] }).workouts;
  assert.deepEqual(
    w.map((x) => [x.day, x.sport, x.minutes, x.km]),
    [
      ["2026-10-27", "running", 30, 6],
      ["2026-10-24", "running", 50, 10],
    ],
  );
  assert.ok(w[0].pace);
  await assert.rejects(TOOLS_BY_NAME.get("list_workouts")!.run(db, { from: "2026-01-01", to: "2026-10-28" }), /limited to 92 days/);
});

test("grocery_spending sums the trips per supermarket in the owner's currency", async () => {
  const db = await phone();
  await addTrip(db, { shop: "mercadona", amount: 20, day: "2026-10-27", timeZone: TZ }, "user", NOW);
  await addTrip(db, { shop: "Lidl", amount: 15.5, day: "2026-10-27", timeZone: TZ }, "user", NOW);
  const out = await TOOLS_BY_NAME.get("grocery_spending")!.run(db, { from: "2026-10-01", to: "2026-10-31" });
  const r = out.result as { total: number; trips: number; currency: string; shops: { shop: string; total: number; trips: number }[] };
  assert.equal(r.total, 99.8);
  assert.equal(r.trips, 3);
  assert.equal(typeof r.currency, "string");
  assert.deepEqual(r.shops[0], { shop: "mercadona", total: 84.3, trips: 2 });
});

// ---- Different requests, end to end ----

test("a training question uses the new tools in parallel and answers in two requests", async () => {
  const db = await phone();
  const api = scripted(
    reply(
      [call("tu_1", "workout_summary", { from: "2026-10-01", to: "2026-10-28" }), call("tu_2", "workout_summary", { from: "2026-09-01", to: "2026-09-30" })],
      "tool_use",
    ),
    reply([text("You ran 16 km in October, none in September.")], "end_turn"),
  );
  const res = await startConversation(deps(db, api.create), "How has my training gone this month compared with last month?");
  assert.equal(res.usage.requests, 2);
  const results = api.calls[1].messages.at(-1)!.content as ToolResult[];
  assert.deepEqual(
    results.map((r) => r.tool_use_id),
    ["tu_1", "tu_2"],
  );
  assert.equal(JSON.parse(results[1].content as string).sessions, 0);
});

test("a spending question is answered from grocery_spending, and its result is disclosed", async () => {
  const db = await phone();
  const api = scripted(
    reply([call("tu_1", "grocery_spending", { from: "2026-10-01", to: "2026-10-31" })], "tool_use"),
    reply([text("64.30 this month.")], "end_turn"),
  );
  const res = await startConversation(deps(db, api.create), "¿Cuánto gasté en el súper este mes?");
  assert.equal(res.text, "64.30 this month.");
  const d = (await listDisclosures(db, res.conversationId)).filter((x) => x.toolName === "grocery_spending");
  assert.equal(d.length, 1);
  const [row] = await db.all<{ payload_json: string }>("SELECT payload_json FROM ai_disclosures WHERE id = ?", [d[0].id]);
  assert.equal(JSON.parse(row.payload_json).total, 64.3);
});

test("a refusal comes back as status refusal (Haiku has no fallback model to retry on)", async () => {
  const db = await phone();
  const api = scripted(reply([], "refusal", { stop_details: { type: "refusal", category: "bio", explanation: "declined" } }));
  const res = await startConversation(deps(db, api.create), "Q");
  assert.equal(res.status, "refusal");
  assert.equal(res.fallbackUsed, false);
  assert.equal(res.servedBy, CHAT_MODEL);
  assert.deepEqual(res.refusal, { category: "bio", explanation: "declined" });
});

test("a dictated question with a misheard word is sent as typed; a failed request keeps the question for Try again", async () => {
  const db = await phone();
  const api = scripted(new ChatApiError("network", "Could not reach Claude.", true));
  const question = withDictation("", "cuantas calorías comí oi");
  const err = await startConversation(deps(db, api.create), question).catch((e) => e);
  assert.ok(err instanceof ChatApiError && err.conversationId);
  const [q] = (api.calls[0].messages[0].content as Block[]).filter((b) => b.type === "text");
  assert.deepEqual(q, { type: "text", text: "Cuantas calorías comí oi" });
  assert.equal((await loadMessages(db, err.conversationId!)).length, 1);
});

// ---- Dictation ----

test("dictation follows what was typed and replaces its own running text", () => {
  assert.equal(withDictation("", "hola"), "Hola");
  assert.equal(withDictation("Log ", "two eggs"), "Log two eggs");
  assert.equal(withDictation("Log", "  two   eggs "), "Log two eggs");
  assert.equal(withDictation("Typed", ""), "Typed", "nothing heard leaves the box as it was");
  // Each update is the whole text so far: applying them in turn never duplicates words.
  let box = "";
  for (const heard of ["how", "how did", "how did I sleep"]) box = withDictation("", heard);
  assert.equal(box, "How did I sleep");
});

test("dictation language comes from the phone, with a safe default; errors worth showing are explained", () => {
  assert.equal(dictationLanguage("es-ES"), "es-ES");
  assert.equal(dictationLanguage("en"), "en");
  assert.equal(dictationLanguage(undefined), "en-US");
  assert.equal(dictationLanguage("<script>"), "en-US");
  assert.match(dictationError("permission")!, /microphone/);
  assert.match(dictationError("not-allowed")!, /microphone/);
  assert.match(dictationError("9")!, /microphone/);
  assert.equal(dictationError("7"), null, "nothing heard is not an error");
  assert.equal(dictationError("no-speech"), null);
  assert.equal(dictationError(undefined), null);
  assert.match(dictationError("network")!, /connection/);
  assert.match(dictationError("12")!, /Try again/, "an unknown code is not mistaken for a known one");
});

// ---- Native setup for dictation ----

test("Android: the speech service is declared visible once, so the recognizer is found on Android 11+", () => {
  const generated = `<?xml version="1.0" encoding="utf-8"?>\n<manifest xmlns:android="http://schemas.android.com/apk/res/android">\n    <application android:label="Even" />\n</manifest>\n`;
  const once = addRecognitionQuery(generated);
  assert.match(once, /<queries>\s*<intent>\s*<action android:name="android\.speech\.RecognitionService" \/>/);
  assert.ok(once.indexOf("<queries>") < once.indexOf("</manifest>"));
  assert.equal(addRecognitionQuery(once), once, "idempotent");
  assert.throws(() => addRecognitionQuery("<manifest>"), /no <\/manifest>/);
});

test("iOS: the microphone and speech recognition texts are in Info.plist, once", () => {
  const plist = `<plist><dict>\n\t<key>CFBundleDisplayName</key>\n\t<string>x</string>\n</dict></plist>`;
  const once = patchInfoPlist(plist, "Even");
  assert.match(once, /<key>NSMicrophoneUsageDescription<\/key>\s*<string>[^<]*not kept or sent to Claude/);
  assert.match(once, /<key>NSSpeechRecognitionUsageDescription<\/key>/);
  assert.equal(patchInfoPlist(once, "Even"), once);
  assert.ok(MICROPHONE_USAGE.length > 20 && SPEECH_USAGE.length > 20);
});

test("a chat from before 0.3.0 with an Opus fallback block is replayed unchanged, under the beta that knows the block", async () => {
  const db = await phone();
  const fb = { type: "fallback", from: { model: "claude-opus-5-5" }, to: { model: "claude-opus-4-8" } };
  const api = scripted(reply([fb, text("Old answer")], "end_turn", { model: "claude-opus-4-8" }), reply([text("New answer")], "end_turn"));
  const res = await startConversation(deps(db, api.create), "Old question");
  assert.equal("betas" in api.calls[0], false, "a new chat sends no beta");
  await askClaude(deps(db, api.create), res.conversationId, "New question");
  assert.deepEqual(api.calls[1].betas, ["server-side-fallback-2026-07-01"]);
  assert.deepEqual((api.calls[1].messages[1].content as Block[])[0], fb);
  assert.equal("fallbacks" in api.calls[1], false);
});
