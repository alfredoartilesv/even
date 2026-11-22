import test from "node:test";
import assert from "node:assert/strict";
import { listAgentActions, logAgentAction, undoAgentAction, type ActionContext, type PreparedAction } from "../src/domain/chat/actions";
import { EDIT_TOOLS_BY_NAME } from "../src/domain/chat/editActions";
import { TOOLS_BY_NAME } from "../src/domain/chat/tools";
import { dayFood, logFood } from "../src/domain/food/food";
import { listDrinks, listDrinkTypes, logDrink, saveDrinkType } from "../src/domain/alcohol/alcohol";
import { migratedDb } from "./helpers";

// The connector's edit and delete tools (src/domain/chat/editActions.ts): same functions as the screens,
// every change logged with what it touched, and undone only while the row is as the action left it.
const NOW = Date.UTC(2026, 10, 22, 18, 0, 0); // Sunday 22 Nov 2026, 19:00 in Madrid
const TZ = "Europe/Madrid";
const DEV = "device-1";

async function setup() {
  const { db } = await migratedDb();
  const ctx: ActionContext = { db, deviceId: DEV, now: NOW, timeZone: TZ, conversationId: "" };
  return { db, ctx };
}

/** What the connector does: prepare, apply, log. Returns the logged action's id and its proposal. */
async function run(ctx: ActionContext, name: string, input: unknown, now = ctx.now): Promise<{ id: string; proposal: PreparedAction }> {
  const c = { ...ctx, now };
  const proposal = await EDIT_TOOLS_BY_NAME.get(name)!.prepare(c, input);
  const applied = await proposal.apply();
  const id = await logAgentAction(c.db, {
    conversationId: null,
    tool: name,
    summary: proposal.summary,
    input,
    status: "applied",
    rows: applied.rows,
    deviceId: DEV,
    now,
  });
  return { id, proposal };
}

const eatenAt = (day: string, hhmm: string) => Date.parse(`${day}T${hhmm}:00+01:00`);

test("update_food_entry changes only what is given, shows before and after, and undo puts the old values back", async () => {
  const { db, ctx } = await setup();
  const id = await logFood(db, {
    name: "Toast",
    meal: "breakfast",
    calories: 200,
    proteinG: 6,
    carbsG: 30,
    fatG: 5,
    atMs: eatenAt("2026-11-21", "08:30"),
    timeZone: TZ,
  });
  const input = {
    entry_id: id,
    name: null,
    meal: null,
    day: null,
    time: null,
    calories: 260,
    protein_g: null,
    carbs_g: null,
    fat_g: null,
    notes: "with butter",
  };
  const { id: actionId, proposal } = await run(ctx, "update_food_entry", input);
  assert.match(proposal.lines[0], /^Now: 2026-11-21 08:30 breakfast: Toast, 200 kcal/);
  assert.match(proposal.lines[1], /^Becomes: 2026-11-21 08:30 breakfast: Toast, 260 kcal/);
  const [e] = await dayFood(db, "2026-11-21");
  assert.deepEqual([e.name, e.calories, e.proteinG, e.notes], ["Toast", 260, 6, "with butter"]);

  await undoAgentAction(db, actionId, NOW + 1000);
  const [back] = await dayFood(db, "2026-11-21");
  assert.deepEqual([back.calories, back.notes, back.eatenAtMs], [200, null, eatenAt("2026-11-21", "08:30")]);
});

test("update_food_entry can move an entry to another day and time, and undo moves it back", async () => {
  const { db, ctx } = await setup();
  const id = await logFood(db, {
    name: "Pasta",
    meal: "dinner",
    calories: 700,
    proteinG: null,
    carbsG: null,
    fatG: null,
    atMs: eatenAt("2026-11-21", "21:00"),
    timeZone: TZ,
  });
  const input = {
    entry_id: id,
    name: null,
    meal: "lunch",
    day: "2026-11-20",
    time: "14:15",
    calories: null,
    protein_g: null,
    carbs_g: null,
    fat_g: null,
    notes: null,
  };
  const { id: actionId } = await run(ctx, "update_food_entry", input);
  assert.equal((await dayFood(db, "2026-11-21")).length, 0);
  const [moved] = await dayFood(db, "2026-11-20");
  assert.deepEqual([moved.meal, moved.eatenAtMs], ["lunch", eatenAt("2026-11-20", "14:15")]);
  await undoAgentAction(db, actionId, NOW + 1000);
  const [back] = await dayFood(db, "2026-11-21");
  assert.deepEqual([back.meal, back.eatenAtMs], ["dinner", eatenAt("2026-11-21", "21:00")]);
});

test("an edit that changes nothing, a future day and an unknown id are refused before anything is written", async () => {
  const { db, ctx } = await setup();
  const id = await logFood(db, {
    name: "Apple",
    meal: "snack",
    calories: 80,
    proteinG: null,
    carbsG: null,
    fatG: null,
    atMs: eatenAt("2026-11-21", "17:00"),
    timeZone: TZ,
  });
  const base = { entry_id: id, name: null, meal: null, day: null, time: null, calories: null, protein_g: null, carbs_g: null, fat_g: null, notes: null };
  const tool = EDIT_TOOLS_BY_NAME.get("update_food_entry")!;
  await assert.rejects(tool.prepare(ctx, base), /Nothing to change/);
  await assert.rejects(tool.prepare(ctx, { ...base, day: "2026-11-23" }), /in the future/);
  await assert.rejects(tool.prepare(ctx, { ...base, entry_id: "nope", calories: 1 }), /No food entry with id nope/);
  await assert.rejects(tool.prepare(ctx, { ...base, calories: -5 }), /Invalid arguments|too_small|>=0|at least 0/i);
  assert.equal((await dayFood(db, "2026-11-21"))[0].calories, 80);
});

test("undo of an edit refuses when the owner changed the entry since", async () => {
  const { db, ctx } = await setup();
  const id = await logFood(db, {
    name: "Rice",
    meal: "lunch",
    calories: 300,
    proteinG: null,
    carbsG: null,
    fatG: null,
    atMs: eatenAt("2026-11-21", "14:00"),
    timeZone: TZ,
  });
  const { id: actionId } = await run(ctx, "update_food_entry", {
    entry_id: id,
    name: null,
    meal: null,
    day: null,
    time: null,
    calories: 350,
    protein_g: null,
    carbs_g: null,
    fat_g: null,
    notes: null,
  });
  await db.run("UPDATE food_entries SET calories = 400, updated_at = ? WHERE id = ?", [NOW + 5000, id]);
  await assert.rejects(undoAgentAction(db, actionId, NOW + 6000), /changed since/);
  assert.equal((await dayFood(db, "2026-11-21"))[0].calories, 400, "the owner's later edit stays");
});

test("delete_food_entries deletes several, undo brings them back, and a meal prep portion is refused", async () => {
  const { db, ctx } = await setup();
  const at = eatenAt("2026-11-21", "13:00");
  const a = await logFood(db, { name: "Soup", meal: "lunch", calories: 150, proteinG: null, carbsG: null, fatG: null, atMs: at, timeZone: TZ });
  const b = await logFood(db, { name: "Bread", meal: "lunch", calories: 120, proteinG: null, carbsG: null, fatG: null, atMs: at + 1, timeZone: TZ });
  const { id: actionId, proposal } = await run(ctx, "delete_food_entries", { entry_ids: [a, b] });
  assert.equal(proposal.summary, "Delete 2 food entries");
  assert.equal((await dayFood(db, "2026-11-21")).length, 0);
  await undoAgentAction(db, actionId, NOW + 1000);
  assert.equal((await dayFood(db, "2026-11-21")).length, 2);

  // A portion eaten from meal prep stock: its stock move belongs to Even's Stock screen, so the tool refuses it.
  await db.run("PRAGMA foreign_keys = OFF");
  await db.run(
    `INSERT INTO meal_prep_moves (id, batch_id, at_ms, local_day, kind, from_loc, portions, food_entry_id, created_at, updated_at, origin_device_id)
     VALUES ('m1', 'b1', ?, '2026-11-21', 'eat', 'fridge', 1, ?, ?, ?, 'dev')`,
    [at, a, NOW, NOW],
  );
  await assert.rejects(EDIT_TOOLS_BY_NAME.get("delete_food_entries")!.prepare(ctx, { entry_ids: [a] }), /meal prep stock/);
});

test("deleting twice, or an id that does not exist, is refused; more than 20 ids too", async () => {
  const { db, ctx } = await setup();
  const id = await logFood(db, {
    name: "Egg",
    meal: "breakfast",
    calories: 70,
    proteinG: null,
    carbsG: null,
    fatG: null,
    atMs: eatenAt("2026-11-21", "09:00"),
    timeZone: TZ,
  });
  await run(ctx, "delete_food_entries", { entry_ids: [id] });
  await assert.rejects(EDIT_TOOLS_BY_NAME.get("delete_food_entries")!.prepare(ctx, { entry_ids: [id] }), /No food entry/);
  await assert.rejects(EDIT_TOOLS_BY_NAME.get("delete_food_entries")!.prepare(ctx, { entry_ids: Array.from({ length: 21 }, (_, i) => `x${i}`) }), /<=20 items/);
});

test("list_drink_entries gives ids and local times; update and delete drinks, each undone", async () => {
  const { db, ctx } = await setup();
  const [d1] = await logDrink(db, { name: "Beer", volumeMl: 330, abvPercent: 5, price: 2.5, count: 1, atMs: eatenAt("2026-11-21", "22:30"), timeZone: TZ });
  const listed = await TOOLS_BY_NAME.get("list_drink_entries")!.run(db, { from: "2026-11-21", to: "2026-11-21" });
  const entries = (listed.result as { entries: { id: string; time: string; price: number }[] }).entries;
  assert.deepEqual([entries[0].id, entries[0].time, entries[0].price], [d1, "22:30", 2.5]);

  const upd = { entry_id: d1, name: null, volume_ml: 500, abv_percent: null, calories: null, price: 3.2, day: null, time: "22:45" };
  const { id: a1, proposal } = await run(ctx, "update_drink_entry", upd);
  assert.match(proposal.lines[1], /500 ml.*price 3\.2/);
  let [d] = await listDrinks(db, "2026-11-21", "2026-11-21");
  assert.deepEqual([d.volumeMl, d.price, d.drunkAtMs], [500, 3.2, eatenAt("2026-11-21", "22:45")]);
  await undoAgentAction(db, a1, NOW + 1000);
  [d] = await listDrinks(db, "2026-11-21", "2026-11-21");
  assert.deepEqual([d.volumeMl, d.price, d.drunkAtMs], [330, 2.5, eatenAt("2026-11-21", "22:30")]);

  const { id: a2 } = await run(ctx, "delete_drink_entries", { entry_ids: [d1] }, NOW + 2000);
  assert.equal((await listDrinks(db, "2026-11-21", "2026-11-21")).length, 0);
  await undoAgentAction(db, a2, NOW + 3000);
  assert.equal((await listDrinks(db, "2026-11-21", "2026-11-21")).length, 1);
});

test("drink types: update by name, rename clash refused, delete leaves logged drinks, undo restores", async () => {
  const { db, ctx } = await setup();
  const id = await saveDrinkType(db, { name: "Mahou 33", volumeMl: 330, abvPercent: 5.5, calories: null, price: 1.2 });
  await saveDrinkType(db, { name: "Wine", volumeMl: 150, abvPercent: 12, calories: null, price: 3 });
  await logDrink(db, { typeId: id, count: 1, atMs: eatenAt("2026-11-21", "20:00"), timeZone: TZ });
  const upd = { drink_type: "mahou 33", name: null, volume_ml: null, abv_percent: null, calories: 140, price: 1.5 };
  const { id: a1 } = await run(ctx, "update_drink_type", upd);
  const [t] = (await listDrinkTypes(db)).filter((x) => x.id === id);
  assert.deepEqual([t.calories, t.price], [140, 1.5]);
  assert.equal((await listDrinks(db, "2026-11-21", "2026-11-21"))[0].price, 1.2, "logged drinks keep their own price");
  await undoAgentAction(db, a1, NOW + 1000);
  assert.deepEqual(
    (await listDrinkTypes(db)).filter((x) => x.id === id).map((x) => [x.calories, x.price]),
    [[null, 1.2]],
  );

  await assert.rejects(
    EDIT_TOOLS_BY_NAME.get("update_drink_type")!.prepare(ctx, { ...upd, name: "wine", calories: null, price: null }),
    /already a drink called/,
  );

  const { id: a2 } = await run(ctx, "delete_drink_type", { drink_type: "Mahou 33" }, NOW + 2000);
  assert.equal(
    (await listDrinkTypes(db)).some((x) => x.id === id),
    false,
  );
  assert.equal((await listDrinks(db, "2026-11-21", "2026-11-21")).length, 1);
  // The name was taken meanwhile: the undo must not make two.
  await saveDrinkType(db, { name: "Mahou 33", volumeMl: 200, abvPercent: 5, calories: null, price: null });
  await assert.rejects(undoAgentAction(db, a2, NOW + 3000), /already a drink called/);
});

test("the action log lists edits and deletes as applied and undoable, and refuses tables outside its list", async () => {
  const { db, ctx } = await setup();
  const id = await logFood(db, {
    name: "Yoghurt",
    meal: "snack",
    calories: 90,
    proteinG: null,
    carbsG: null,
    fatG: null,
    atMs: eatenAt("2026-11-21", "11:00"),
    timeZone: TZ,
  });
  const { id: actionId } = await run(ctx, "delete_food_entries", { entry_ids: [id] });
  const [a] = await listAgentActions(db);
  assert.deepEqual([a.tool, a.status, a.conversationId], ["delete_food_entries", "applied", null]);
  await db.run("UPDATE agent_actions SET rows_json = ? WHERE id = ?", [
    JSON.stringify([{ op: "restore", table: "app_settings", id: "x", stamp: 1 }]),
    actionId,
  ]);
  await assert.rejects(undoAgentAction(db, actionId), /Refusing to undo restore on table app_settings/);
  assert.equal((await dayFood(db, "2026-11-21")).length, 0, "nothing was touched");
});
