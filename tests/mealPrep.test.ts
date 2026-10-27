import test from "node:test";
import assert from "node:assert/strict";
import {
  addMove,
  DEFAULT_MEAL_PREP,
  deleteBatch,
  deleteMealPrep,
  getPortionsPerDay,
  listMealPreps,
  listTags,
  loadStock,
  logBatch,
  normalizeTag,
  portionsEatenOn,
  saveMealPrep,
  setPortionsPerDay,
  undoMove,
} from "../src/features/mealprep/mealPrep";
import {
  addRecipesToShopping,
  addShoppingItem,
  clearShopping,
  formatQuantity,
  listAsText,
  listShopping,
  normalizeUnit,
  setShoppingChecked,
} from "../src/features/mealprep/shopping";
import { migratedDb } from "./helpers";

const TZ = "Europe/Madrid";
const H = 3_600_000;
const NOW = Date.UTC(2026, 9, 20, 17, 0, 0); // 2026-10-20 19:00 Madrid

async function withChili() {
  const { db, raw } = await migratedDb();
  const id = await saveMealPrep(
    db,
    {
      ...DEFAULT_MEAL_PREP,
      name: "  Chili ",
      portions: 6,
      calories: 550,
      proteinG: 40,
      tags: ["Dinner", " dinner ", "Batch  Cook"],
      ingredients: [
        { name: "Minced beef", quantity: 1, unit: "kg" },
        { name: "Kidney beans", quantity: 2, unit: "tins" },
        { name: "Cumin", quantity: null, unit: null },
      ],
    },
    NOW,
  );
  return { db, raw, id };
}

test("save a recipe with normalised tags and ordered ingredients, then edit it in place", async () => {
  const { db, id } = await withChili();
  assert.equal(normalizeTag("  Late   Lunch "), "late lunch");
  let [p] = await listMealPreps(db);
  assert.equal(p.name, "Chili");
  assert.deepEqual(p.tags, ["batch cook", "dinner"]);
  assert.deepEqual(
    p.ingredients.map((i) => i.name),
    ["Minced beef", "Kidney beans", "Cumin"],
  );

  const beef = p.ingredients[0];
  await saveMealPrep(
    db,
    {
      ...p,
      tags: ["dinner", "lunch"],
      ingredients: [
        { name: "Rice", quantity: 500, unit: "g" },
        { ...beef, quantity: 0.8 },
      ],
    },
    NOW + 1,
  );
  [p] = await listMealPreps(db);
  assert.deepEqual(p.tags, ["dinner", "lunch"]);
  assert.deepEqual(
    p.ingredients.map((i) => [i.name, i.quantity]),
    [
      ["Rice", 500],
      ["Minced beef", 0.8],
    ],
  );
  assert.equal(p.ingredients[1].id, beef.id, "edited ingredient keeps its id");

  assert.equal((await listMealPreps(db, "LUNCH")).length, 1);
  assert.equal((await listMealPreps(db, "breakfast")).length, 0);
  assert.deepEqual(await listTags(db), [
    { tag: "dinner", recipes: 1 },
    { tag: "lunch", recipes: 1 },
  ]);

  await deleteMealPrep(db, id, NOW + 2);
  assert.deepEqual(await listMealPreps(db), []);
  assert.deepEqual(await listTags(db), []);
});

test("recipe validation", async () => {
  const { db } = await migratedDb();
  await assert.rejects(saveMealPrep(db, { ...DEFAULT_MEAL_PREP, name: " " }), /name/);
  await assert.rejects(saveMealPrep(db, { ...DEFAULT_MEAL_PREP, name: "x", portions: 0 }), /Portions/);
  await assert.rejects(saveMealPrep(db, { ...DEFAULT_MEAL_PREP, name: "x", ingredients: [{ name: "salt", quantity: -1, unit: null }] }), /Quantity/);
  assert.deepEqual(await listMealPreps(db), []);
});

test("batch stock: freeze at cooking time, eat writes the food log, undo and limits", async () => {
  const { db, id } = await withChili();
  const batchId = await logBatch(db, { mealPrepId: id, frozen: 4, cookedAtMs: NOW, timeZone: TZ });
  let [s] = await loadStock(db);
  assert.equal(s.fridgeCount, 2);
  assert.equal(s.freezerCount, 4);
  assert.deepEqual(s.batch.tags, ["batch cook", "dinner"]);

  await addMove(db, { batchId, kind: "eat", portions: 2, atMs: NOW + 2 * H, timeZone: TZ });
  const [food] = await db.all<Record<string, unknown>>("SELECT name, meal, calories, protein_g, local_day, notes FROM food_entries");
  assert.deepEqual(food, { name: "Chili", meal: "prep", calories: 1100, protein_g: 80, local_day: "2026-10-20", notes: "2 portions" });
  assert.equal(await portionsEatenOn(db, "2026-10-20"), 2);
  assert.equal(await portionsEatenOn(db, "2026-10-20", "lunch"), 0);

  await assert.rejects(addMove(db, { batchId, kind: "eat", portions: 1, atMs: NOW + 3 * H, timeZone: TZ }), /Only 0 portions in the fridge/);
  await assert.rejects(addMove(db, { batchId, kind: "thaw", portions: 5, atMs: NOW + 3 * H, timeZone: TZ }), /Only 4 portions in the freezer/);

  await addMove(db, { batchId, kind: "thaw", portions: 1, atMs: NOW + 26 * H, timeZone: TZ });
  [s] = await loadStock(db);
  assert.equal(s.lastMove?.kind, "thaw");
  const thawId = s.lastMove!.id;
  await addMove(db, { batchId, kind: "eat", portions: 1, atMs: NOW + 50 * H, timeZone: TZ });
  [s] = await loadStock(db);
  await assert.rejects(undoMove(db, thawId), /Undo those first/);

  await undoMove(db, s.lastMove!.id, NOW + 51 * H);
  assert.equal((await db.all("SELECT 1 FROM food_entries WHERE deleted_at IS NULL")).length, 1, "undo removes the food log row");
  await undoMove(db, thawId, NOW + 52 * H);
  [s] = await loadStock(db);
  assert.equal(s.freezerCount, 4);

  await addMove(db, { batchId, kind: "discard", fromLoc: "freezer", portions: 4, atMs: NOW + 60 * H, timeZone: TZ });
  assert.deepEqual(await loadStock(db), [], "finished batches drop out of stock");
  assert.equal((await loadStock(db, { includeFinished: true }))[0].discarded, 4);
});

test("stock filters by tag, survives recipe deletion, and a deleted batch takes its food rows with it", async () => {
  const { db, id } = await withChili();
  const lunch = await saveMealPrep(db, { ...DEFAULT_MEAL_PREP, name: "Salad", tags: ["lunch"] }, NOW);
  const b1 = await logBatch(db, { mealPrepId: id, cookedAtMs: NOW, timeZone: TZ });
  await logBatch(db, { mealPrepId: lunch, portions: 3, cookedAtMs: NOW + 1, timeZone: TZ });
  assert.deepEqual(
    (await loadStock(db, { tag: "lunch" })).map((s) => s.batch.name),
    ["Salad"],
  );

  await deleteMealPrep(db, id, NOW + 5);
  assert.deepEqual(
    (await loadStock(db)).map((s) => s.batch.name),
    ["Chili", "Salad"],
  );

  await addMove(db, { batchId: b1, kind: "eat", portions: 1, atMs: NOW + H, timeZone: TZ });
  await deleteBatch(db, b1, NOW + 2 * H);
  assert.deepEqual(
    (await loadStock(db)).map((s) => s.batch.name),
    ["Salad"],
  );
  assert.equal((await db.all("SELECT 1 FROM food_entries WHERE deleted_at IS NULL")).length, 0);
  await assert.rejects(logBatch(db, { mealPrepId: id, timeZone: TZ }), /no longer exists/);
  await assert.rejects(logBatch(db, { mealPrepId: lunch, frozen: 9, timeZone: TZ }), /cannot freeze 9/);
});

test("portions per day are kept per tag, default 1", async () => {
  const { db } = await migratedDb();
  assert.equal(await getPortionsPerDay(db), 1);
  await setPortionsPerDay(db, 2, null, NOW);
  await setPortionsPerDay(db, 0, "Dinner", NOW);
  assert.equal(await getPortionsPerDay(db), 2);
  assert.equal(await getPortionsPerDay(db, "dinner"), 0);
  await assert.rejects(setPortionsPerDay(db, 1.5), /whole number/);
});

test("units fold into a base unit and print back readably", () => {
  assert.deepEqual(normalizeUnit(1.2, " KG "), { quantity: 1200, unit: "g" });
  assert.deepEqual(normalizeUnit(2, "Tins"), { quantity: 2, unit: "tins" });
  assert.deepEqual(normalizeUnit(null, ""), { quantity: null, unit: null });
  assert.equal(formatQuantity(1500, "g"), "1.5 kg");
  assert.equal(formatQuantity(330, "ml"), "330 ml");
  assert.equal(formatQuantity(1 / 3, null), "0.33");
  assert.equal(formatQuantity(null, null), "");
});

test("shopping list: recipes scale and merge by name and unit, ticked items stay apart", async () => {
  const { db, id } = await withChili();
  const rice = await saveMealPrep(
    db,
    {
      ...DEFAULT_MEAL_PREP,
      name: "Rice bowls",
      ingredients: [
        { name: "minced BEEF", quantity: 500, unit: "g" },
        { name: "Cumin", quantity: null, unit: null },
      ],
    },
    NOW,
  );
  const lines = await addRecipesToShopping(
    db,
    [
      { mealPrepId: id, batches: 2 },
      { mealPrepId: rice, batches: 1 },
      { mealPrepId: rice, batches: 0 },
    ],
    NOW,
  );
  assert.equal(lines, 5);
  let items = await listShopping(db);
  assert.deepEqual(
    items.map((i) => [i.name, i.quantity, i.unit]),
    [
      ["Cumin", null, null],
      ["Kidney beans", 4, "tins"],
      ["Minced beef", 2500, "g"],
    ],
  );

  const beef = items.find((i) => i.name === "Minced beef")!;
  await setShoppingChecked(db, beef.id, true, NOW + 1);
  await addShoppingItem(db, { name: "Minced beef", quantity: 1, unit: "kg" }, NOW + 2);
  await addShoppingItem(db, { name: "cumin", quantity: 10, unit: null }, NOW + 3);
  items = await listShopping(db);
  assert.deepEqual(
    items.map((i) => [i.name, i.quantity, i.checked]),
    [
      ["Cumin", 10, false],
      ["Kidney beans", 4, false],
      ["Minced beef", 1000, false],
      ["Minced beef", 2500, true],
    ],
  );
  assert.equal(listAsText(items), "- Cumin (10)\n- Kidney beans (4 tins)\n- Minced beef (1 kg)");

  await clearShopping(db, {}, NOW + 4);
  assert.equal((await listShopping(db)).length, 3);
  await clearShopping(db, { all: true }, NOW + 5);
  assert.deepEqual(await listShopping(db), []);
  await assert.rejects(addShoppingItem(db, { name: "", quantity: null, unit: null }), /name/);
});
