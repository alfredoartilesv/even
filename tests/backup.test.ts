import test from "node:test";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { BACKUP_TABLES, BackupError, exportBackup, restoreBackup } from "../src/features/backup/backup";
import { deviceId, getSetting, setSetting } from "../src/db/settings";
import { upsertSamples } from "../src/features/metrics/samples";
import { migrate } from "../src/db/migrate";
import { capacitorDriver } from "../src/platform/sqlite";
import { fakePlugin } from "./fakePlugin";
import { memoryDriver, migratedDb, realMigrations } from "./helpers";

const NOW = 1_800_000_000_000;
const PW = "correct horse battery";
const FAST = { iterations: 1000, now: NOW }; // real exports use 600k; speed only matters in tests

async function seeded() {
  const { db, raw } = await migratedDb();
  await deviceId(db, NOW);
  await setSetting(db, "sync.reminder", "off", NOW);
  await upsertSamples(
    db,
    [{ source: "garmin", device: "Garmin", externalId: "2026-10-24#0", metric: "daily_steps", startMs: NOW, offsetMin: 120, valueNum: 10000 }],
    NOW,
  );
  await db.run(
    `INSERT INTO food_entries (id, eaten_at_ms, offset_min, local_day, name, notes, created_at, updated_at, origin_device_id)
     VALUES ('f1', ?, 120, '2026-10-24', 'eggs', 'it''s fine -- really; ok', ?, ?, 'dev-a')`,
    [NOW, NOW, NOW],
  );
  await db.run("INSERT INTO chat_conversations (id, title, created_at, updated_at, origin_device_id) VALUES ('c1', 'Sleep', ?, ?, 'dev-a')", [NOW, NOW]);
  await db.run(
    `INSERT INTO chat_messages (id, conversation_id, seq, role, content_json, created_at, updated_at, origin_device_id)
     VALUES ('m1', 'c1', 0, 'user', '[{"type":"text","text":"How did I sleep?"}]', ?, ?, 'dev-a')`,
    [NOW, NOW],
  );
  return { db, raw };
}

test("BACKUP_TABLES covers every table in the schema", async () => {
  const { db } = await migratedDb();
  const rows = await db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'");
  assert.deepEqual(rows.map((r) => r.name).sort(), BACKUP_TABLES.map((t) => t.name).sort());
});

test("round trip into an empty install restores everything except the device id", async () => {
  const { db } = await seeded();
  const { text, rows } = await exportBackup(db, PW, FAST);
  assert.equal(rows.health_samples, 1);
  assert.ok(!text.includes("eggs"), "file must not contain plaintext");

  const { db: fresh } = await migratedDb();
  const freshId = await deviceId(fresh, NOW + 5);
  const report = await restoreBackup(fresh, text, PW);
  assert.equal(report.exportedAt, NOW);
  assert.equal(report.rows.food_entries, 1);

  const [food] = await fresh.all<{ notes: string }>("SELECT notes FROM food_entries WHERE id = 'f1'");
  assert.equal(food.notes, "it's fine -- really; ok");
  const [msg] = await fresh.all<{ content_json: string }>("SELECT content_json FROM chat_messages");
  assert.match(msg.content_json, /How did I sleep/);
  assert.equal((await fresh.all("SELECT * FROM health_samples")).length, 1);
  assert.equal(await getSetting(fresh, "sync.reminder"), "off");
  assert.equal(await deviceId(fresh), freshId);
});

test("restore is a merge: newer local rows win, older local rows are updated, re-restore is a no-op", async () => {
  const { db } = await seeded();
  const { text } = await exportBackup(db, PW, FAST);

  await db.run("UPDATE food_entries SET name = 'eggs (edited later)', updated_at = ? WHERE id = 'f1'", [NOW + 10]);
  await db.run("UPDATE chat_conversations SET title = 'old', updated_at = ? WHERE id = 'c1'", [NOW - 10]);
  await restoreBackup(db, text, PW);
  await restoreBackup(db, text, PW);

  const [f] = await db.all<{ name: string }>("SELECT name FROM food_entries");
  assert.equal(f.name, "eggs (edited later)");
  const [c] = await db.all<{ title: string }>("SELECT title FROM chat_conversations");
  assert.equal(c.title, "Sleep");
  assert.equal((await db.all("SELECT * FROM health_samples")).length, 1);
});

test("wrong password, edited header or edited data are all rejected without touching the DB", async () => {
  const { db } = await seeded();
  const { text } = await exportBackup(db, PW, FAST);
  const { db: fresh } = await migratedDb();

  await assert.rejects(restoreBackup(fresh, text, "not the password"), /Wrong password/);
  const env = JSON.parse(text);
  await assert.rejects(restoreBackup(fresh, JSON.stringify({ ...env, kdf: { ...env.kdf, iterations: 1001 } }), PW), /Wrong password/);
  const flipped = env.data[10] === "A" ? "B" : "A";
  await assert.rejects(restoreBackup(fresh, JSON.stringify({ ...env, data: env.data.slice(0, 10) + flipped + env.data.slice(11) }), PW), BackupError);
  await assert.rejects(restoreBackup(fresh, "{}", PW), /not an Even backup/);
  await assert.rejects(restoreBackup(fresh, "not json", PW), /not an Even backup/);
  assert.equal((await fresh.all("SELECT * FROM food_entries")).length, 0);
});

test("a backup from a newer schema is refused, an older one restores into the new schema", async () => {
  const { db } = await seeded();
  const { text } = await exportBackup(db, PW, FAST);

  const { db: old } = memoryDriver();
  await migrate(old, realMigrations().slice(0, 1));
  await assert.rejects(restoreBackup(old, text, PW), /newer app/);

  const { db: v1 } = memoryDriver();
  await migrate(v1, realMigrations().slice(0, 1));
  await v1.run(
    `INSERT INTO food_entries (id, eaten_at_ms, offset_min, name, created_at, updated_at, origin_device_id)
     VALUES ('old', ?, 0, 'toast', ?, ?, 'dev')`,
    [NOW, NOW, NOW],
  );
  const oldFile = (await exportBackup(v1, PW, FAST)).text;
  const { db: current } = await migratedDb();
  const report = await restoreBackup(current, oldFile, PW);
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.rows.food_entries, 1);
  assert.equal(report.rows.goals, undefined); // table did not exist in schema 1
});

test("a failure midway rolls the whole restore back", async () => {
  const { db } = await seeded();
  const { text } = await exportBackup(db, PW, FAST);
  const { db: fresh } = await migratedDb();
  // day_notes is restored after food_entries: a note for a day that already has one under another id
  // breaks the unique index, and the food rows written before it must disappear too.
  await db.run(
    "INSERT INTO day_notes (id, local_day, body, created_at, updated_at, origin_device_id) VALUES ('n1', '2026-10-24', 'a', ?, ?, 'dev')",
    [NOW, NOW],
  );
  const withNote = (await exportBackup(db, PW, FAST)).text;
  await fresh.run(
    "INSERT INTO day_notes (id, local_day, body, created_at, updated_at, origin_device_id) VALUES ('other', '2026-10-24', 'b', ?, ?, 'dev')",
    [NOW, NOW],
  );
  await assert.rejects(restoreBackup(fresh, withNote, PW), /nothing was changed.*UNIQUE/);
  assert.equal((await fresh.all("SELECT * FROM food_entries")).length, 0, "earlier tables were rolled back too");
  await restoreBackup(fresh, text, PW); // the file without the note still restores
  assert.equal((await fresh.all("SELECT * FROM food_entries")).length, 1);
});

test("short passwords are refused at export", async () => {
  const { db } = await migratedDb();
  await assert.rejects(exportBackup(db, "short", FAST), /at least 8/);
});

test("export and restore through the Capacitor driver (plugin transactions, multi-row inserts)", async () => {
  const { db } = await seeded();
  // Enough rows to need several INSERT batches (health_samples has 15 columns -> 60 rows per batch).
  const many = Array.from({ length: 250 }, (_, i) => ({
    source: "garmin", device: "Garmin", externalId: `2026-10-24#${i + 1}`, metric: "daily_steps",
    startMs: NOW, offsetMin: 120, valueNum: i,
  }));
  await upsertSamples(db, many, NOW);
  const { text } = await exportBackup(db, PW, FAST);

  const { conn, calls } = fakePlugin();
  const phone = capacitorDriver(conn);
  await migrate(phone, realMigrations());
  calls.length = 0;
  const report = await restoreBackup(phone, text, PW);
  assert.equal(report.rows.health_samples, 251);
  assert.equal((await phone.all("SELECT * FROM health_samples")).length, 251);
  assert.equal(calls[0], "begin");
  assert.equal(calls.at(-1), "commit");
  assert.ok(calls.filter((c) => c === "run:false").length >= 5, "samples restored in batches");
  assert.ok(!calls.includes("run:true") && !calls.includes("run:undefined"), "never nests plugin transactions");
});
test("a backup made before the app was renamed to Even still restores", async () => {
  // tests/fixtures/health-app-backup.json: exported by the pre-rename code (format "health-app-backup",
  // 1000 iterations, password PW), with one food entry.
  const old = readFileSync(new URL("./fixtures/health-app-backup.json", import.meta.url), "utf8");
  assert.equal(JSON.parse(old).format, "health-app-backup");
  const { db } = await migratedDb();
  await restoreBackup(db, old, PW);
  const rows = await db.all<{ name: string }>("SELECT name FROM food_entries WHERE id = 'old1'");
  assert.deepEqual(rows, [{ name: "porridge" }]);

  const { text } = await exportBackup(db, PW, FAST);
  assert.equal(JSON.parse(text).format, "even-backup", "new backups use the new name");
});
