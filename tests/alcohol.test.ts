import test from "node:test";
import assert from "node:assert/strict";
import type Anthropic from "@anthropic-ai/sdk";
import { alcoholKcal, weightWithoutKcal } from "../src/core/health";
import { migrate } from "../src/db/migrate";
import {
  alcoholTotals,
  deleteDrinkType,
  drinkKcalByDay,
  findDrinkType,
  getCurrency,
  latestWeight,
  listDrinks,
  listDrinkTypes,
  logDrink,
  saveDrinkType,
  servingKcal,
  setCurrency,
  typeUsesSince,
  updateDrink,
  weightWithoutAlcohol,
} from "../src/domain/alcohol/alcohol";
import { undoAgentAction, listAgentActions } from "../src/domain/chat/actions";
import { recordConsent } from "../src/domain/chat/consent";
import { CHAT_MODEL, startConversation, type ChatDeps, type ClaudeCreate } from "../src/domain/chat/engine";
import { TOOLS_BY_NAME } from "../src/domain/chat/tools";
import { memoryDriver, migratedDb, realMigrations } from "./helpers";

const TZ = "Europe/Madrid";
const H = 3_600_000;
const NOW = Date.UTC(2026, 9, 25, 18, 0, 0); // Sunday 25 Oct 2026, 19:00 in Madrid
const MAHOU = { name: "Mahou 33 cl", volumeMl: 330, abvPercent: 5.5, calories: 142, price: 1.2 };

test("health: kcal from alcohol and weight without kcal", () => {
  assert.equal(Math.round(alcoholKcal(330, 5)), 91);
  assert.equal(weightWithoutKcal(80, 7700), 79);
  assert.throws(() => weightWithoutKcal(80, -1), /kcal/);
});

test("drink types: unique names, estimated kcal, delete keeps the drinks", async () => {
  const { db } = await migratedDb();
  const id = await saveDrinkType(db, MAHOU, { nowMs: NOW });
  await assert.rejects(saveDrinkType(db, { ...MAHOU, name: " mahou 33 CL " }), /already a drink called Mahou 33 cl/);
  await saveDrinkType(db, { name: "Red wine", volumeMl: 150, abvPercent: 13, calories: null, price: null }, { nowMs: NOW });
  assert.equal(servingKcal((await findDrinkType(db, "red wine"))!), 108, "150 ml x 13% x 0.789 x 7");
  await assert.rejects(saveDrinkType(db, { ...MAHOU, name: "x", abvPercent: 120 }), /ABV/);

  await logDrink(db, { typeId: id, count: 2, atMs: NOW, timeZone: TZ });
  let types = await listDrinkTypes(db);
  assert.deepEqual(
    types.map((t) => [t.name, t.uses]),
    [
      ["Mahou 33 cl", 2],
      ["Red wine", 0],
    ],
  );
  await saveDrinkType(db, { ...types[0], price: 1.5 }, { nowMs: NOW + 1 });
  await deleteDrinkType(db, id, NOW + 2);
  types = await listDrinkTypes(db);
  assert.deepEqual(
    types.map((t) => t.name),
    ["Red wine"],
  );
  const drinks = await listDrinks(db, "2026-10-25", "2026-10-25");
  assert.deepEqual(
    drinks.map((d) => [d.name, d.kcal, d.price]),
    [
      ["Mahou 33 cl", 142, 1.2],
      ["Mahou 33 cl", 142, 1.2],
    ],
    "history keeps the values it was logged with",
  );
});

test("edit one logged drink: its values, time and day change, its type stays as it was", async () => {
  const { db } = await migratedDb();
  const id = await saveDrinkType(db, MAHOU, { nowMs: NOW });
  const [a, b] = await logDrink(db, { typeId: id, count: 2, atMs: NOW, timeZone: TZ });
  await updateDrink(db, a, { name: "Mahou 50 cl", volumeMl: 500, abvPercent: 5.5, calories: null, price: 2, atMs: NOW - 24 * H, timeZone: TZ }, NOW + 1);
  const drinks = await listDrinks(db, "2026-10-24", "2026-10-25");
  assert.deepEqual(
    drinks.map((d) => [d.id === a, d.name, d.localDay, d.price, d.kcalEstimated]),
    [
      [false, "Mahou 33 cl", "2026-10-25", 1.2, false],
      [true, "Mahou 50 cl", "2026-10-24", 2, true],
    ],
  );
  assert.equal((await findDrinkType(db, "Mahou 33 cl"))!.price, 1.2, "the favourite keeps its own values");
  await assert.rejects(updateDrink(db, b, { ...MAHOU, atMs: NOW + H, timeZone: TZ }, NOW), /not happened yet/);
  assert.deepEqual([...(await typeUsesSince(db, "2026-10-25"))], [[id, 1]], "uses count from the day given");
});

test("totals in drinks, alcohol, kcal and money; drink kcal per day", async () => {
  const { db } = await migratedDb();
  const id = await saveDrinkType(db, MAHOU, { nowMs: NOW });
  await logDrink(db, { typeId: id, count: 3, atMs: NOW - 24 * H, timeZone: TZ });
  await logDrink(db, { typeId: id, price: 3, atMs: NOW, timeZone: TZ }); // a bar is dearer
  await logDrink(db, { name: "Gin tonic", volumeMl: 200, abvPercent: 10, atMs: NOW, timeZone: TZ }); // no kcal, no price
  const t = await alcoholTotals(db, "2026-10-19", "2026-10-25");
  assert.equal(t.days, 7);
  assert.equal(t.drinks, 5);
  assert.equal(t.drinkingDays, 2);
  assert.equal(Math.round(t.alcoholG), Math.round(4 * 330 * 0.055 * 0.789 + 200 * 0.1 * 0.789));
  assert.equal(Math.round(t.kcal), 4 * 142 + Math.round(200 * 0.1 * 0.789 * 7));
  assert.equal(t.kcalEstimated, 1);
  assert.equal(Math.round(t.money * 100) / 100, 6.6);
  assert.equal(t.priced, 4);
  const byDay = await drinkKcalByDay(db, "2026-10-24", "2026-10-25");
  assert.equal(byDay.get("2026-10-24"), 3 * 142);
  await assert.rejects(logDrink(db, { typeId: id, count: 21, timeZone: TZ }), /between 1 and 20/);
  await assert.rejects(logDrink(db, { name: "x", timeZone: TZ }), /Volume/);
});

test("latest weight: manual and synced, newest wins, units converted", async () => {
  const { db } = await migratedDb();
  assert.equal(await latestWeight(db, "2026-10-25"), null);
  await db.run(
    `INSERT INTO health_samples (id, source, device, external_id, metric, start_ms, offset_min, value_num, unit, local_day, created_at, updated_at)
     VALUES ('s1', 'garmin', 'Garmin', '2026-10-24#0', 'body_weightInGrams', ?, 120, 86500, 'grams', '2026-10-24', ?, ?)`,
    [NOW, NOW, NOW],
  );
  assert.deepEqual(await latestWeight(db, "2026-10-25"), { kg: 86.5, day: "2026-10-24", source: "synced" });
  await db.run(
    `INSERT INTO manual_measurements (id, measured_at_ms, offset_min, local_day, kind, value_num, unit, created_at, updated_at, origin_device_id)
     VALUES ('m1', ?, 60, '2026-10-25', 'weight', 190, 'lb', ?, ?, 'dev')`,
    [NOW, NOW, NOW],
  );
  const w = await latestWeight(db, "2026-10-25");
  assert.equal(w?.source, "manual");
  assert.equal(Math.round(w!.kg * 10) / 10, 86.2);
  assert.equal((await latestWeight(db, "2026-10-24"))?.source, "synced", "only up to the day asked");
});

test("expected weight without alcohol", async () => {
  const { db } = await migratedDb();
  await db.run(
    `INSERT INTO manual_measurements (id, measured_at_ms, offset_min, local_day, kind, value_num, unit, created_at, updated_at, origin_device_id)
     VALUES ('m1', ?, 60, '2026-10-25', 'weight', 80, 'kg', ?, ?, 'dev')`,
    [NOW, NOW, NOW],
  );
  const id = await saveDrinkType(db, { ...MAHOU, calories: 154 }, { nowMs: NOW });
  await logDrink(db, { typeId: id, count: 20, atMs: NOW - 48 * H, timeZone: TZ });
  await logDrink(db, { typeId: id, count: 20, atMs: NOW - 24 * H, timeZone: TZ });
  const w = await weightWithoutAlcohol(db, "2026-10-19", "2026-10-25");
  assert.equal(w.totals.kcal, 40 * 154);
  assert.equal(w.kgFromAlcohol, 0.8);
  assert.equal(w.expectedKg, 79.2);
});

test("currency setting", async () => {
  const { db } = await migratedDb();
  assert.equal(await getCurrency(db), "EUR");
  await setCurrency(db, " gbp ");
  assert.equal(await getCurrency(db), "GBP");
  await assert.rejects(setCurrency(db, "pounds"), /3-letter/);
});

test("0006 keeps drinks logged before it, with estimated kcal and no price", async () => {
  const { db } = memoryDriver();
  const all = realMigrations();
  await migrate(
    db,
    all.filter((m) => m.version <= 5),
  );
  await db.run(
    `INSERT INTO drink_entries (id, drunk_at_ms, offset_min, local_day, name, volume_ml, abv_percent, created_at, updated_at, origin_device_id)
     VALUES ('d1', ?, 60, '2026-10-25', 'beer', 500, 5, ?, ?, 'dev')`,
    [NOW, NOW, NOW],
  );
  await migrate(db, all);
  const [row] = await db.all<Record<string, number>>("SELECT drinks, calories, calories_estimated, price, priced FROM daily_alcohol");
  assert.deepEqual({ ...row, calories: Math.round(row.calories) }, { drinks: 1, calories: 138, calories_estimated: 1, price: null, priced: 0 });
});

// ---- Chat: add drink types, log by type, read the impact ----

type BetaMessage = Anthropic.Beta.Messages.BetaMessage;
type ToolResult = Anthropic.Beta.Messages.BetaToolResultBlockParam;
const reply = (content: unknown[], stop_reason: string) =>
  ({
    id: "m",
    type: "message",
    role: "assistant",
    model: CHAT_MODEL,
    content,
    stop_reason,
    stop_sequence: null,
    stop_details: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  }) as unknown as BetaMessage;
const call = (id: string, name: string, input: unknown) => ({ type: "tool_use", id, name, input });

function oneRound(...calls: unknown[]) {
  const sent: Anthropic.Beta.Messages.MessageCreateParamsNonStreaming[] = [];
  const replies = [reply(calls, "tool_use"), reply([{ type: "text", text: "Done." }], "end_turn")];
  const create: ClaudeCreate = async (p) => (sent.push(structuredClone(p)), replies.shift()!);
  return { create, results: () => sent[1].messages.at(-1)!.content as ToolResult[] };
}

async function chatDb() {
  const { db } = await migratedDb();
  await recordConsent(db, "claude.aggregates", true, "dev", NOW - 1000);
  return db;
}
const deps = (db: ChatDeps["db"], create: ClaudeCreate, proposals: string[]): ChatDeps => ({
  db,
  create,
  deviceId: "dev",
  now: () => NOW,
  timeZone: TZ,
  confirmAction: async (p) => (proposals.push(`${p.summary} | ${p.lines.join(" / ")}`), true),
});
const drinkType = (name: string, volume_ml: number, abv_percent: number, calories: number | null, price: number | null) => ({
  name,
  volume_ml,
  abv_percent,
  calories,
  price,
});
const drink = (over: Record<string, unknown>) => ({
  drink_type: null,
  name: null,
  volume_ml: null,
  abv_percent: null,
  count: 1,
  calories: null,
  price: null,
  day: "2026-10-25",
  time: "20:00",
  notes: null,
  ...over,
});

test("chat adds drink types, fills only missing values, logs by type, and every step undoes", async () => {
  const db = await chatDb();
  await saveDrinkType(db, { name: "Rioja", volumeMl: 150, abvPercent: 13.5, calories: 125, price: null }, { nowMs: NOW });
  const proposals: string[] = [];
  const api = oneRound(
    call("a", "add_drink_type", drinkType("Mahou 33 cl", 330, 5.5, null, 1.2)),
    call("b", "add_drink_type", drinkType("rioja", 150, 13.5, 999, 2.5)), // kcal already set: only the price is filled
    call("c", "add_drink_type", drinkType("Rioja", 150, 13.5, 100, 3)), // nothing left to fill
    call("d", "log_drink", drink({ drink_type: "Mahou 33 cl", count: 3 })),
    call("e", "log_drink", drink({ drink_type: "Unknown" })),
    call("f", "log_drink", drink({ name: "Gin tonic", volume_ml: 200, abv_percent: 10, calories: 180, price: 8 })),
  );
  await startConversation(deps(db, api.create, proposals), "I had three Mahous and a gin tonic");
  assert.deepEqual(proposals, [
    "Save drink type Mahou 33 cl | Mahou 33 cl: 330 ml, 5.5% ABV, about 100 kcal (from the alcohol), 1.2",
    "Fill in price for Rioja | Rioja: price 2.5",
    "Log 3 x Mahou 33 cl (43 g alcohol, 300 kcal, 3.6) | 2026-10-25 20:00: 3 x Mahou 33 cl, 330 ml, 5.5% ABV, about 100 kcal each, 1.2 each",
    "Log 1 x Gin tonic (15.8 g alcohol, 180 kcal, 8) | 2026-10-25 20:00: 1 x Gin tonic, 200 ml, 10% ABV, 180 kcal each, 8 each",
  ]);
  const r = api.results();
  assert.match(String(r[2].content), /already exists .* Nothing to fill in/);
  assert.match(String(r[4].content), /No drink type called Unknown/);

  const rioja = (await findDrinkType(db, "Rioja"))!;
  assert.deepEqual([rioja.calories, rioja.price], [125, 2.5], "the owner's kcal is untouched");
  const mahou = (await findDrinkType(db, "Mahou 33 cl"))!;
  assert.equal(mahou.createdBy, "assistant");
  const drinks = await listDrinks(db, "2026-10-25", "2026-10-25");
  assert.equal(drinks.length, 4);
  assert.ok(drinks.every((d) => d.price !== null));
  const [{ n }] = await db.all<{ n: number }>("SELECT COUNT(*) AS n FROM drink_entries WHERE created_by = 'assistant'");
  assert.equal(n, 4);

  for (const a of (await listAgentActions(db)).filter((x) => x.status === "applied")) await undoAgentAction(db, a.id, NOW + 1);
  assert.equal((await listDrinks(db, "2026-10-25", "2026-10-25")).length, 0);
  assert.equal(await findDrinkType(db, "Mahou 33 cl"), null);
  assert.equal((await findDrinkType(db, "Rioja"))!.price, null, "the filled price is blanked again");
  assert.equal((await findDrinkType(db, "Rioja"))!.calories, 125);
});

test("chat read tools: drink types with currency, and the alcohol impact with expected weight", async () => {
  const db = await chatDb();
  await setCurrency(db, "EUR");
  const id = await saveDrinkType(db, { ...MAHOU, calories: 154 }, { nowMs: NOW });
  await logDrink(db, { typeId: id, count: 10, atMs: NOW - 24 * H, timeZone: TZ });
  await db.run(
    `INSERT INTO manual_measurements (id, measured_at_ms, offset_min, local_day, kind, value_num, unit, created_at, updated_at, origin_device_id)
     VALUES ('m1', ?, 60, '2026-10-25', 'weight', 80, 'kg', ?, ?, 'dev')`,
    [NOW, NOW, NOW],
  );
  const types = (await TOOLS_BY_NAME.get("drink_types")!.run(db, {})).result as {
    currency: string;
    types: { name: string; kcal_per_serving: number; times_logged: number }[];
  };
  assert.equal(types.currency, "EUR");
  assert.deepEqual(
    types.types.map((t) => [t.name, t.kcal_per_serving, t.times_logged]),
    [["Mahou 33 cl", 154, 10]],
  );

  const impact = (await TOOLS_BY_NAME.get("alcohol_impact")!.run(db, { from: "2026-10-19", to: "2026-10-25" })).result as Record<string, unknown>;
  assert.equal(impact.drinks, 10);
  assert.equal(impact.kcal, 1540);
  assert.equal(impact.money, 12);
  assert.equal(impact.kg_from_alcohol, 0.2);
  assert.equal(impact.expected_weight_without_alcohol_kg, 79.8);
  assert.deepEqual(impact.weight, { kg: 80, day: "2026-10-25", source: "manual" });
  await assert.rejects(TOOLS_BY_NAME.get("alcohol_impact")!.run(db, { from: "2026-10-25", to: "2026-10-19" }), /from must not be after to/);
});
