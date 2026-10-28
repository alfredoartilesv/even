import test from "node:test";
import assert from "node:assert/strict";
import { TOOLS_BY_NAME } from "../src/domain/chat/tools";
import { upsertCatalog } from "../src/domain/metrics/catalog";
import { upsertSamples } from "../src/domain/metrics/samples";
import { localDayStart } from "../src/core/tz";
import { migratedDb } from "./helpers";

const NOW = 1_800_000_000_000;

async function setup() {
  const { db } = await migratedDb();
  const sample = (day: string, metric: string, value: number, n = 0, device = "Garmin") => {
    const s = localDayStart(day, "Europe/Madrid");
    return { source: "garmin", device, externalId: `${day}#${n}`, metric, startMs: s.startMs, offsetMin: s.offsetMin, valueNum: value };
  };
  await upsertSamples(
    db,
    [
      sample("2026-10-12", "daily_steps", 6000),
      sample("2026-10-13", "daily_steps", 8000),
      sample("2026-10-19", "daily_steps", 10000),
      sample("2026-10-20", "daily_steps", 12000),
      sample("2026-10-24", "body_weightInGrams", 87000, 0),
      sample("2026-10-24", "body_weightInGrams", 86500, 1),
    ],
    NOW,
  );
  await upsertCatalog(
    db,
    "garmin",
    [
      { metric: "daily_steps", records: 4 },
      { metric: "body_weightInGrams", unit: "grams" },
    ],
    NOW,
  );
  const food = `INSERT INTO food_entries (id, eaten_at_ms, offset_min, local_day, name, calories, protein_g, created_at, updated_at, origin_device_id)
                VALUES (?, 0, 120, ?, 'x', ?, ?, ?, ?, 'dev')`;
  await db.run(food, ["f1", "2026-10-19", 2000, 100, NOW, NOW]);
  await db.run(food, ["f2", "2026-10-20", 2400, 140, NOW, NOW]);
  await db.run(
    `INSERT INTO drink_entries (id, drunk_at_ms, offset_min, local_day, name, volume_ml, abv_percent, created_at, updated_at, origin_device_id)
     VALUES ('d1', 0, 120, '2026-10-19', 'beer', 500, 5, ?, ?, 'dev')`,
    [NOW, NOW],
  );
  const manual = `INSERT INTO manual_measurements (id, measured_at_ms, offset_min, local_day, kind, value_num, value_num2, unit, created_at, updated_at, origin_device_id)
                  VALUES (?, 0, 120, ?, 'blood_pressure', ?, ?, 'mmHg', ?, ?, 'dev')`;
  await db.run(manual, ["m1", "2026-10-19", 120, 80, NOW, NOW]);
  await db.run(manual, ["m2", "2026-10-20", 130, 84, NOW, NOW]);
  await db.run(
    `INSERT INTO goals (id, title, target_kind, metric, comparator, target_num, period, start_day, created_at, updated_at, origin_device_id)
     VALUES ('g1', '10k steps', 'sample', 'daily_steps', '>=', 10000, 'day', '2026-10-01', ?, ?, 'dev')`,
    [NOW, NOW],
  );
  return db;
}

const run = async (name: string, input: unknown = {}) => {
  const d = await setup();
  return (await TOOLS_BY_NAME.get(name)!.run(d, input)).result as Record<string, any>;
};

test("list_metrics shows local coverage, manual kinds and log days", async () => {
  const r = await run("list_metrics");
  const steps = r.metrics.find((m: any) => m.metric === "daily_steps");
  assert.equal(steps.days, 4);
  assert.equal(steps.first_day, "2026-10-12");
  assert.equal(steps.daily_agg, "sum");
  assert.equal(steps.category, "activity");
  assert.deepEqual(
    r.manual_kinds.map((k: any) => [k.kind, k.entries]),
    [["blood_pressure", 2]],
  );
  assert.equal(r.food_log_days, 2);
  assert.equal(r.drink_log_days, 1);
});

test("metric_summary follows daily_agg: two weigh-ins on one day count once, as the last", async () => {
  const r = await run("metric_summary", { metric: "body_weightInGrams", from: "2026-10-01", to: "2026-10-31" });
  assert.equal(r.series[0].days_with_data, 1);
  assert.equal(r.series[0].avg, 86500);
  assert.equal(r.series[0].unit, "grams");
});

test("compare_periods gives both summaries and the change", async () => {
  const r = await run("compare_periods", {
    metric: "daily_steps",
    a_from: "2026-10-12",
    a_to: "2026-10-18",
    b_from: "2026-10-19",
    b_to: "2026-10-25",
  });
  const c = r.comparison[0];
  assert.equal(c.period_a.avg, 7000);
  assert.equal(c.period_b.avg, 11000);
  assert.equal(c.avg_change_b_minus_a, 4000);
  assert.equal(c.avg_change_percent, 57.14);
});

test("nutrition, manual measurements and goals summaries", async () => {
  const n = await run("nutrition_summary", { from: "2026-10-19", to: "2026-10-25" });
  assert.equal(n.food.days_logged, 2);
  assert.equal(n.food.avg_calories, 2200);
  assert.equal(n.alcohol.drinking_days, 1);
  assert.equal(n.alcohol.alcohol_g_total, 19.73);
  assert.equal(n.alcohol.alcohol_g_per_calendar_day, 2.82);

  const m = await run("manual_summary", { kind: "blood_pressure", from: "2026-10-01", to: "2026-10-31" });
  assert.equal(m.entries, 2);
  assert.equal(m.avg, 125);
  assert.equal(m.avg2, 82);

  const g = await run("list_goals");
  assert.equal(g.goals[0].title, "10k steps");
});

test("daily_series returns one point per day; limits protect against huge ranges", async () => {
  const r = await run("daily_series", { metric: "daily_steps", from: "2026-10-01", to: "2026-10-31" });
  assert.deepEqual(
    r.series[0].points.map((p: any) => p.value),
    [6000, 8000, 10000, 12000],
  );
  const d = await setup();
  await assert.rejects(TOOLS_BY_NAME.get("daily_series")!.run(d, { metric: "daily_steps", from: "2024-01-01", to: "2026-01-01" }), /limited to 400 days/);
  await assert.rejects(TOOLS_BY_NAME.get("metric_summary")!.run(d, { metric: "daily_steps", from: "2026-1-1", to: "2026-10-01" }), /YYYY-MM-DD/);
});
