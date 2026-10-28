import test from "node:test";
import assert from "node:assert/strict";
import { configureLogging, consoleSink, getLogLevel, recentLogs, setLogLevel, type LogRecord } from "../src/core/log";
import { memorySecretStore } from "../src/core/secretStore";
import { withTransaction } from "../src/db/tx";
import { exportBackup } from "../src/domain/backup/backup";
import { logFood, saveEntryAsMeal, setCalorieGoal } from "../src/domain/food/food";
import { addMove, DEFAULT_MEAL_PREP, logBatch, saveMealPrep } from "../src/domain/mealprep/mealPrep";
import { applyStoredLogLevel, loadLogLevel, saveLogLevel } from "../src/domain/settings/logLevel";
import { saveClaudeKey, saveGarminKey } from "../src/domain/settings/secrets";
import { migratedDb } from "./helpers";

const TZ = "Europe/Madrid";
const NOW = Date.UTC(2026, 9, 20, 10, 0, 0);

function capture(): LogRecord[] {
  const records: LogRecord[] = [];
  configureLogging({ threshold: "debug", scopes: {}, sinks: [(r) => records.push(r)] });
  return records;
}

test.afterEach(() => {
  configureLogging({ threshold: "silent", scopes: {}, sinks: [consoleSink, recentLogs.sink], now: () => Date.now() });
});

test("nested withTransaction joins the outer one, and an inner error rolls back everything", async () => {
  const { db } = await migratedDb();
  const calls: string[] = [];
  const spy = { ...db, exec: async (sql: string) => (calls.push(sql), db.exec(sql)) };
  await assert.rejects(
    withTransaction(spy, async () => {
      await spy.run("INSERT INTO app_settings (key, value, updated_at) VALUES ('a', '1', 0)");
      await withTransaction(spy, async () => {
        await spy.run("INSERT INTO app_settings (key, value, updated_at) VALUES ('b', '2', 0)");
        throw new Error("inner");
      });
    }),
    /inner/,
  );
  assert.deepEqual(calls, ["BEGIN", "ROLLBACK"]);
  assert.deepEqual(await db.all("SELECT key FROM app_settings WHERE key IN ('a','b')"), []);
  await withTransaction(spy, async () => withTransaction(spy, async () => spy.run("INSERT INTO app_settings (key, value, updated_at) VALUES ('c', '3', 0)")));
  assert.deepEqual(calls.slice(2), ["BEGIN", "COMMIT"]);
});

test("the log level is stored in settings and applied", async () => {
  const { db } = await migratedDb();
  capture();
  assert.equal(await loadLogLevel(db, "info"), "info");
  await saveLogLevel(db, "warn", NOW);
  assert.equal(getLogLevel(), "warn");
  setLogLevel("debug");
  assert.equal(await applyStoredLogLevel(db, "info"), "warn");
  assert.equal(getLogLevel(), "warn");
  await assert.rejects(saveLogLevel(db, "loud" as never), /Unknown/);
});

test("logs from real flows carry no health values, food names, notes, URLs or keys", async () => {
  const { db } = await migratedDb();
  const records = capture();
  const secrets = memorySecretStore();
  await saveGarminKey(secrets, "garmin-key-XYZ-0123456789");
  await saveClaudeKey(secrets, "sk-ant-ABCDEFGHIJKLMNOPQRSTUVWXYZ");
  const id = await logFood(db, {
    name: "Grandma's lasagne",
    meal: "dinner",
    calories: 1234.5,
    proteinG: 56.5,
    carbsG: null,
    fatG: null,
    notes: "felt bloated",
    atMs: NOW,
    timeZone: TZ,
  });
  await saveEntryAsMeal(db, id, { mime: "image/jpeg", dataB64: "/9j/4AAQ", width: 1, height: 1 }, NOW + 1);
  await setCalorieGoal(db, 2345, "2026-10-20", NOW + 2);
  const prep = await saveMealPrep(db, { ...DEFAULT_MEAL_PREP, name: "Secret chili", calories: 777.25, notes: "family recipe" }, NOW);
  const batch = await logBatch(db, { mealPrepId: prep, cookedAtMs: NOW, timeZone: TZ });
  await addMove(db, { batchId: batch, kind: "eat", portions: 1, atMs: NOW + 1000, timeZone: TZ });
  await exportBackup(db, "correct horse battery", { iterations: 1000, now: NOW });

  assert.ok(records.length >= 8, "the flows are logged");
  const text = JSON.stringify(records);
  for (const leak of ["lasagne", "1234.5", "56.5", "bloated", "Secret chili", "777.25", "family recipe", "garmin-key", "sk-ant", "/9j/"]) {
    assert.ok(!text.includes(leak), `log contains ${leak}`);
  }
  // Nutrition targets are the owner's settings, not readings; they are fine to log.
  assert.ok(records.some((r) => r.msg === "nutrition target set"));
});
