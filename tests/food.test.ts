import test from "node:test";
import assert from "node:assert/strict";
import { exportBackup, restoreBackup } from "../src/domain/backup/backup";
import {
  dayFood,
  deleteFood,
  deleteSavedMeal,
  getCalorieGoal,
  listSavedMeals,
  loggedDaysBefore,
  logFood,
  logSavedMeal,
  nutritionRange,
  photoDataUrl,
  relogFood,
  saveEntryAsMeal,
  saveMeal,
  setCalorieGoal,
  suggestions,
  updateFood,
  type PhotoInput,
} from "../src/domain/food/food";
import { addMove, DEFAULT_MEAL_PREP, loadStock, logBatch, saveMealPrep } from "../src/domain/mealprep/mealPrep";
import { mealForHour, rankSuggestions, usualMeal, type Candidate } from "../src/domain/food/suggest";
import { migratedDb } from "./helpers";

const TZ = "Europe/Madrid";
const H = 3_600_000;
// 2026-10-20 08:00 in Madrid (+02:00)
const MORNING = Date.UTC(2026, 9, 20, 6, 0, 0);
const DAY = 24 * H;
const PHOTO: PhotoInput = { mime: "image/jpeg", dataB64: "/9j/4AAQSkZJRg==", width: 640, height: 480 };
const none = { calories: null, proteinG: null, carbsG: null, fatG: null };

test("meal slot by hour, usual slot, ranking", () => {
  assert.deepEqual([4, 5, 11, 16, 19, 23].map(mealForHour), ["dinner", "breakfast", "lunch", "snack", "dinner", "dinner"]);
  assert.equal(usualMeal({ slots: { lunch: 2, dinner: 3 }, defaultMeal: "lunch" }), "dinner");
  assert.equal(usualMeal({ slots: {}, defaultMeal: "snack" }), "snack");

  const c = (over: Partial<Candidate>): Candidate => ({
    key: over.name!,
    savedMealId: null,
    lastEntryId: null,
    name: "",
    calories: null,
    photoId: null,
    uses: 2,
    lastMs: MORNING - 10 * DAY,
    slots: {},
    defaultMeal: null,
    loggedToday: false,
    ...over,
  });
  const ranked = rankSuggestions(
    [
      c({ name: "Pasta", uses: 5, slots: { dinner: 5 } }),
      c({ name: "Oats", uses: 3, slots: { breakfast: 3 } }),
      c({ name: "Eggs", uses: 6, slots: { breakfast: 6 }, loggedToday: true }),
      c({ name: "Toast", savedMealId: "s", uses: 0, defaultMeal: "breakfast" }),
    ],
    "breakfast",
    MORNING,
  );
  assert.deepEqual(
    ranked.map((r) => r.name),
    ["Oats", "Toast", "Pasta", "Eggs"],
  );
});

test("log, edit, relog and delete food; local day in the owner's zone", async () => {
  const { db } = await migratedDb();
  const late = Date.UTC(2026, 9, 20, 22, 30, 0); // 00:30 on the 21st in Madrid
  const id = await logFood(db, { name: " Pizza ", meal: "dinner", calories: 900, proteinG: 35, carbsG: null, fatG: null, atMs: late, timeZone: TZ });
  let [e] = await dayFood(db, "2026-10-21");
  assert.equal(e.name, "Pizza");
  assert.equal(e.fromPrep, false);

  await updateFood(db, id, { name: "Pizza margherita", meal: "dinner", calories: 850, proteinG: 30, carbsG: 100, fatG: 30 }, late + 1);
  const again = await relogFood(db, id, { atMs: late + DAY, timeZone: TZ });
  [e] = await dayFood(db, "2026-10-22");
  assert.equal(e.id, again);
  assert.deepEqual([e.name, e.calories, e.carbsG], ["Pizza margherita", 850, 100]);

  await deleteFood(db, id, late + 2);
  assert.deepEqual(await dayFood(db, "2026-10-21"), []);
  await assert.rejects(logFood(db, { name: "", meal: null, ...none, timeZone: TZ }), /name/);
  await assert.rejects(logFood(db, { name: "x", meal: null, ...none, calories: -5, timeZone: TZ }), /Calories/);
});

test("nutrition range fills empty days, history pages by logged day", async () => {
  const { db } = await migratedDb();
  await logFood(db, { name: "a", meal: "lunch", ...none, calories: 500, atMs: MORNING, timeZone: TZ });
  await logFood(db, { name: "b", meal: "dinner", ...none, calories: 700, proteinG: 40, atMs: MORNING + 10 * H, timeZone: TZ });
  await logFood(db, { name: "c", meal: "lunch", ...none, calories: 300, atMs: MORNING + 2 * DAY, timeZone: TZ });
  const r = await nutritionRange(db, "2026-10-19", "2026-10-22");
  assert.deepEqual(
    r.map((d) => [d.day, d.entries, d.calories]),
    [
      ["2026-10-19", 0, null],
      ["2026-10-20", 2, 1200],
      ["2026-10-21", 0, null],
      ["2026-10-22", 1, 300],
    ],
  );
  assert.deepEqual(await loggedDaysBefore(db, "2026-10-23"), ["2026-10-22", "2026-10-20"]);
  assert.deepEqual(await loggedDaysBefore(db, "2026-10-22", 1), ["2026-10-20"]);
});

test("calorie goal: one live goal, history kept when it changes on a later day", async () => {
  const { db } = await migratedDb();
  assert.equal(await getCalorieGoal(db), null);
  await setCalorieGoal(db, 2200, "2026-10-20", MORNING);
  await setCalorieGoal(db, 2000, "2026-10-20", MORNING + 1); // same day: replaced
  assert.equal((await db.all("SELECT 1 FROM goals")).length, 2);
  await setCalorieGoal(db, 1900, "2026-10-25", MORNING + 5 * DAY);
  assert.deepEqual(await getCalorieGoal(db), { id: (await getCalorieGoal(db))!.id, target: 1900, startDay: "2026-10-25" });
  const [old] = await db.all<{ end_day: string }>("SELECT end_day FROM goals WHERE target_num = 2000");
  assert.equal(old.end_day, "2026-10-24");
  await setCalorieGoal(db, null, "2026-10-26", MORNING + 6 * DAY);
  assert.equal(await getCalorieGoal(db), null);
  await assert.rejects(setCalorieGoal(db, 0, "2026-10-26"), /more than 0/);
});

test("saved meals with photos: bookmark an entry, its history links, photo replace and delete", async () => {
  const { db } = await migratedDb();
  const first = await logFood(db, { name: "Poke bowl", meal: "lunch", calories: 650, proteinG: 30, carbsG: 80, fatG: 20, atMs: MORNING, timeZone: TZ });
  const second = await logFood(db, { name: "poke bowl", meal: "lunch", calories: 650, proteinG: 30, carbsG: 80, fatG: 20, atMs: MORNING + DAY, timeZone: TZ });
  const savedId = await saveEntryAsMeal(db, second, PHOTO, MORNING + DAY + 1);
  let [m] = await listSavedMeals(db);
  assert.equal(m.uses, 2, "earlier entry with the same name is linked too");
  assert.equal(m.meal, "lunch");
  assert.ok(m.photoId);
  assert.equal(await photoDataUrl(db, m.photoId!), `data:image/jpeg;base64,${PHOTO.dataB64}`);
  assert.equal((await dayFood(db, "2026-10-20"))[0].photoId, m.photoId, "history shows the saved meal's photo");
  assert.equal(await saveEntryAsMeal(db, first, undefined, MORNING + DAY + 2), savedId, "already saved: same id");

  const oldPhoto = m.photoId!;
  await saveMeal(db, { ...m, photo: { ...PHOTO, dataB64: "AAAA" } }, MORNING + DAY + 3);
  [m] = await listSavedMeals(db);
  assert.notEqual(m.photoId, oldPhoto);
  assert.equal(await photoDataUrl(db, oldPhoto), null, "replaced photo is removed");
  await saveMeal(db, { ...m, name: "Salmon poke" }, MORNING + DAY + 4); // photo undefined: kept
  [m] = await listSavedMeals(db);
  assert.equal(m.name, "Salmon poke");
  assert.ok(m.photoId);

  await logSavedMeal(db, savedId, { servings: 1.5, atMs: MORNING + 2 * DAY, timeZone: TZ });
  const [e] = await dayFood(db, "2026-10-22");
  assert.deepEqual([e.name, e.calories, e.proteinG, e.notes, e.savedMealId], ["Salmon poke", 975, 45, "1.5 servings", savedId]);

  await deleteSavedMeal(db, savedId, MORNING + 3 * DAY);
  assert.deepEqual(await listSavedMeals(db), []);
  assert.equal((await dayFood(db, "2026-10-20")).length, 1, "history stays");
  assert.equal((await dayFood(db, "2026-10-20"))[0].photoId, null);
  assert.equal((await db.all("SELECT 1 FROM food_photos WHERE deleted_at IS NULL")).length, 0);

  await assert.rejects(saveMeal(db, { name: "x", meal: null, ...none, photo: { ...PHOTO, dataB64: "not base64!" } }), /not valid/);
  await assert.rejects(saveMeal(db, { name: "x", meal: null, ...none, photo: { ...PHOTO, dataB64: "A".repeat(2_100_000) } }), /too large/);
});

test("suggestions: saved meals and repeated meals, ranked for the time of day, prep excluded", async () => {
  const { db } = await migratedDb();
  for (let d = 1; d <= 3; d++) {
    await logFood(db, { name: "Oats", meal: "breakfast", ...none, calories: 350, atMs: MORNING - d * DAY, timeZone: TZ });
    await logFood(db, { name: "Chicken rice", meal: "dinner", ...none, calories: 700, atMs: MORNING - d * DAY + 12 * H, timeZone: TZ });
  }
  await logFood(db, { name: "Once only", meal: "breakfast", ...none, atMs: MORNING - DAY, timeZone: TZ });
  await logFood(db, { name: "Too old", meal: "breakfast", ...none, atMs: MORNING - 40 * DAY, timeZone: TZ });
  await logFood(db, { name: "Too old", meal: "breakfast", ...none, atMs: MORNING - 41 * DAY, timeZone: TZ });
  await saveMeal(db, { name: "Protein shake", meal: "snack", ...none, calories: 200 }, MORNING);
  const prep = await saveMealPrep(db, { ...DEFAULT_MEAL_PREP, name: "Chili", portions: 4 }, MORNING - 5 * DAY);
  const batch = await logBatch(db, { mealPrepId: prep, cookedAtMs: MORNING - 5 * DAY, timeZone: TZ });
  for (let d = 1; d <= 2; d++) await addMove(db, { batchId: batch, kind: "eat", portions: 1, atMs: MORNING - d * DAY + H, timeZone: TZ });

  const s = await suggestions(db, { nowMs: MORNING, timeZone: TZ });
  assert.deepEqual(
    s.map((c) => c.name),
    ["Oats", "Chicken rice", "Protein shake"],
  );
  assert.equal(s[0].uses, 3);
  assert.ok(s[0].lastEntryId);
  assert.equal(s[2].savedMealId !== null, true);

  const evening = await suggestions(db, { nowMs: MORNING + 12 * H, timeZone: TZ });
  assert.equal(evening[0].name, "Chicken rice");
});

test("deleting a food entry made by eating meal prep puts the portion back", async () => {
  const { db } = await migratedDb();
  const prep = await saveMealPrep(db, { ...DEFAULT_MEAL_PREP, name: "Chili", portions: 2, calories: 500 }, MORNING);
  const batch = await logBatch(db, { mealPrepId: prep, cookedAtMs: MORNING, timeZone: TZ });
  await addMove(db, { batchId: batch, kind: "eat", portions: 1, atMs: MORNING + H, timeZone: TZ });
  const [e] = await dayFood(db, "2026-10-20");
  assert.equal(e.fromPrep, true);
  await deleteFood(db, e.id, MORNING + 2 * H);
  assert.deepEqual(await dayFood(db, "2026-10-20"), []);
  assert.equal((await loadStock(db))[0].fridgeCount, 2);

  // Logging it again is a normal meal in the slot for that time, not another stock move.
  await addMove(db, { batchId: batch, kind: "eat", portions: 1, atMs: MORNING + 3 * H, timeZone: TZ });
  const [eaten] = await dayFood(db, "2026-10-20");
  await relogFood(db, eaten.id, { atMs: MORNING + 12 * H, timeZone: TZ });
  const relogged = (await dayFood(db, "2026-10-20"))[1];
  assert.deepEqual([relogged.meal, relogged.fromPrep], ["dinner", false]);
  assert.equal((await loadStock(db))[0].fridgeCount, 1);
});

test("saved meals and photos survive a backup round trip", async () => {
  const { db } = await migratedDb();
  const id = await logFood(db, { name: "Poke", meal: "lunch", ...none, calories: 600, atMs: MORNING, timeZone: TZ });
  await saveEntryAsMeal(db, id, PHOTO, MORNING + 1);
  const { text } = await exportBackup(db, "correct horse battery", { iterations: 1000, now: MORNING + 2 });
  const { db: fresh } = await migratedDb();
  await fresh.exec("PRAGMA foreign_keys = ON");
  await restoreBackup(fresh, text, "correct horse battery");
  const [m] = await listSavedMeals(fresh);
  assert.equal(m.uses, 1);
  assert.equal(await photoDataUrl(fresh, m.photoId!), `data:image/jpeg;base64,${PHOTO.dataB64}`);
});
