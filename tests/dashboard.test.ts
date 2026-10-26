import test from "node:test";
import assert from "node:assert/strict";
import { logDrink } from "../src/features/alcohol/alcohol";
import { figure, loadDashboard, shiftSpan, spanRange } from "../src/features/dashboard/dashboard";
import { logFood } from "../src/features/food/food";
import { upsertCatalog } from "../src/features/metrics/catalog";
import { upsertSamples } from "../src/features/metrics/samples";
import type { SampleInput } from "../src/features/sync/types";
import { migratedDb } from "./helpers";

const TZ = "Europe/Madrid";
const TODAY = "2026-10-26"; // a Monday
const midnight = (day: string) => Date.parse(`${day}T00:00:00Z`) - 60 * 60_000; // CET, after the DST change
const daily = (metric: string, day: string, valueNum: number): SampleInput => ({
  source: "freddy",
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
  await upsertCatalog(db, "freddy", [{ metric: "daily_steps" }, { metric: "daily_totalKilocalories" }, { metric: "daily_activeKilocalories" }], 1);
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

  // The current week stops at today.
  const now = await loadDashboard(db, "week", TODAY, TODAY);
  assert.deepEqual([now.from, now.to, now.days.length], [TODAY, TODAY, 1]);
  assert.equal(now.steps.total, 3000);

  const day = await loadDashboard(db, "day", "2026-10-21", TODAY);
  assert.equal(day.days[0].eatenKcal, 300);
  assert.equal(day.days[0].activeKcal, 600);
  assert.equal(day.days[0].proteinG, null);
});
