import test from "node:test";
import assert from "node:assert/strict";
import { logDrink } from "../src/features/alcohol/alcohol";
import { figure, loadDashboard, pinnedAnchor, shiftSpan, spanRange } from "../src/features/dashboard/dashboard";
import { newestOnly } from "../src/core/newest";
import { logFood, setCalorieGoal } from "../src/features/food/food";
import { insertGoal } from "../src/features/journal/journal";
import { upsertCatalog } from "../src/features/metrics/catalog";
import { upsertSamples } from "../src/features/metrics/samples";
import type { SampleInput } from "../src/features/sync/types";
import { migratedDb } from "./helpers";

const TZ = "Europe/Madrid";
const TODAY = "2026-10-26"; // a Monday
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

test("dashboard spans: Monday weeks, calendar months, and moving between them", () => {
  assert.deepEqual(spanRange("day", "2026-10-22"), { from: "2026-10-22", to: "2026-10-22" });
  assert.deepEqual(spanRange("week", "2026-10-22"), { from: "2026-10-19", to: "2026-10-25" });
  assert.deepEqual(spanRange("month", "2026-02-10"), { from: "2026-02-01", to: "2026-02-28" });
  assert.deepEqual(spanRange("month", "2028-02-10"), { from: "2028-02-01", to: "2028-02-29" });
  assert.equal(shiftSpan("day", "2026-10-01", -1), "2026-09-30");
  assert.equal(shiftSpan("week", "2026-10-22", 1), "2026-10-26");
  assert.equal(shiftSpan("week", "2026-10-22", -1), "2026-10-12");
  assert.equal(shiftSpan("month", "2026-03-31", -1), "2026-02-01");
  assert.equal(shiftSpan("month", "2026-12-15", 1), "2027-01-01");
});

test("dashboard figures: total, and the average over days with data only", () => {
  assert.deepEqual(figure([null, null]), { total: null, avg: null, daysWithData: 0 });
  assert.deepEqual(figure([1000, null, 3000]), { total: 4000, avg: 2000, daysWithData: 2 });
});

test("dashboard: steps, burned, eaten with drinks, balance, per day and for the week so far", async () => {
  const { db } = await migratedDb();
  await upsertCatalog(db, "garmin", [{ metric: "daily_steps" }, { metric: "daily_totalKilocalories" }, { metric: "daily_activeKilocalories" }], 1);
  await upsertSamples(db, [
    daily("daily_steps", "2026-10-20", 8000),
    daily("daily_steps", "2026-10-21", 12000),
    daily("daily_totalKilocalories", "2026-10-20", 2500),
    daily("daily_totalKilocalories", "2026-10-21", 2700),
    daily("daily_activeKilocalories", "2026-10-21", 600),
    daily("daily_steps", TODAY, 3000),
  ]);
  await logFood(db, { name: "Lunch", meal: "lunch", calories: 900, proteinG: 60, carbsG: null, fatG: null, atMs: midnight("2026-10-20") + 13 * 3_600_000, timeZone: TZ });
  await logFood(db, { name: "Dinner", meal: "dinner", calories: 1100, proteinG: 40, carbsG: null, fatG: null, atMs: midnight("2026-10-20") + 20 * 3_600_000, timeZone: TZ });
  await logDrink(db, { name: "Beer", volumeMl: 330, abvPercent: 5, calories: 150, count: 2, atMs: midnight("2026-10-21") + 21 * 3_600_000, timeZone: TZ });

  const week = await loadDashboard(db, "week", "2026-10-22", TODAY);
  assert.equal(week.from, "2026-10-19");
  assert.equal(week.to, "2026-10-25");
  assert.equal(week.days.length, 7);
  assert.deepEqual(week.steps, { total: 20000, avg: 10000, daysWithData: 2 });
  assert.deepEqual(week.burned, { total: 5200, avg: 2600, daysWithData: 2 });
  assert.deepEqual(week.eaten, { total: 2300, avg: 1150, daysWithData: 2 }); // 2,000 food + 300 drinks
  assert.equal(week.drinks.total, 300);
  // 2000 - 2500 and 300 - 2700
  assert.deepEqual(week.balance, { total: -2900, avg: -1450, daysWithData: 2 });
  assert.equal(week.protein.total, 100);
  assert.equal(week.prep.total, null);
  assert.deepEqual(week.stock, { portions: 0, batches: 0 });
  assert.deepEqual(week.targets, { kcal: null, steps: null });

  // The live calorie target and steps goal, for the rings.
  await setCalorieGoal(db, 2300, "2026-10-01", 1);
  const stamp = { createdBy: "user" as const, deviceId: "dev" };
  await insertGoal(db, { title: "8,000 steps", targetKind: "sample", metric: "daily_steps", comparator: ">=", targetNum: 8000, unit: "steps", period: "day", startDay: "2026-09-01", endDay: "2026-09-30" }, stamp);
  await insertGoal(db, { title: "10,000 steps", targetKind: "sample", metric: "daily_steps", comparator: ">=", targetNum: 10000, unit: "steps", period: "day", startDay: "2026-10-01" }, stamp);
  assert.deepEqual((await loadDashboard(db, "week", "2026-10-22", TODAY)).targets, { kcal: 2300, steps: 10000 });

  // The current week stops at today.
  const now = await loadDashboard(db, "week", TODAY, TODAY);
  assert.deepEqual([now.from, now.to, now.days.length], [TODAY, TODAY, 1]);
  assert.equal(now.steps.total, 3000);

  // A workout synced by both Garmin and (before the switch) freddy is one session.
  const run = (source: string, metric: string, v: { valueNum?: number; valueText?: string }): SampleInput => ({ ...daily(metric, "2026-10-22", 0), source, valueNum: undefined, ...v });
  await upsertSamples(db, [
    run("garmin", "activity_activityType", { valueText: "RUNNING" }),
    run("garmin", "activity_durationInSeconds", { valueNum: 1800 }),
    run("freddy", "activity_activityType", { valueText: "RUNNING" }),
    run("freddy", "activity_durationInSeconds", { valueNum: 1810 }),
  ]);
  const withRun = await loadDashboard(db, "week", "2026-10-22", TODAY);
  assert.deepEqual(withRun.workouts, { count: 1, durationS: 1800 });

  const day = await loadDashboard(db, "day", "2026-10-21", TODAY);
  assert.equal(day.days[0].eatenKcal, 300);
  assert.equal(day.days[0].activeKcal, 600);
  assert.equal(day.days[0].proteinG, null);
});

test("the current period follows today (the app can stay open overnight); a past one stays pinned", () => {
  const today = "2026-10-27"; // a Tuesday
  assert.equal(pinnedAnchor("day", today, today), null);
  assert.equal(pinnedAnchor("day", "2026-10-26", today), "2026-10-26");
  assert.equal(pinnedAnchor("week", "2026-10-26", today), null, "Monday of this week is this week");
  assert.equal(pinnedAnchor("week", "2026-10-25", today), "2026-10-25", "Sunday is last week");
  assert.equal(pinnedAnchor("month", "2026-10-01", today), null);
  assert.equal(pinnedAnchor("month", "2026-09-30", today), "2026-09-30");
});

test("overlapping loads: only the newest answer is applied, whatever order they finish in", async () => {
  const begin = newestOnly();
  const shown: string[] = [];
  const load = async (label: string, ms: number) => {
    const isNewest = begin();
    await new Promise((r) => setTimeout(r, ms));
    if (isNewest()) shown.push(label);
  };
  // A slow month load, then a quick day load: the month answer arrives last and must be dropped.
  await Promise.all([load("month", 30), load("day", 5)]);
  assert.deepEqual(shown, ["day"]);
  await load("week", 1);
  assert.deepEqual(shown, ["day", "week"]);
});
