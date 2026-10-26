import test from "node:test";
import assert from "node:assert/strict";
import { classifyMetric, upsertCatalog } from "../src/features/metrics/catalog";
import { FreddySource, type ToolCaller } from "../src/features/sync/freddy";
import { LIST_METRICS, QUERY_METRICS } from "./fixtures";
import { migratedDb } from "./helpers";

const NOW = 1_800_000_000_000;

test("classifyMetric guesses category and daily aggregation from the name", () => {
  assert.deepEqual(classifyMetric("daily_steps"), { category: "activity", dailyAgg: "sum" });
  assert.deepEqual(classifyMetric("sleep_durationInSeconds"), { category: "sleep", dailyAgg: "last" });
  assert.deepEqual(classifyMetric("daily_averageHeartRateInBeatsPerMinute"), { category: "heart", dailyAgg: "avg" });
  assert.deepEqual(classifyMetric("daily_stressQualifier"), { category: "stress", dailyAgg: "avg" });
  assert.deepEqual(classifyMetric("body_weightInGrams"), { category: "body", dailyAgg: "last" });
  assert.deepEqual(classifyMetric("something_new"), { category: "other", dailyAgg: "avg" });
});

test("FreddySource returns the catalog it discovered with list_metrics", async () => {
  const caller: ToolCaller = { callTool: async (n) => (n === "list_metrics" ? LIST_METRICS : QUERY_METRICS) };
  const res = await new FreddySource({ caller, now: () => Date.UTC(2026, 9, 25, 18) }).fetchSince(null);
  const steps = res.catalog!.find((c) => c.metric === "daily_steps");
  assert.deepEqual(steps, { metric: "daily_steps", unit: undefined, device: undefined, firstDay: "2026-09-24", lastDay: "2026-10-25", records: 32 });
  assert.equal(res.catalog!.length, 6); // all listed metrics, even the ones not mirrored

  const explicit = await new FreddySource({ caller, metrics: ["daily_steps"], now: () => NOW }).fetchSince(null);
  assert.equal(explicit.catalog, undefined);
});

test("catalog refresh updates source facts but keeps the user's display choices", async () => {
  const { db } = await migratedDb();
  await upsertCatalog(db, "freddy", [{ metric: "daily_steps", firstDay: "2026-09-24", lastDay: "2026-10-24", records: 31 }], NOW);
  await db.run(
    "UPDATE metric_catalog SET label = 'Steps', pinned = 1, daily_agg = 'max', category = 'activity' WHERE metric = 'daily_steps'",
  );
  await upsertCatalog(db, "freddy", [{ metric: "daily_steps", firstDay: "2026-09-24", lastDay: "2026-10-25", records: 32 }], NOW + 1);
  const [r] = await db.all<Record<string, unknown>>("SELECT * FROM metric_catalog");
  assert.equal(r.label, "Steps");
  assert.equal(r.pinned, 1);
  assert.equal(r.daily_agg, "max");
  assert.equal(r.last_day, "2026-10-25");
  assert.equal(r.records, 32);
  assert.equal(r.updated_at, NOW + 1);
});
