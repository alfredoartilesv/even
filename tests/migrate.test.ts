import test from "node:test";
import assert from "node:assert/strict";
import { migrate, parseMigrations } from "../src/db/migrate";
import { memoryDriver, realMigrations } from "./helpers";

const NOW = 1_800_000_000_000;

test("real migrations apply cleanly and set user_version", async () => {
  const { db } = memoryDriver();
  const migrations = realMigrations();
  const applied = await migrate(db, migrations);
  assert.deepEqual(applied, migrations.map((m) => m.version));
  const [{ user_version }] = await db.all<{ user_version: number }>("PRAGMA user_version");
  assert.equal(user_version, migrations.at(-1)!.version);
});

test("running twice is a no-op", async () => {
  const { db } = memoryDriver();
  const migrations = realMigrations();
  await migrate(db, migrations);
  assert.deepEqual(await migrate(db, migrations), []);
});

test("expected tables exist", async () => {
  const { db } = memoryDriver();
  await migrate(db, realMigrations());
  const rows = await db.all<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  );
  assert.deepEqual(
    rows.map((r) => r.name),
    ["account", "agent_actions", "ai_disclosures", "app_settings", "chat_conversations", "chat_messages", "consents", "day_notes", "drink_entries", "drink_types", "food_entries", "food_photos", "goals", "health_samples", "manual_measurements", "meal_prep_batches", "meal_prep_ingredients", "meal_prep_moves", "meal_prep_tags", "meal_preps", "metric_catalog", "saved_meals", "shopping_list_items", "sync_runs", "sync_state"],
  );
});

test("health_samples re-sync is idempotent via unique key", async () => {
  const { db, raw } = memoryDriver();
  await migrate(db, realMigrations());
  const insert = `INSERT INTO health_samples
    (id, source, device, external_id, metric, start_ms, value_num, created_at, updated_at)
    VALUES (?, 'freddy', 'Forerunner 245', '2026-10-24', 'daily_steps', ?, 10806, ?, ?)`;
  await db.run(insert, ["a", NOW, NOW, NOW]);
  assert.throws(() => raw.prepare(insert).run("b", NOW, NOW, NOW), /UNIQUE/);
  // The adapter upserts instead:
  await db.run(
    `INSERT INTO health_samples (id, source, device, external_id, metric, start_ms, value_num, created_at, updated_at)
     VALUES ('c', 'freddy', 'Forerunner 245', '2026-10-24', 'daily_steps', ?, 11000, ?, ?)
     ON CONFLICT (source, device, metric, external_id) DO UPDATE SET value_num = excluded.value_num, updated_at = excluded.updated_at`,
    [NOW, NOW, NOW + 1],
  );
  const rows = await db.all<{ id: string; value_num: number }>("SELECT id, value_num FROM health_samples");
  assert.deepEqual(rows, [{ id: "a", value_num: 11000 }]);
});

test("food meal CHECK constraint rejects unknown meal", async () => {
  const { db } = memoryDriver();
  await migrate(db, realMigrations());
  await assert.rejects(
    db.run(
      `INSERT INTO food_entries (id, eaten_at_ms, name, meal, created_at, updated_at, origin_device_id)
       VALUES ('x', ?, 'toast', 'brunch', ?, ?, 'dev')`,
      [NOW, NOW, NOW],
    ),
    /CHECK/,
  );
});

test("a failing migration rolls back and leaves the previous version", async () => {
  const { db } = memoryDriver();
  const good = { version: 1, name: "ok", sql: "CREATE TABLE t (id TEXT);" };
  const bad = { version: 2, name: "boom", sql: "CREATE TABLE u (id TEXT); CREATE TABLE t (id TEXT);" };
  await assert.rejects(migrate(db, [good, bad]), /Migration 2_boom failed/);
  const [{ user_version }] = await db.all<{ user_version: number }>("PRAGMA user_version");
  assert.equal(user_version, 1);
  const tables = await db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE name = 'u'");
  assert.equal(tables.length, 0, "table u must be rolled back");
});

test("parseMigrations validates names and sorts", () => {
  const sorted = parseMigrations({ "./m/0002_b.sql": "", "./m/0001_a.sql": "" });
  assert.deepEqual(sorted.map((m) => m.version), [1, 2]);
  assert.throws(() => parseMigrations({ "./m/init.sql": "" }), /Bad migration file name/);
  assert.throws(() => parseMigrations({ "./a/0001_a.sql": "", "./b/0001_b.sql": "" }), /Duplicate/);
});
