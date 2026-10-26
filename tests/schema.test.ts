import test from "node:test";
import assert from "node:assert/strict";
import { migrate } from "../src/db/migrate";
import { dayValues, latestSampleDay } from "../src/features/metrics/queries";
import { sampleLocalDay, upsertSamples } from "../src/features/metrics/samples";
import type { SampleInput } from "../src/features/sync/types";
import { memoryDriver, migratedDb, realMigrations } from "./helpers";

const NOW = 1_800_000_000_000;
// 2026-10-24 00:00 in Madrid (+02:00) = 2026-10-23T22:00Z
const DAY_START = Date.UTC(2026, 9, 23, 22, 0, 0);

function sample(over: Partial<SampleInput> = {}): SampleInput {
  return {
    source: "garmin",
    device: "Garmin",
    externalId: "2026-10-24#0",
    metric: "daily_steps",
    startMs: DAY_START,
    offsetMin: 120,
    valueNum: 10000,
    ...over,
  };
}

test("0002 backfills local_day on rows written before it, in the row's own zone", async () => {
  const { db } = memoryDriver();
  const [m1, m2] = realMigrations();
  await migrate(db, [m1]);
  await db.run(
    `INSERT INTO health_samples (id, source, device, external_id, metric, start_ms, offset_min, value_num, created_at, updated_at)
     VALUES ('a', 'garmin', 'Garmin', '2026-10-24#0', 'daily_steps', ?, 120, 1, ?, ?)`,
    [DAY_START, NOW, NOW],
  );
  await db.run(
    `INSERT INTO food_entries (id, eaten_at_ms, offset_min, name, created_at, updated_at, origin_device_id)
     VALUES ('f', ?, 120, 'toast', ?, ?, 'dev')`,
    [DAY_START + 30 * 60_000, NOW, NOW],
  );
  await migrate(db, [m1, m2]);
  const [s] = await db.all<{ local_day: string }>("SELECT local_day FROM health_samples");
  const [f] = await db.all<{ local_day: string }>("SELECT local_day FROM food_entries");
  assert.equal(s.local_day, "2026-10-24"); // UTC date would be 2026-10-23
  assert.equal(f.local_day, "2026-10-24");
});

test("upsert writes local_day with the same rule as the backfill", async () => {
  const { db } = await migratedDb();
  await upsertSamples(db, [sample()], NOW);
  const [r] = await db.all<{ local_day: string }>("SELECT local_day FROM health_samples");
  assert.equal(r.local_day, "2026-10-24");
  assert.equal(sampleLocalDay({ startMs: DAY_START, offsetMin: 120 }), "2026-10-24");
});

test("daily_metric_values offers every aggregate, flags partial days, and dayValues picks per catalog", async () => {
  const { db } = await migratedDb();
  await upsertSamples(
    db,
    [
      sample({ metric: "body_weightInGrams", externalId: "2026-10-24#0", valueNum: 87000, unit: "grams" }),
      sample({ metric: "body_weightInGrams", externalId: "2026-10-24#1", valueNum: 86500, unit: "grams" }),
      sample({ externalId: "2026-10-24#0", valueNum: 9000, raw: { partial: true } }),
    ],
    NOW,
  );
  const rows = await db.all<Record<string, number | string>>(
    "SELECT * FROM daily_metric_values WHERE metric = 'body_weightInGrams'",
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].readings, 2);
  assert.equal(rows[0].avg_num, 86750);
  assert.equal(rows[0].min_num, 86500);
  assert.equal(rows[0].last_num, 86500);
  assert.equal(rows[0].partial, 0);

  await db.run(
    `INSERT INTO metric_catalog (source, metric, label, category, daily_agg, pinned, updated_at)
     VALUES ('garmin', 'body_weightInGrams', 'Weight', 'body', 'min', 1, ?)`,
    [NOW],
  );
  assert.equal(await latestSampleDay(db), "2026-10-24");
  const values = await dayValues(db, "2026-10-24");
  assert.deepEqual(
    values.map((v) => [v.label, v.value, v.partial]),
    [
      ["Weight", 86500, false], // pinned first, aggregated with "min"
      ["daily_steps", 9000, true], // no catalog row: avg, and the day was not over
    ],
  );
});

test("daily nutrition and alcohol views total the live entries per day", async () => {
  const { db } = await migratedDb();
  const food = `INSERT INTO food_entries (id, eaten_at_ms, offset_min, local_day, name, calories, protein_g, deleted_at, created_at, updated_at, origin_device_id)
                VALUES (?, ?, 120, '2026-10-24', ?, ?, ?, ?, ?, ?, 'dev')`;
  await db.run(food, ["f1", DAY_START, "eggs", 300, 20, null, NOW, NOW]);
  await db.run(food, ["f2", DAY_START, "rice", 400, 8, null, NOW, NOW]);
  await db.run(food, ["f3", DAY_START, "deleted", 999, 99, NOW, NOW, NOW]);
  await db.run(
    `INSERT INTO drink_entries (id, drunk_at_ms, offset_min, local_day, name, volume_ml, abv_percent, created_at, updated_at, origin_device_id)
     VALUES ('d1', ?, 120, '2026-10-24', 'beer', 330, 5, ?, ?, 'dev')`,
    [DAY_START, NOW, NOW],
  );
  const [n] = await db.all<Record<string, number>>("SELECT entries, calories, protein_g FROM daily_nutrition");
  assert.deepEqual(n, { entries: 2, calories: 700, protein_g: 28 });
  const [a] = await db.all<{ alcohol_g: number }>("SELECT alcohol_g FROM daily_alcohol");
  assert.equal(Math.round(a.alcohol_g * 10) / 10, 13); // 330 ml * 5% * 0.789 g/ml
});

test("constraints: one live day note per day, goals need a target unless free-text", async () => {
  const { db } = await migratedDb();
  const note = `INSERT INTO day_notes (id, local_day, mood, body, deleted_at, created_at, updated_at, origin_device_id)
                VALUES (?, '2026-10-24', 4, '', ?, ?, ?, 'dev')`;
  await db.run(note, ["n1", NOW, NOW, NOW]); // soft-deleted
  await db.run(note, ["n2", null, NOW, NOW]);
  await assert.rejects(db.run(note, ["n3", null, NOW, NOW]), /UNIQUE/);
  await assert.rejects(
    db.run(`INSERT INTO day_notes (id, local_day, mood, created_at, updated_at, origin_device_id) VALUES ('n4', '2026-10-25', 6, ?, ?, 'dev')`, [NOW, NOW]),
    /CHECK/,
  );

  const goal = `INSERT INTO goals (id, title, target_kind, metric, comparator, target_num, start_day, created_at, updated_at, origin_device_id)
                VALUES (?, ?, ?, ?, ?, ?, '2026-10-24', ?, ?, 'dev')`;
  await db.run(goal, ["g1", "10k steps", "sample", "daily_steps", ">=", 10000, NOW, NOW]);
  await db.run(goal, ["g2", "Sleep better", "none", null, null, null, NOW, NOW]);
  await assert.rejects(db.run(goal, ["g3", "Broken", "sample", "daily_steps", null, null, NOW, NOW]), /CHECK/);
});

test("chat messages need an existing conversation (foreign keys on)", async () => {
  const { db } = await migratedDb();
  await db.exec("PRAGMA foreign_keys = ON"); // the Capacitor plugin turns this on when it opens the DB
  const msg = `INSERT INTO chat_messages (id, conversation_id, seq, role, content_json, created_at, updated_at, origin_device_id)
               VALUES (?, ?, ?, 'user', '[]', ?, ?, 'dev')`;
  await assert.rejects(db.run(msg, ["m1", "nope", 0, NOW, NOW]), /FOREIGN KEY/);
  await db.run(
    "INSERT INTO chat_conversations (id, created_at, updated_at, origin_device_id) VALUES ('c1', ?, ?, 'dev')",
    [NOW, NOW],
  );
  await db.run(msg, ["m1", "c1", 0, NOW, NOW]);
  await assert.rejects(db.run(msg, ["m2", "c1", 0, NOW, NOW]), /UNIQUE/);
});
