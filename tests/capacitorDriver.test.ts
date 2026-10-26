import test from "node:test";
import assert from "node:assert/strict";
import type { DatabaseSync } from "node:sqlite";
import { capacitorDriver } from "../src/db/capacitorDriver";
import { migrate } from "../src/db/migrate";
import { loadCursor, saveSyncState, upsertSamples } from "../src/db/samples";
import { fakePlugin } from "./fakePlugin";
import { realMigrations } from "./helpers";

const NOW = 1_800_000_000_000;

const tables = (raw: DatabaseSync) =>
  raw
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all()
    .map((r) => r.name);

test("real migrations apply through the plugin driver, using plugin transactions", async () => {
  const { conn, raw, calls } = fakePlugin();
  const db = capacitorDriver(conn);
  const applied = await migrate(db, realMigrations());
  assert.deepEqual(applied, [1, 2, 3, 4, 5]);
  assert.deepEqual(tables(raw), ["agent_actions", "ai_disclosures", "app_settings", "chat_conversations", "chat_messages", "consents", "day_notes", "drink_entries", "food_entries", "food_photos", "goals", "health_samples", "manual_measurements", "meal_prep_batches", "meal_prep_ingredients", "meal_prep_moves", "meal_prep_tags", "meal_preps", "metric_catalog", "saved_meals", "shopping_list_items", "sync_runs", "sync_state"]);
  assert.deepEqual(calls, Array(5).fill(["begin", "execute:false", "execute:false", "commit"]).flat());
  assert.deepEqual(await migrate(db, realMigrations()), []);
});

test("CRLF migration files still create every table", async () => {
  const { conn, raw } = fakePlugin();
  const crlf = realMigrations().map((m) => ({ ...m, sql: m.sql.replace(/\n/g, "\r\n") }));
  await migrate(capacitorDriver(conn), crlf);
  assert.equal(tables(raw).length, 23);
});

test("a failing migration rolls back via the plugin", async () => {
  const { conn, raw, calls } = fakePlugin();
  const bad = [{ version: 1, name: "bad", sql: "CREATE TABLE a (x);\nNOT SQL;\n" }];
  await assert.rejects(migrate(capacitorDriver(conn), bad), /Migration 1_bad failed/);
  assert.equal(calls.at(-1), "rollback");
  assert.deepEqual(tables(raw), []);
});

test("upserts and sync state work end to end, with iOS column headers stripped", async () => {
  const { conn } = fakePlugin({ iosColumns: true });
  const db = capacitorDriver(conn);
  await migrate(db, realMigrations());
  const sample = {
    source: "freddy:GARMIN",
    device: "fr245",
    externalId: "2026-10-24",
    metric: "steps_total",
    startMs: NOW,
    offsetMin: 120,
    valueNum: 9000,
  };
  await upsertSamples(db, [sample, { ...sample, valueNum: 9100 }], NOW);
  const rows = await db.all<{ value_num: number }>("SELECT value_num FROM health_samples");
  assert.deepEqual(rows, [{ value_num: 9100 }]);
  await saveSyncState(db, "freddy:GARMIN", "c1", NOW);
  assert.equal(await loadCursor(db, "freddy:GARMIN"), "c1");
  assert.equal(await loadCursor(db, "nope"), null);
});
