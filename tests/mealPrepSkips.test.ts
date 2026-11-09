import test from "node:test";
import assert from "node:assert/strict";
import { nextUp } from "../src/domain/dashboard/today";
import { logFood } from "../src/domain/food/food";
import { addMove, DEFAULT_MEAL_PREP, loadStock, logBatch, saveMealPrep, setPortionsPerDay } from "../src/domain/mealprep/mealPrep";
import { getPrepMeals, planSkips, setPrepMeals, skipCounts, skipsBetween, skipTupper } from "../src/domain/mealprep/skips";
import { planDefrost } from "../src/domain/mealprep/stock";
import { migratedDb } from "./helpers";

const TZ = "Europe/Madrid";
const H = 3_600_000;
const NOW = Date.UTC(2026, 10, 9, 9, 0, 0); // Monday 2026-11-09, 10:00 in Madrid
const DAY = "2026-11-09";

async function withTuppers() {
  const { db } = await migratedDb();
  const id = await saveMealPrep(db, { ...DEFAULT_MEAL_PREP, name: "Chili", portions: 4, calories: 550 }, NOW - 48 * H);
  await logBatch(db, { mealPrepId: id, cookedAtMs: NOW - 24 * H, timeZone: TZ });
  return db;
}

test("skipping a tupper moves the rest of the plan on a day, and Undo takes it back", async () => {
  const db = await withTuppers();
  const plan = async () => {
    const s = await planSkips(db, DAY, 4, 1);
    return planDefrost(await loadStock(db), { today: DAY, nowMs: NOW, timeZone: TZ, portionsPerDay: 1, skips: skipCounts(s.days), horizonDays: 4 });
  };
  assert.deepEqual(
    (await plan()).meals.map((m) => m.day),
    ["2026-11-09", "2026-11-10", "2026-11-11", "2026-11-12"],
  );
  assert.equal(await skipTupper(db, DAY, DAY, 1, NOW), 1);
  assert.deepEqual(
    (await plan()).meals.map((m) => m.day),
    ["2026-11-10", "2026-11-11", "2026-11-12"],
  );
  assert.equal(await skipTupper(db, DAY, DAY, -1, NOW), 0);
  assert.equal((await plan()).meals.length, 4);
  await assert.rejects(skipTupper(db, "2026-11-08", DAY), /over/);
});

test("a meal the tuppers are for, logged as something else, skips that tupper; a portion eaten does not", async () => {
  const db = await withTuppers();
  assert.deepEqual(await getPrepMeals(db, 1), ["lunch"]);
  assert.deepEqual(await getPrepMeals(db, 2), ["lunch", "dinner"]);
  // A tupper eaten is logged as meal prep, not as lunch: nothing skipped.
  const [stock] = await loadStock(db);
  await addMove(db, { batchId: stock.batch.id, kind: "eat", portions: 1, atMs: NOW, timeZone: TZ });
  assert.equal((await skipsBetween(db, DAY, DAY, ["lunch"])).size, 0);
  // Dinner out, while the tuppers are only for lunch: nothing skipped either.
  await logFood(db, { name: "Pizza", meal: "dinner", calories: 900, proteinG: null, carbsG: null, fatG: null, atMs: NOW + 8 * H, timeZone: TZ });
  assert.equal((await skipsBetween(db, DAY, DAY, ["lunch"])).size, 0);
  await setPrepMeals(db, ["dinner", "lunch"]);
  assert.deepEqual(await getPrepMeals(db, 1), ["lunch", "dinner"]);
  assert.deepEqual(await skipsBetween(db, DAY, DAY, await getPrepMeals(db, 1)), new Map([[DAY, { manual: 0, ateOut: ["dinner"] }]]));
});

test("Next up has nothing to offer once today's tuppers are eaten out or skipped", async () => {
  const db = await withTuppers();
  await setPortionsPerDay(db, 1);
  assert.equal((await nextUp(db, TZ, NOW))?.name, "Chili");
  await logFood(db, { name: "Menu del dia", meal: "lunch", calories: 800, proteinG: null, carbsG: null, fatG: null, atMs: NOW + 3 * H, timeZone: TZ });
  assert.equal(await nextUp(db, TZ, NOW), null);

  const other = await withTuppers();
  await skipTupper(other, DAY, DAY, 1, NOW);
  assert.equal(await nextUp(other, TZ, NOW), null);
});
