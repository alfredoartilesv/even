import test from "node:test";
import assert from "node:assert/strict";
import { configureLogging, consoleSink, createLogger, recentLogs, type LogRecord } from "../src/core/log";
import { withTransaction } from "../src/db/tx";
import { exportBackup } from "../src/domain/backup/backup";
import { SYNC_TABLES } from "../src/domain/cloudsync/cloudSync";
import { clearLogs, KEEP_RECORDS, loadLogs, persistLogs } from "../src/domain/logs/store";
import { rememberAdmin, wasAdmin } from "../src/domain/settings/adminFlag";
import { migratedDb } from "./helpers";

const log = createLogger("test.store");
const tick = () => new Promise((r) => setTimeout(r, 5));

test.beforeEach(() => configureLogging({ threshold: "debug", scopes: {}, sinks: [], now: () => Date.now() }));
test.afterEach(() => configureLogging({ threshold: "silent", scopes: {}, sinks: [consoleSink, recentLogs.sink], now: () => Date.now() }));

test("every record is in the database right after it is logged, start-up records first, sanitized", async () => {
  const { db } = await migratedDb();
  const earlier: LogRecord = { ts: 1, level: "info", scope: "app", msg: "app starting" };
  const stored = persistLogs(db, { earlier: [earlier] });
  log.info("sync finished", { samples: 10, apiKey: "secret-value" });
  log.error("sync failed", { err: new Error("boom") });
  await tick();
  await stored.flush();
  const rows = await loadLogs(db);
  assert.deepEqual(
    rows.map((r) => r.msg),
    ["app starting", "sync finished", "sync failed"],
  );
  assert.deepEqual(rows[1].fields, { samples: 10, apiKey: "[redacted]" });
  assert.deepEqual(rows[2].fields, { err: { name: "Error", message: "boom" } });
  stored.stop();
});

test("a second attach to the same database stores each record once", async () => {
  const { db } = await migratedDb();
  const a = persistLogs(db);
  const b = persistLogs(db);
  assert.equal(a, b);
  log.info("once");
  await tick();
  await a.flush();
  assert.equal((await loadLogs(db)).length, 1);
  a.stop();
});

test("records logged inside a transaction that rolls back are still kept", async () => {
  const { db } = await migratedDb();
  const stored = persistLogs(db, { retryMs: 1 });
  await assert.rejects(
    withTransaction(db, async () => {
      log.error("import failed half way");
      await tick();
      await stored.flush();
      throw new Error("roll back");
    }),
  );
  await tick();
  await stored.flush();
  assert.deepEqual(
    (await loadLogs(db)).map((r) => r.msg),
    ["import failed half way", "transaction rolled back"],
  );
  stored.stop();
});

test("the web database's own save records are not stored, so saving does not loop", async () => {
  const { db } = await migratedDb();
  const stored = persistLogs(db);
  createLogger("db.web").debug("database saved", { bytes: 10 });
  createLogger("db.web").warn("saved database could not be opened, starting empty");
  await tick();
  await stored.flush();
  assert.deepEqual(
    (await loadLogs(db)).map((r) => r.msg),
    ["saved database could not be opened, starting empty"],
  );
  stored.stop();
});

test("only the newest records are kept, and clear removes them all", async () => {
  const { db } = await migratedDb();
  const stored = persistLogs(db);
  for (let i = 0; i < KEEP_RECORDS + 300; i++) log.debug("step", { i });
  await tick();
  await stored.flush();
  const rows = await loadLogs(db, KEEP_RECORDS + 1000);
  assert.ok(rows.length <= KEEP_RECORDS + 200, `${rows.length}`);
  assert.equal(rows.at(-1)?.fields?.i, KEEP_RECORDS + 299);
  stored.stop();
  assert.equal(await clearLogs(db), rows.length);
  assert.deepEqual(await loadLogs(db), []);
});

test("stored logs stay on this install: not synced and not in a backup", async () => {
  const { db } = await migratedDb();
  const stored = persistLogs(db);
  log.info("kept here");
  await tick();
  await stored.flush();
  stored.stop();
  assert.ok(!SYNC_TABLES.some((t) => t.name === "log_records"));
  const { rows } = await exportBackup(db, "correct horse battery staple", { iterations: 1000 });
  assert.ok(!("log_records" in rows));
});

test("the admin flag is remembered per account and cleared when the server says no", async () => {
  const { db } = await migratedDb();
  assert.equal(await wasAdmin(db, "acc-1"), false);
  await rememberAdmin(db, "acc-1", true);
  assert.equal(await wasAdmin(db, "acc-1"), true);
  assert.equal(await wasAdmin(db, "acc-2"), false);
  await rememberAdmin(db, "acc-1", false);
  assert.equal(await wasAdmin(db, "acc-1"), false);
});
