import test from "node:test";
import assert from "node:assert/strict";
import { classifyMetric, DAILY_AGG_OVERRIDES, upsertCatalog } from "../src/features/metrics/catalog";
import { dayValues } from "../src/features/metrics/queries";
import { upsertSamples } from "../src/features/metrics/samples";
import { migrate } from "../src/db/migrate";
import type { SampleInput } from "../src/features/sync/types";
import { memoryDriver, migratedDb, realMigrations } from "./helpers";

const NOW = 1_800_000_000_000;

test("classifyMetric guesses category and daily aggregation from the name", () => {
  assert.deepEqual(classifyMetric("daily_steps"), { category: "activity", dailyAgg: "sum" });
  assert.deepEqual(classifyMetric("sleep_durationInSeconds"), { category: "sleep", dailyAgg: "last" });
  assert.deepEqual(classifyMetric("daily_averageHeartRateInBeatsPerMinute"), { category: "heart", dailyAgg: "avg" });
  assert.deepEqual(classifyMetric("daily_stressQualifier"), { category: "stress", dailyAgg: "avg" });
  assert.deepEqual(classifyMetric("body_weightInGrams"), { category: "body", dailyAgg: "last" });
  assert.deepEqual(classifyMetric("something_new"), { category: "other", dailyAgg: "avg" });
});

test("classifyMetric knows the Garmin metrics the name rule gets wrong, and keeps their category", () => {
  assert.deepEqual(classifyMetric("activity_aerobicTrainingEffect"), { category: "activity", dailyAgg: "max" });
  assert.deepEqual(classifyMetric("activity_vo2Max"), { category: "activity", dailyAgg: "max" });
  assert.deepEqual(classifyMetric("activity_maxHeartRateInBeatsPerMinute"), { category: "heart", dailyAgg: "max" });
  assert.deepEqual(classifyMetric("daily_minHeartRateInBeatsPerMinute"), { category: "heart", dailyAgg: "min" });
  assert.deepEqual(classifyMetric("daily_maxStressLevel"), { category: "stress", dailyAgg: "max" });
  assert.deepEqual(classifyMetric("pulseOx_minSpo2InPercent"), { category: "heart", dailyAgg: "min" });
  // Sums that are right stay sums.
  assert.equal(classifyMetric("activity_activeKilocalories").dailyAgg, "sum");
  assert.equal(classifyMetric("activity_durationInSeconds").dailyAgg, "sum");
});

/** Two workouts on one day, as the Personal API sync stores them. */
function twoWorkouts(source: string): SampleInput[] {
  const at = (h: number) => ({ startMs: Date.UTC(2026, 9, 24, h), endMs: Date.UTC(2026, 9, 24, h + 1), offsetMin: 120 });
  const w = (id: number, h: number, te: number, vo2: number, maxHr: number, kcal: number): SampleInput[] => [
    { source, device: "Garmin", externalId: `activity:${id}`, metric: "activity_aerobicTrainingEffect", ...at(h), valueNum: te },
    { source, device: "Garmin", externalId: `activity:${id}`, metric: "activity_vo2Max", ...at(h), valueNum: vo2, unit: "ml/kg/min" },
    { source, device: "Garmin", externalId: `activity:${id}`, metric: "activity_maxHeartRateInBeatsPerMinute", ...at(h), valueNum: maxHr, unit: "bpm" },
    { source, device: "Garmin", externalId: `activity:${id}`, metric: "activity_activeKilocalories", ...at(h), valueNum: kcal, unit: "kcal" },
  ];
  return [...w(1, 6, 3.2, 51, 175, 420), ...w(2, 16, 2.8, 50, 160, 300)];
}

for (const source of ["garmin", "garmin_export"]) {
  test(`a day with two workouts (${source}): training effect, VO2 max and max HR are the day's highest, kcal the sum`, async () => {
    const { db } = await migratedDb();
    const samples = twoWorkouts(source);
    await upsertSamples(db, samples, NOW);
    const metrics = [...new Set(samples.map((s) => s.metric))];
    await upsertCatalog(db, source, metrics.map((metric) => ({ metric })), NOW);

    const day = await dayValues(db, "2026-10-24");
    const v = (m: string) => day.find((d) => d.metric === m)!.value;
    assert.equal(v("activity_aerobicTrainingEffect"), 3.2, "not 6.0");
    assert.equal(v("activity_vo2Max"), 51, "not 101");
    assert.equal(v("activity_maxHeartRateInBeatsPerMinute"), 175, "not the average 167.5");
    assert.equal(v("activity_activeKilocalories"), 720);
  });
}

test("migration 0010 fixes catalog rows that still hold the old guess, and keeps the owner's choices", async () => {
  const { db } = memoryDriver();
  const all = realMigrations();
  await migrate(db, all.filter((m) => m.version < 10));
  const row = (source: string, metric: string, agg: string) =>
    db.run("INSERT INTO metric_catalog (source, metric, category, daily_agg, updated_at) VALUES (?, ?, 'activity', ?, 0)", [source, metric, agg]);
  await row("garmin", "activity_aerobicTrainingEffect", "sum"); // old guess
  await row("garmin", "activity_maxHeartRateInBeatsPerMinute", "avg"); // old guess
  await row("freddy", "activity_vo2Max", "sum"); // old guess
  await row("garmin", "activity_vo2Max", "last"); // the owner's choice
  await row("garmin", "daily_steps", "sum"); // right already
  await db.run("INSERT INTO app_settings (key, value, updated_at) VALUES ('freddy.transport', 'native', 0), ('sync.reminder', 'on', 0)");

  await migrate(db, all);
  const aggs = await db.all<{ source: string; metric: string; daily_agg: string }>("SELECT source, metric, daily_agg FROM metric_catalog ORDER BY source, metric");
  assert.deepEqual(aggs, [
    { source: "freddy", metric: "activity_vo2Max", daily_agg: "max" },
    { source: "garmin", metric: "activity_aerobicTrainingEffect", daily_agg: "max" },
    { source: "garmin", metric: "activity_maxHeartRateInBeatsPerMinute", daily_agg: "max" },
    { source: "garmin", metric: "activity_vo2Max", daily_agg: "last" },
    { source: "garmin", metric: "daily_steps", daily_agg: "sum" },
  ]);
  const settings = await db.all<{ key: string }>("SELECT key FROM app_settings ORDER BY key");
  assert.deepEqual(settings.map((s) => s.key), ["sync.reminder"], "the freddy transport setting is gone");
});

test("every override is fixed by migration 0010 (the two lists stay in step)", () => {
  const sql = realMigrations().find((m) => m.version === 10)!.sql;
  for (const metric of Object.keys(DAILY_AGG_OVERRIDES)) assert.match(sql, new RegExp(`metric = '${metric}'`), metric);
});

test("catalog refresh updates source facts but keeps the user's display choices", async () => {
  const { db } = await migratedDb();
  await upsertCatalog(db, "garmin", [{ metric: "daily_steps", firstDay: "2026-09-24", lastDay: "2026-10-24", records: 31 }], NOW);
  await db.run(
    "UPDATE metric_catalog SET label = 'Steps', pinned = 1, daily_agg = 'max', category = 'activity' WHERE metric = 'daily_steps'",
  );
  await upsertCatalog(db, "garmin", [{ metric: "daily_steps", firstDay: "2026-09-24", lastDay: "2026-10-25", records: 32 }], NOW + 1);
  const [r] = await db.all<Record<string, unknown>>("SELECT * FROM metric_catalog");
  assert.equal(r.label, "Steps");
  assert.equal(r.pinned, 1);
  assert.equal(r.daily_agg, "max");
  assert.equal(r.last_day, "2026-10-25");
  assert.equal(r.records, 32);
  assert.equal(r.updated_at, NOW + 1);
});
