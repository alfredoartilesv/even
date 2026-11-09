import test from "node:test";
import assert from "node:assert/strict";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { loadDashboard } from "../src/domain/dashboard/dashboard";
import {
  dayFood,
  deleteFood,
  getCalorieGoal,
  getNutritionTargets,
  logFood,
  logTimeFor,
  macrosFromCalories,
  setNutritionTarget,
  updateFood,
} from "../src/domain/food/food";
import { DEFAULT_MEAL_PREP, eatPortions, loadStock, logBatch, saveMealPrep } from "../src/domain/mealprep/mealPrep";
import { listGoals } from "../src/domain/me/goals";
import { byMonth, listWorkouts, trainingEffectLabel, weeklyVolume, weekOf, type Workout } from "../src/domain/me/workouts";
import { upsertCatalog } from "../src/domain/metrics/catalog";
import { upsertSamples } from "../src/domain/metrics/samples";
import type { SampleInput } from "../src/domain/sync/types";
import { budgetText, MacroBudget } from "../src/ui/nutrition";
import { SyncedNumbers } from "../src/screens/dashboard/SyncedNumbers";
import type { DayValue } from "../src/domain/metrics/queries";
import { migratedDb } from "./helpers";

/**
 * Version 0.2: macro targets and what is left of them, logging on other days, eating meal prep from
 * the log, the watch's recovery numbers on the Dashboard, and richer workouts.
 */

const TZ = "Europe/Madrid";
const TODAY = "2026-10-26"; // a Monday
const NOON = Date.UTC(2026, 9, 26, 11, 0, 0); // 12:00 in Madrid (+01:00)
const midnight = (day: string) => Date.parse(`${day}T00:00:00Z`) - 60 * 60_000; // CET, after the DST change
const daily = (metric: string, day: string, valueNum: number): SampleInput => ({
  source: "garmin",
  device: "",
  externalId: `${day}#0`,
  metric,
  valueNum,
  startMs: midnight(day),
  endMs: midnight(day) + 86_400_000,
  offsetMin: 60,
});
const none = { calories: null, proteinG: null, carbsG: null, fatG: null };

test("nutrition targets: kcal and each macro, replaced and removed, shown as goals", async () => {
  const { db } = await migratedDb();
  assert.deepEqual(await getNutritionTargets(db), none);

  await setNutritionTarget(db, "calories", 2100, "2026-10-01", 1);
  await setNutritionTarget(db, "proteinG", 150, "2026-10-01", 2);
  await setNutritionTarget(db, "fatG", 70, "2026-10-01", 3);
  assert.deepEqual(await getNutritionTargets(db), { calories: 2100, proteinG: 150, carbsG: null, fatG: 70 });
  assert.equal((await getCalorieGoal(db))?.target, 2100);

  // A change on a later day ends the old target; null removes one; the same value is a no-op.
  await setNutritionTarget(db, "proteinG", 160, "2026-10-20", 4);
  await setNutritionTarget(db, "fatG", null, "2026-10-20", 5);
  await setNutritionTarget(db, "calories", 2100, "2026-10-20", 6);
  await setNutritionTarget(db, "carbsG", null, "2026-10-20", 7);
  assert.deepEqual(await getNutritionTargets(db), { calories: 2100, proteinG: 160, carbsG: null, fatG: null });

  // Protein is a floor, the rest are limits; all are day goals the profile shows with progress.
  const goals = await listGoals(db, TODAY);
  assert.deepEqual(
    goals.map((g) => [g.title, g.metric, g.comparator, g.targetNum, g.unit]),
    [
      ["Daily calories", "calories", "<=", 2100, "kcal"],
      ["Daily protein", "protein_g", ">=", 160, "g"],
    ],
  );
  await assert.rejects(setNutritionTarget(db, "carbsG", 0, TODAY), /carbs target must be more than 0/);
});

test("macros from a calorie target: 30/40/30 by default, whole grams at 4/4/9 kcal", () => {
  assert.deepEqual(macrosFromCalories(2000), { proteinG: 150, carbsG: 200, fatG: 67 });
  assert.deepEqual(macrosFromCalories(1800, [0.4, 0.3, 0.3]), { proteinG: 180, carbsG: 135, fatG: 60 });
});

test("logging on another day: now for today, the slot's usual time on a past day, never a future day", () => {
  assert.equal(logTimeFor(TODAY, "dinner", TZ, NOON), NOON);
  // 2026-10-24 is still summer time (+02:00): breakfast 08:30 is 06:30 UTC.
  assert.equal(logTimeFor("2026-10-24", "breakfast", TZ, NOON), Date.UTC(2026, 9, 24, 6, 30));
  assert.equal(logTimeFor("2026-10-25", null, TZ, NOON), Date.UTC(2026, 9, 25, 11, 0));
  assert.throws(() => logTimeFor("2026-10-27", "lunch", TZ, NOON), /not happened yet/);
});

test("an entry moves to another time and day when edited; a meal prep portion keeps its time", async () => {
  const { db } = await migratedDb();
  const id = await logFood(db, { name: "Toast", meal: "breakfast", ...none, calories: 300, atMs: NOON, timeZone: TZ });
  const yesterdayMorning = logTimeFor("2026-10-25", "breakfast", TZ, NOON);
  await updateFood(db, id, { name: "Toast", meal: "breakfast", ...none, calories: 320, atMs: yesterdayMorning, timeZone: TZ }, NOON);
  assert.equal((await dayFood(db, TODAY)).length, 0);
  const [moved] = await dayFood(db, "2026-10-25");
  assert.equal(moved.calories, 320);
  assert.equal(moved.eatenAtMs, yesterdayMorning);
  await assert.rejects(updateFood(db, id, { name: "Toast", meal: null, ...none, atMs: NOON + 86_400_000, timeZone: TZ }, NOON), /not happened yet/);

  const prep = await saveMealPrep(db, { ...DEFAULT_MEAL_PREP, name: "Chili", calories: 500 }, NOON);
  const batch = await logBatch(db, { mealPrepId: prep, cookedAtMs: NOON - 3_600_000, timeZone: TZ });
  const eaten = await eatPortions(db, { batchId: batch, portions: 1, atMs: NOON, timeZone: TZ });
  const [entry] = (await dayFood(db, TODAY)).filter((e) => e.id === eaten);
  assert.equal(entry.fromPrep, true);
  assert.equal(entry.calories, 500);
  await assert.rejects(updateFood(db, eaten, { name: "Chili", meal: "prep", ...none, atMs: yesterdayMorning, timeZone: TZ }, NOON), /keeps its time/);
  // Editing it without a new time is fine, and deleting it puts the portion back.
  await updateFood(db, eaten, { name: "Chili", meal: "prep", ...none, calories: 450, atMs: NOON, timeZone: TZ }, NOON);
  await deleteFood(db, eaten, NOON);
  assert.equal((await loadStock(db))[0].fridgeCount, 4);
});

test("budget text: left, over, still to go for protein, and the amount alone without a target", () => {
  assert.deepEqual(budgetText(1500, 2000, "kcal"), { big: "500", small: "kcal left · 1,500 of 2,000", over: false });
  assert.deepEqual(budgetText(2300, 2000, "kcal"), { big: "300", small: "kcal over · 2,300 of 2,000", over: true });
  assert.deepEqual(budgetText(90, 150, "g", true), { big: "60", small: "g to go · 90 of 150", over: false });
  assert.deepEqual(budgetText(170, 150, "g", true), { big: "170", small: "g · target met", over: false });
  assert.deepEqual(budgetText(42, null, "g"), { big: "42", small: "g eaten · no target", over: false });
});

test("MacroBudget: one tile per number, a bar only where there is a target, over in words", () => {
  const html = renderToStaticMarkup(
    h(MacroBudget, {
      eaten: { calories: 2300, proteinG: 90, carbsG: null, fatG: 50 },
      targets: { calories: 2000, proteinG: 150, carbsG: null, fatG: null },
      fromDrinks: 200,
    }),
  );
  assert.equal((html.match(/class="macro-tile( wide)?"/g) ?? []).length, 4);
  assert.equal((html.match(/role="meter"/g) ?? []).length, 2);
  assert.ok(html.includes('kcal over</div><div class="small muted">2,300 of 2,000'));
  assert.ok(html.includes('g to go</div><div class="small muted">90 of 150'));
  assert.match(html, /including 200 kcal from drinks/);
  assert.ok(html.includes('g eaten</div><div class="small muted">no target'));
});

test("dashboard recovery: resting HR, sleep, HRV (Apple's when Garmin has none), Body Battery, stress, intensity minutes", async () => {
  const { db } = await migratedDb();
  await upsertCatalog(db, "garmin", [{ metric: "daily_restingHeartRateInBeatsPerMinute" }, { metric: "sleep_durationInSeconds" }], 1);
  await upsertSamples(db, [
    daily("daily_restingHeartRateInBeatsPerMinute", "2026-10-20", 52),
    daily("daily_restingHeartRateInBeatsPerMinute", "2026-10-21", 54),
    daily("daily_restingHeartRateInBeatsPerMinute", "2026-10-13", 60), // the week before: only in a day's trend
    daily("sleep_durationInSeconds", "2026-10-21", 7 * 3600),
    daily("sleep_overallSleepScore", "2026-10-21", 81),
    daily("hrv_lastNightAvg", "2026-10-21", 48),
    { ...daily("hrv_sdnnAvg", "2026-10-20", 40), source: "apple_health" },
    daily("dailyBodyBattery_highestValue", "2026-10-21", 90),
    daily("dailyBodyBattery_lowestValue", "2026-10-21", 15),
    daily("daily_averageStressLevel", "2026-10-21", 28),
    daily("daily_moderateIntensityDurationInSeconds", "2026-10-20", 20 * 60),
    daily("daily_vigorousIntensityDurationInSeconds", "2026-10-21", 15 * 60),
    daily("daily_distanceInMeters", "2026-10-21", 8200),
  ]);

  const week = await loadDashboard(db, "week", "2026-10-21", TODAY);
  assert.deepEqual(
    { total: week.body.restingHr.total, avg: week.body.restingHr.avg, days: week.body.restingHr.daysWithData },
    { total: 106, avg: 53, days: 2 },
  );
  assert.equal(week.body.sleep.total, 7 * 3600);
  assert.equal(week.body.sleepScore.avg, 81);
  assert.deepEqual([week.body.hrv.trend[5], week.body.hrv.trend[6]], [40, 48]); // the 20th and 21st, the last of the seven days
  assert.equal(week.body.bodyBatteryLow.total, 15);
  assert.equal(week.body.stress.total, 28);
  // 20 moderate + 2 × 15 vigorous.
  assert.equal(week.body.intensityMin.total, 50);
  assert.equal(week.body.distance.total, 8200);
  assert.equal(week.trendDays.length, 7);
  assert.equal(week.body.restingHr.trend.length, 7);

  // A day's trend runs over the 14 days up to it, so the week before shows in it.
  const day = await loadDashboard(db, "day", "2026-10-21", TODAY);
  assert.equal(day.trendDays.length, 14);
  assert.equal(day.trendDays[13], "2026-10-21");
  assert.equal(day.body.restingHr.total, 54);
  assert.equal(day.body.restingHr.trend.filter((v) => v !== null).length, 3);
  assert.equal(day.body.sleep.total, 7 * 3600);
});

test("workouts carry the watch's extras (not from freddy); weekly volume, months and training effect", async () => {
  const { db } = await migratedDb();
  const day = "2026-10-21";
  const at = { startMs: midnight(day) + 8 * 3_600_000, endMs: midnight(day) + 9 * 3_600_000 };
  const g = (metric: string, v: number | string): SampleInput => ({
    source: "garmin",
    device: "Garmin",
    externalId: "activity:9",
    metric,
    ...(typeof v === "string" ? { valueText: v } : { valueNum: v }),
    ...at,
    offsetMin: 60,
  });
  await upsertSamples(db, [
    g("activity_activityType", "running"),
    g("activity_durationInSeconds", 3600),
    g("activity_distanceInMeters", 10000),
    g("activity_maxHeartRateInBeatsPerMinute", 178),
    g("activity_totalElevationGainInMeters", 120),
    g("activity_aerobicTrainingEffect", 3.4),
    g("activity_vo2Max", 51),
    // freddy, another day: its numbering is per metric, so its extras are never read.
    { ...g("activity_activityType", "cycling"), source: "freddy", externalId: "2026-10-12#0", startMs: midnight("2026-10-12"), endMs: midnight("2026-10-13") },
    { ...g("activity_durationInSeconds", 1800), source: "freddy", externalId: "2026-10-12#0", startMs: midnight("2026-10-12"), endMs: midnight("2026-10-13") },
    {
      ...g("activity_maxHeartRateInBeatsPerMinute", 199),
      source: "freddy",
      externalId: "2026-10-12#0",
      startMs: midnight("2026-10-12"),
      endMs: midnight("2026-10-13"),
    },
  ]);
  const ws = await listWorkouts(db, "2026-10-01", TODAY);
  assert.equal(ws.length, 2);
  const run = ws.find((w) => w.sport === "running")!;
  assert.deepEqual([run.maxHr, run.elevationM, run.aerobicTe, run.vo2Max, run.anaerobicTe], [178, 120, 3.4, 51, null]);
  assert.equal(ws.find((w) => w.sport === "cycling")!.maxHr, null);

  assert.equal(weekOf("2026-10-25"), "2026-10-19");
  assert.equal(weekOf("2026-10-26"), "2026-10-26");
  const weeks = weeklyVolume(ws, TODAY, 3);
  assert.deepEqual(
    weeks.map((w) => [w.week, w.sessions, w.durationS, w.distanceM]),
    [
      ["2026-10-12", 1, 1800, 0],
      ["2026-10-19", 1, 3600, 10000],
      ["2026-10-26", 0, 0, 0],
    ],
  );

  const w = (d: string) => ({ day: d }) as Workout;
  assert.deepEqual(
    byMonth([w("2026-10-21"), w("2026-10-02"), w("2026-09-30")]).map((m) => [m.month, m.items.length]),
    [
      ["2026-10", 2],
      ["2026-09", 1],
    ],
  );
  assert.deepEqual([0.5, 1.5, 2.5, 3.4, 4.2, 5, null].map(trainingEffectLabel), [
    "No effect",
    "Minor",
    "Maintaining",
    "Improving",
    "Highly improving",
    "Overreaching",
    null,
  ]);
});

test("synced numbers: one kind at a time with counts, headline number first, sleep stages as a bar", () => {
  const v = (metric: string, category: DayValue["category"], value: number): DayValue => ({
    metric,
    label: metric,
    category,
    device: "Garmin Forerunner",
    value,
    unit: null,
    readings: 1,
    partial: false,
  });
  const metrics = [
    v("sleep_deepSleepDurationInSeconds", "sleep", 5100),
    v("sleep_lightSleepDurationInSeconds", "sleep", 12600),
    v("sleep_durationInSeconds", "sleep", 23100),
    v("daily_steps", "activity", 9500),
  ];
  const html = renderToStaticMarkup(h(SyncedNumbers, { metrics }));
  assert.match(html, /4 numbers from Garmin Forerunner/);
  assert.match(html, />Activity 1</);
  assert.match(html, />Sleep 3</);
  // Activity is first in the order, so it is the one open; its stages bar only shows for sleep.
  assert.match(html, /Steps/);
  assert.doesNotMatch(html, /Sleep stages/);
});
