import test from "node:test";
import assert from "node:assert/strict";
import type Anthropic from "@anthropic-ai/sdk";
import { listAgentActions, undoAgentAction, type ActionProposal } from "../src/features/chat/actions";
import { recordConsent } from "../src/features/chat/consent";
import { CHAT_MODEL, ConsentRequiredError, startConversation, type ChatDeps, type ClaudeCreate } from "../src/features/chat/engine";
import { attachmentFromPhoto, MAX_IMAGES_PER_MESSAGE, toAttachment, validateAttachments } from "../src/features/chat/images";
import { listDisclosures, loadMessages } from "../src/features/chat/store";
import { TOOLS_BY_NAME } from "../src/features/chat/tools";
import { capacitorDriver } from "../src/platform/sqlite";
import { dayFood, listSavedMeals } from "../src/features/food/food";
import { listMealPreps, loadStock } from "../src/features/mealprep/mealPrep";
import { migrate } from "../src/db/migrate";
import { addShoppingItem, listShopping } from "../src/features/mealprep/shopping";
import { fakePlugin } from "./fakePlugin";
import { memoryDriver, migratedDb, realMigrations } from "./helpers";

type BetaMessage = Anthropic.Beta.Messages.BetaMessage;
type Params = Anthropic.Beta.Messages.MessageCreateParamsNonStreaming;
type ToolResult = Anthropic.Beta.Messages.BetaToolResultBlockParam;

const NOW = Date.UTC(2026, 9, 25, 18, 0, 0); // Sunday 25 Oct 2026, 19:00 in Madrid (+01:00 after DST ended)
const TZ = "Europe/Madrid";
const DEV = "device-1";
const IMG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

function reply(content: unknown[], stop_reason: string): BetaMessage {
  return {
    id: "msg",
    type: "message",
    role: "assistant",
    model: CHAT_MODEL,
    content,
    stop_reason,
    stop_sequence: null,
    stop_details: null,
    usage: { input_tokens: 10, output_tokens: 5 },
  } as unknown as BetaMessage;
}
const text = (t: string) => ({ type: "text", text: t });
const call = (id: string, name: string, input: unknown) => ({ type: "tool_use", id, name, input });

function scripted(...replies: BetaMessage[]) {
  const calls: Params[] = [];
  const create: ClaudeCreate = async (p) => {
    calls.push(structuredClone(p));
    const r = replies.shift();
    if (!r) throw new Error("no more scripted replies");
    return r;
  };
  return { create, calls };
}

/** One tool round then a closing answer. */
const oneRound = (...calls: unknown[]) => scripted(reply(calls, "tool_use"), reply([text("Done.")], "end_turn"));

async function setup(scopes: string[] = ["claude.aggregates", "claude.photos"]) {
  const { db } = await migratedDb();
  for (const s of scopes) await recordConsent(db, s as never, true, DEV, NOW - 1000);
  return db;
}

const yes = async () => true;
function deps(db: ChatDeps["db"], create: ClaudeCreate, extra: Partial<ChatDeps> = {}): ChatDeps {
  return { db, create, deviceId: DEV, now: () => NOW, timeZone: TZ, ...extra };
}

/** The tool_results the engine sent back on request n (0-based). */
const resultsOf = (calls: Params[], n: number) => calls[n].messages.at(-1)!.content as ToolResult[];
const createdBy = async (db: ChatDeps["db"], table: string, id: string) =>
  (await db.all<{ created_by: string }>(`SELECT created_by FROM ${table} WHERE id = ?`, [id]))[0]?.created_by;

const lunch = {
  name: "Grilled chicken",
  meal: "lunch",
  day: "2026-10-24",
  time: null,
  calories: 330,
  protein_g: 50,
  carbs_g: 0,
  fat_g: 14,
  portion: "about 200 g",
  notes: "Estimated from photo",
};

test("photo of a meal: sent with consent, logged as a photo disclosure, entries saved after confirmation", async () => {
  const db = await setup();
  const proposals: ActionProposal[] = [];
  const entries = [lunch, { ...lunch, name: "Rice", day: "2026-10-25", meal: "dinner", calories: 260, protein_g: 5, carbs_g: 57, fat_g: 1, portion: "1 cup" }];
  const api = scripted(reply([text("Chicken and rice."), call("t1", "log_food", { entries })], "tool_use"), reply([text("Logged: 590 kcal.")], "end_turn"));
  const res = await startConversation(deps(db, api.create, { confirmAction: async (p) => (proposals.push(p), true) }), "Log this meal", {
    images: [toAttachment(`data:image/png;base64,${IMG}`)],
  });

  const first = api.calls[0].messages[0].content as Anthropic.Beta.Messages.BetaContentBlockParam[];
  assert.equal(first[0].type, "image");
  const photoLog = (await listDisclosures(db)).filter((d) => d.dataClass === "photo");
  assert.equal(photoLog.length, 1);
  assert.match(photoLog[0].summary, /^Photo \(image\/png, 0 KB\)$/);

  assert.equal(proposals[0].summary, "Log 2 food entries (590 kcal)");
  assert.deepEqual(proposals[0].lines, [
    "2026-10-24 14:00 lunch: Grilled chicken, about 200 g, 330 kcal (P 50 g, C 0 g, F 14 g)",
    "2026-10-25 19:00 dinner: Rice, 1 cup, 260 kcal (P 5 g, C 57 g, F 1 g)",
  ]);

  // Saved through the food log's own logFood, marked as the assistant's.
  const [chicken] = await dayFood(db, "2026-10-24");
  const [rice] = await dayFood(db, "2026-10-25");
  assert.equal(chicken.name, "Grilled chicken");
  assert.equal(chicken.eatenAtMs, Date.UTC(2026, 9, 24, 12, 0)); // 14:00 at +02:00
  assert.equal(chicken.notes, "Portion: about 200 g. Estimated from photo");
  assert.equal(rice.eatenAtMs, NOW); // today without a time = now
  assert.equal(await createdBy(db, "food_entries", chicken.id), "assistant");

  assert.equal(JSON.parse(resultsOf(api.calls, 1)[0].content as string).status, "saved");
  assert.deepEqual(
    res.actions.map((a) => [a.tool, a.status]),
    [["log_food", "applied"]],
  );
  assert.deepEqual(
    (await listAgentActions(db))[0].rows.map((r) => r.op),
    ["food", "food"],
  );
});

test("no confirmation means no write: declined is logged and Claude is told", async () => {
  for (const confirmAction of [undefined, async () => false]) {
    const db = await setup();
    const api = oneRound(call("t1", "log_food", { entries: [lunch] }));
    const res = await startConversation(deps(db, api.create, { confirmAction }), "Log it");
    assert.equal((await dayFood(db, "2026-10-24")).length, 0);
    assert.deepEqual(
      res.actions.map((a) => a.status),
      ["declined"],
    );
    const r = resultsOf(api.calls, 1)[0];
    assert.equal(r.is_error, true);
    assert.match(String(r.content), /declined/);
  }
});

test("invalid proposals never reach the owner: future days, absurd values, too many entries", async () => {
  const db = await setup();
  let asked = 0;
  const api = oneRound(
    call("a", "log_food", { entries: [{ ...lunch, day: "2026-10-26" }] }),
    call("b", "log_food", { entries: [{ ...lunch, calories: 9000 }] }),
    call("c", "log_food", { entries: Array.from({ length: 21 }, () => lunch) }),
    call("d", "log_food", { entries: [{ ...lunch, day: "2026-07-01" }] }),
    call("e", "prep_portions", { batch_id: "nope", action: "eat", portions: 1, from: null, day: "2026-10-25", time: null }),
  );
  await startConversation(deps(db, api.create, { confirmAction: async () => (asked++, true) }), "Q");
  assert.equal(asked, 0);
  const results = resultsOf(api.calls, 1);
  assert.ok(results.every((r) => r.is_error));
  assert.match(String(results[0].content), /in the future/);
  assert.match(String(results[1].content), /calories/);
  assert.match(String(results[2].content), /entries/);
  assert.match(String(results[3].content), /more than 60 days ago/);
  assert.match(String(results[4].content), /No batch/);
  assert.equal((await listAgentActions(db)).length, 0, "nothing proposed, nothing logged");
});

test("photos need their own consent; nothing is stored without it", async () => {
  const db = await setup(["claude.aggregates"]);
  await assert.rejects(startConversation(deps(db, scripted().create), "Log this", { images: [toAttachment(IMG, "image/png")] }), ConsentRequiredError);
  assert.equal((await db.all("SELECT * FROM chat_messages")).length, 0);
});

const chili = {
  name: "Chicken chili",
  portions: 4,
  fridge_days: 4,
  freezer_days: 90,
  thaw_hours: 24,
  calories: 550,
  protein_g: 45,
  carbs_g: 50,
  fat_g: 15,
  tags: ["Dinner", "high protein"],
  ingredients: [
    { name: "Chicken breast", quantity: 800, unit: "g" },
    { name: "Rice", quantity: 300, unit: "g" },
    { name: "Kidney beans", quantity: 2, unit: "cans" },
  ],
  notes: "Reheat 3 min",
};

test("meal prep end to end through the app's own functions, and every step undoes cleanly", async () => {
  const db = await setup();
  await addShoppingItem(db, { name: "Rice", quantity: 200, unit: "g" }, NOW - 5000); // the owner's own line
  const proposals: string[] = [];
  const confirm = async (p: ActionProposal) => (proposals.push(p.summary), true);

  // 1. Recipe.
  const r1 = await startConversation(deps(db, oneRound(call("a", "create_meal_prep", chili)).create, { confirmAction: confirm }), "Plan my prep");
  const [recipe] = await listMealPreps(db);
  assert.equal(recipe.name, "Chicken chili");
  assert.deepEqual(recipe.tags, ["dinner", "high protein"]); // normalised by saveMealPrep
  assert.equal(await createdBy(db, "meal_preps", recipe.id), "assistant");

  // A second recipe with the same name is refused before asking.
  const dup = oneRound(call("b", "create_meal_prep", chili));
  await startConversation(deps(db, dup.create, { confirmAction: confirm }), "Again");
  assert.match(String(resultsOf(dup.calls, 1)[0].content), /already exists/);

  // 2. Ingredients for two batches; rice merges into the owner's line.
  const r2 = await startConversation(
    deps(db, oneRound(call("c", "add_recipe_to_shopping", { recipes: [{ meal_prep_id: recipe.id, batches: 2 }] })).create, { confirmAction: confirm }),
    "Shopping",
  );
  const list = await listShopping(db);
  assert.deepEqual(list.map((i) => [i.name, i.quantity, i.unit]).sort(), [
    ["Chicken breast", 1600, "g"],
    ["Kidney beans", 4, "cans"],
    ["Rice", 800, "g"],
  ]);

  // 3. Cooked, 1 portion straight to the freezer. 4. Ate one portion: logs food with the recipe's macros.
  const r3 = await startConversation(
    deps(
      db,
      oneRound(call("d", "log_cooked_batch", { meal_prep_id: recipe.id, portions: null, frozen: 1, day: "2026-10-25", time: "12:00", notes: null })).create,
      {
        confirmAction: confirm,
      },
    ),
    "Cooked it",
  );
  const [batch] = await loadStock(db);
  assert.equal(batch.fridgeCount, 3);
  assert.equal(batch.freezerCount, 1);
  assert.equal(await createdBy(db, "meal_prep_batches", batch.batch.id), "assistant");
  const r4 = await startConversation(
    deps(
      db,
      oneRound(call("e", "prep_portions", { batch_id: batch.batch.id, action: "eat", portions: 1, from: null, day: "2026-10-25", time: "14:00" })).create,
      {
        confirmAction: confirm,
      },
    ),
    "Ate one",
  );
  const [ate] = await dayFood(db, "2026-10-25");
  assert.equal(ate.calories, 550);
  assert.equal(ate.fromPrep, true);
  assert.equal(await createdBy(db, "food_entries", ate.id), "assistant");
  assert.equal((await loadStock(db))[0].fridgeCount, 2);

  assert.deepEqual(proposals, [
    'Create meal prep "Chicken chili" (4 portions per batch)',
    "Add the ingredients of 1 recipe to the shopping list",
    "Log a cooked batch of Chicken chili (4 portions)",
    "Eat 1 portion of Chicken chili",
  ]);

  // Undo, newest first, each with the app's own undo.
  await undoAgentAction(db, r4.actions[0].id, NOW + 1);
  assert.equal((await dayFood(db, "2026-10-25")).length, 0);
  assert.equal((await loadStock(db))[0].fridgeCount, 3, "the portion is back in stock");
  await undoAgentAction(db, r3.actions[0].id, NOW + 2);
  assert.equal((await loadStock(db)).length, 0);
  await undoAgentAction(db, r2.actions[0].id, NOW + 3);
  assert.deepEqual(
    (await listShopping(db)).map((i) => [i.name, i.quantity]),
    [["Rice", 200]],
    "the owner's rice is back to 200 g, not deleted",
  );
  await undoAgentAction(db, r1.actions[0].id, NOW + 4);
  assert.equal((await listMealPreps(db)).length, 0);
  await assert.rejects(undoAgentAction(db, r1.actions[0].id), /Only applied actions/);
});

test("a shopping undo refuses when the owner changed the line since", async () => {
  const db = await setup();
  const res = await startConversation(
    deps(db, oneRound(call("a", "add_shopping_items", { items: [{ name: "Oats", quantity: 500, unit: "g" }] })).create, { confirmAction: yes }),
    "Add oats",
  );
  await addShoppingItem(db, { name: "Rice", quantity: 1, unit: "kg" }, NOW + 1); // unrelated line: fine
  await db.run("UPDATE shopping_list_items SET deleted_at = ? WHERE name = 'Oats'", [NOW + 2]); // the owner removed it
  await undoAgentAction(db, res.actions[0].id, NOW + 3); // already gone: nothing to do, still fine
  const res2 = await startConversation(
    deps(db, oneRound(call("b", "add_shopping_items", { items: [{ name: "Rice", quantity: 500, unit: "g" }] })).create, { confirmAction: yes }),
    "More rice",
  );
  assert.equal((await listShopping(db)).find((i) => i.name === "Rice")!.quantity, 1500); // merged with the owner's line
  await db.run("UPDATE shopping_list_items SET quantity = 2000 WHERE name = 'Rice'");
  await assert.rejects(undoAgentAction(db, res2.actions[0].id), /changed since/);
});

test("save a favourite with the chat photo, then log it scaled; undo removes it", async () => {
  const db = await setup();
  const meal = { name: "Poke bowl", meal: "lunch", calories: 620, protein_g: 35, carbs_g: 70, fat_g: 20, notes: null, use_chat_photo: true };
  const res = await startConversation(deps(db, oneRound(call("a", "save_meal", meal)).create, { confirmAction: yes }), "Save this", {
    images: [attachmentFromPhoto({ mime: "image/jpeg", dataB64: IMG })],
  });
  const [saved] = await listSavedMeals(db);
  assert.equal(saved.name, "Poke bowl");
  assert.ok(saved.photoId, "the chat photo is kept with the saved meal");
  assert.equal(await createdBy(db, "saved_meals", saved.id), "assistant");

  const api = oneRound(call("b", "log_saved_meal", { saved_meal_id: saved.id, servings: 1.5, meal: null, day: "2026-10-25", time: "13:00" }));
  const logged = await startConversation(deps(db, api.create, { confirmAction: yes }), "Had 1.5");
  const [entry] = await dayFood(db, "2026-10-25");
  assert.equal(entry.calories, 930);
  assert.equal(entry.savedMealId, saved.id);

  await undoAgentAction(db, logged.actions[0].id, NOW + 1);
  assert.equal((await dayFood(db, "2026-10-25")).length, 0);
  await undoAgentAction(db, res.actions[0].id, NOW + 2);
  assert.equal((await listSavedMeals(db)).length, 0);

  // A PNG cannot be kept (the food log stores JPEG or WebP): refused before asking.
  const png = oneRound(call("c", "save_meal", meal));
  await startConversation(deps(db, png.create, { confirmAction: yes }), "Save", { images: [toAttachment(IMG, "image/png")] });
  assert.match(String(resultsOf(png.calls, 1)[0].content), /no JPEG or WebP photo/);
});

test("undo refuses rows outside the agent's tables, even if the log was tampered with", async () => {
  const db = await setup();
  const res = await startConversation(deps(db, oneRound(call("t1", "log_food", { entries: [lunch] })).create, { confirmAction: yes }), "Q");
  const [entry] = await dayFood(db, "2026-10-24");
  await db.run("UPDATE agent_actions SET rows_json = ? WHERE id = ?", [
    JSON.stringify([
      { op: "food", table: "food_entries", id: entry.id },
      { op: "insert", table: "app_settings", id: "x" },
    ]),
    res.actions[0].id,
  ]);
  await assert.rejects(undoAgentAction(db, res.actions[0].id), /Refusing to undo insert on table app_settings/);
  assert.equal((await dayFood(db, "2026-10-24")).length, 1, "checked before anything was touched");
});

test("drinks, measurements, day notes and goals: proposals read well, limits hold", async () => {
  const db = await setup();
  await db.run("INSERT INTO day_notes (id, local_day, body, created_at, updated_at, origin_device_id) VALUES ('n0', '2026-10-24', 'mine', ?, ?, 'dev')", [
    NOW,
    NOW,
  ]);
  const proposals: string[] = [];
  const api = oneRound(
    call("a", "log_drink", {
      drink_type: null,
      name: "Beer",
      volume_ml: 500,
      abv_percent: 5,
      count: 1,
      calories: null,
      price: null,
      day: "2026-10-25",
      time: "20:00",
      notes: null,
    }),
    call("b", "log_measurement", {
      kind: "blood_pressure",
      value_num: 128,
      value_num2: 82,
      value_text: null,
      unit: "mmHg",
      day: "2026-10-25",
      time: "08:00",
      notes: null,
    }),
    call("c", "add_day_note", { day: "2026-10-24", mood: 4, energy: 3, note: "Good run" }),
    call("d", "add_day_note", { day: "2026-10-25", mood: 4, energy: 3, note: "Rest day" }),
    call("e", "create_goal", {
      title: "Protein",
      target_kind: "food",
      metric: "protein_g",
      comparator: ">=",
      target_num: 140,
      unit: "g",
      period: "day",
      start_day: "2026-10-26",
      end_day: null,
    }),
    call("f", "create_goal", {
      title: "Kcal",
      target_kind: "food",
      metric: "calories",
      comparator: "<=",
      target_num: 2200,
      unit: "kcal",
      period: "day",
      start_day: "2026-10-26",
      end_day: null,
    }),
    call("g", "log_measurement", {
      kind: "Blood Pressure!",
      value_num: 1,
      value_num2: null,
      value_text: null,
      unit: null,
      day: "2026-10-25",
      time: null,
      notes: null,
    }),
  );
  await startConversation(deps(db, api.create, { confirmAction: async (p) => (proposals.push(`${p.summary} | ${p.lines.join(" / ")}`), true) }), "Q");
  assert.deepEqual(proposals, [
    "Log 1 x Beer (19.7 g alcohol, 138 kcal) | 2026-10-25 20:00: 1 x Beer, 500 ml, 5% ABV, about 138 kcal each",
    "Log blood_pressure: 128/82 mmHg | 2026-10-25 08:00: blood_pressure 128/82 mmHg",
    "Add the note for 2026-10-25 | 2026-10-25: mood 4, energy 3. Rest day",
    'Create goal "Protein" | Protein (protein_g >= 140 g per day), from 2026-10-26',
  ]);
  const results = resultsOf(api.calls, 1);
  assert.match(String(results[2].content), /already has a note/);
  assert.match(String(results[5].content), /calorie target is set by the owner/);
  assert.match(String(results[6].content), /lower_snake_case/);
  const [drink] = await db.all<{ created_by: string; local_day: string }>("SELECT created_by, local_day FROM drink_entries");
  assert.deepEqual(drink, { created_by: "assistant", local_day: "2026-10-25" });
});

test("energy_needs calculates from the owner's numbers without reading the database", async () => {
  const { db } = memoryDriver(); // no tables at all: proves nothing is read
  const out = await TOOLS_BY_NAME.get("energy_needs")!.run(db, {
    sex: "male",
    age_years: 35,
    height_cm: 180,
    weight_kg: 80,
    activity: "moderate",
    kg_per_week: -0.5,
  });
  const r = out.result as Record<string, number | boolean>;
  assert.equal(r.bmr_kcal, 1755);
  assert.equal(r.tdee_kcal, 2720);
  assert.equal(r.target_kcal, 2170);
  assert.equal(r.target_floored_at_bmr, false);
  assert.equal(r.protein_target_g, 128);
  await assert.rejects(
    TOOLS_BY_NAME.get("energy_needs")!.run(db, { sex: "male", age_years: 35, height_cm: 180, weight_kg: 80, activity: "moderate", kg_per_week: -3 }),
  );
});

test("attachments: data URLs and app photos accepted, wrong types, bad base64 and too many photos refused", () => {
  assert.deepEqual(toAttachment(`data:image/jpeg;base64,${IMG}`), { mediaType: "image/jpeg", data: IMG });
  assert.deepEqual(attachmentFromPhoto({ mime: "image/webp", dataB64: IMG }), { mediaType: "image/webp", data: IMG });
  assert.throws(() => toAttachment(IMG, "image/heic"), /JPEG, PNG, WebP or GIF/);
  assert.throws(() => toAttachment("not base64!!", "image/png"), /not valid base64/);
  assert.throws(() => toAttachment("A".repeat(7_000_000), "image/png"), /larger than 5 MB/);
  assert.throws(() => validateAttachments(Array(MAX_IMAGES_PER_MESSAGE + 1).fill(toAttachment(IMG, "image/png"))), /At most 4 photos/);
});

test("0005 keeps existing disclosures when it rebuilds the table, and then accepts photos", async () => {
  const { db } = memoryDriver();
  const all = realMigrations();
  await migrate(db, all.slice(0, 4));
  await db.run("INSERT INTO chat_conversations (id, created_at, updated_at, origin_device_id) VALUES ('c', 1, 1, 'd')");
  const insert = (id: string, cls: string) =>
    db.run(
      `INSERT INTO ai_disclosures (id, conversation_id, sent_at_ms, data_class, summary, payload_json, bytes, created_at, updated_at, origin_device_id)
       VALUES (?, 'c', 5, ?, 'old', '{}', 2, 5, 5, 'd')`,
      [id, cls],
    );
  await insert("x", "aggregate");
  await assert.rejects(insert("p", "photo"), /CHECK/);
  await migrate(db, all);
  assert.deepEqual(await db.all("SELECT id FROM ai_disclosures"), [{ id: "x" }]);
  await insert("p", "photo");
  const [idx] = await db.all<{ n: number }>("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'idx_ai_disclosures_sent'");
  assert.equal(idx.n, 1);
});

test("writes and undo work on the phone driver without nesting plugin transactions", async () => {
  const { conn, calls } = fakePlugin();
  const db = capacitorDriver(conn);
  await migrate(db, realMigrations());
  await recordConsent(db, "claude.aggregates", true, DEV, NOW - 1000);
  calls.length = 0;
  const res = await startConversation(
    deps(db, oneRound(call("t1", "log_food", { entries: [lunch, { ...lunch, name: "Salad" }] })).create, { confirmAction: yes }),
    "Q",
  );
  assert.equal((await dayFood(db, "2026-10-24")).length, 2);
  const r2 = await startConversation(deps(db, oneRound(call("t2", "create_meal_prep", chili)).create, { confirmAction: yes }), "Recipe");
  assert.ok(!calls.includes("run:true") && !calls.includes("run:undefined"), "never nests plugin transactions");
  assert.equal(await undoAgentAction(db, res.actions[0].id, NOW + 1), 2);
  await undoAgentAction(db, r2.actions[0].id, NOW + 2);
  assert.equal((await dayFood(db, "2026-10-24")).length, 0);
  assert.equal((await listMealPreps(db)).length, 0);
});

test("conversation stays valid after a write: replayed history pairs every tool_use with a result", async () => {
  const db = await setup();
  const res = await startConversation(deps(db, oneRound(call("t1", "log_food", { entries: [lunch] })).create, { confirmAction: yes }), "Q");
  const msgs = await loadMessages(db, res.conversationId);
  assert.deepEqual(
    msgs.map((m) => m.role),
    ["user", "assistant", "user", "assistant"],
  );
  assert.equal((msgs[2].content as ToolResult[])[0].tool_use_id, "t1");
});
