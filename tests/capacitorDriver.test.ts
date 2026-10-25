import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { capacitorDriver, type PluginConnection } from "../src/db/capacitorDriver";
import { migrate } from "../src/db/migrate";
import { loadCursor, saveSyncState, upsertSamples } from "../src/db/samples";
import type { SqlValue } from "../src/db/driver";
import { realMigrations } from "./helpers";

const NOW = 1_800_000_000_000;

/**
 * node:sqlite dressed up as the plugin's Android connection: execute() splits on ";\n",
 * strips "--" comments and runs each piece as ONE statement (like execSQL), and both
 * execute() and run() open their own transaction unless told not to.
 */
function fakePlugin(opts: { iosColumns?: boolean } = {}) {
  const raw = new DatabaseSync(":memory:");
  const calls: string[] = [];
  const firstStatement = (sql: string) => {
    const stmt = raw.prepare(sql); // prepare() rejects trailing statements, like execSQL ignores them
    stmt.run();
  };
  const wrap = async <T>(transaction: boolean | undefined, fn: () => T) => {
    if (transaction ?? true) raw.exec("BEGIN");
    try {
      const out = fn();
      if (transaction ?? true) raw.exec("COMMIT");
      return out;
    } catch (err) {
      if (transaction ?? true) raw.exec("ROLLBACK");
      throw err;
    }
  };
  const conn: PluginConnection = {
    async execute(statements, transaction) {
      calls.push(`execute:${transaction}`);
      return wrap(transaction, () => {
        for (const piece of statements.split(";\n")) {
          const sql = piece
            .split("\n")
            .map((l) => l.trim().replace(/--.*$/, ""))
            .filter(Boolean)
            .join(" ");
          if (sql) firstStatement(sql);
        }
        return { changes: { changes: 0 } };
      });
    },
    async run(statement, values, transaction) {
      calls.push(`run:${transaction}`);
      return wrap(transaction, () => {
        raw.prepare(statement).run(...((values ?? []) as SqlValue[]));
        return { changes: { changes: 1 } };
      });
    },
    async query(statement, values) {
      const rows = raw.prepare(statement).all(...((values ?? []) as SqlValue[])).map((r) => ({ ...r }));
      return { values: opts.iosColumns ? [{ ios_columns: Object.keys(rows[0] ?? {}) }, ...rows] : rows };
    },
    async beginTransaction() {
      calls.push("begin");
      raw.exec("BEGIN");
      return { changes: { changes: 0 } };
    },
    async commitTransaction() {
      calls.push("commit");
      raw.exec("COMMIT");
      return { changes: { changes: 0 } };
    },
    async rollbackTransaction() {
      calls.push("rollback");
      raw.exec("ROLLBACK");
      return { changes: { changes: 0 } };
    },
  };
  return { conn, raw, calls };
}

const tables = (raw: DatabaseSync) =>
  raw
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all()
    .map((r) => r.name);

test("real migrations apply through the plugin driver, using plugin transactions", async () => {
  const { conn, raw, calls } = fakePlugin();
  const db = capacitorDriver(conn);
  const applied = await migrate(db, realMigrations());
  assert.deepEqual(applied, [1]);
  assert.deepEqual(tables(raw), ["app_settings", "drink_entries", "food_entries", "health_samples", "sync_state"]);
  assert.deepEqual(calls, ["begin", "execute:false", "execute:false", "commit"]);
  assert.deepEqual(await migrate(db, realMigrations()), []);
});

test("CRLF migration files still create every table", async () => {
  const { conn, raw } = fakePlugin();
  const crlf = realMigrations().map((m) => ({ ...m, sql: m.sql.replace(/\n/g, "\r\n") }));
  await migrate(capacitorDriver(conn), crlf);
  assert.equal(tables(raw).length, 5);
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
