import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { SYNC_PAGE, type SyncRow } from "../src/core/syncWire";
import { bySize, cloudSync, pendingPush, SYNC_TABLES } from "../src/features/cloudsync/cloudSync";
import { open, rowKey, seal, syncKeys } from "../src/features/cloudsync/seal";
import { fromHex, newAdk } from "../src/features/cloudsync/keys";
import { syncApi, transportOf } from "../src/features/cloudsync/api";
import { BACKUP_TABLES, exportBackup } from "../src/features/backup/backup";
import { serverMigrations, statements } from "../server/migrate";
import { addFood, byPassphrase, firstPhone, foods, roundTrip, type Phone } from "../scripts/lib/syncScenario";
import { testServer } from "./serverHelpers";

// One PGlite server for the file (it takes about a second to start); each test makes its own account.
let server: Awaited<ReturnType<typeof testServer>>;
before(async () => {
  server = await testServer();
});
after(() => server.pg.close());

async function twoDevices(): Promise<{ email: string; a: Phone; b: Phone }> {
  const email = `${crypto.randomUUID()}@example.com`;
  const code = await server.stores.accounts.createInvite(email);
  const a = await firstPhone(server, code, email, "a");
  const b = await byPassphrase(server, email, "b");
  return { email, a, b };
}

test("a write on one device reaches the other, and an edit comes back", async () => {
  const { a, b } = await twoDevices();
  assert.deepEqual(await roundTrip(a, b, 1_000), []);
});

test("the server stores sealed rows only: no name, value or id of the row is readable there", async () => {
  const { a } = await twoDevices();
  await addFood(a, "food-secret-id", "chocolate cake", 512.25, 1_000); // a dot never appears in base64 or hex
  await a.sync(1_001);
  const rows = await server.pg.query<Record<string, unknown>>("SELECT * FROM sync_rows WHERE owner_id = $1", [a.session.accountId]);
  assert.equal(rows.length, 1);
  const stored = JSON.stringify(rows);
  for (const plain of ["chocolate", "512.25", "food-secret-id", "lunch"]) assert.ok(!stored.includes(plain), `${plain} must not be readable on the server`);
  assert.equal(rows[0].tbl, "food_entries");
});

test("last write wins per row on updated_at, whichever device syncs last", async () => {
  const { a, b } = await twoDevices();
  await addFood(a, "f", "newer on A", 2, 2_000);
  await addFood(b, "f", "older on B", 1, 1_000);
  await a.sync(2_001);
  await b.sync(2_002); // B's older edit is pushed, refused, then A's is pulled
  await a.sync(2_003);
  for (const p of [a, b]) assert.equal((await foods(p))[0].name, "newer on A", p.name);
});

test("a soft delete syncs like any other edit", async () => {
  const { a, b } = await twoDevices();
  await addFood(a, "f", "toast", 200, 1_000);
  await a.sync(1_001);
  await b.sync(1_002);
  await b.db.run("UPDATE food_entries SET deleted_at = ?, updated_at = ? WHERE id = 'f'", [1_500, 1_500]);
  await b.sync(1_501);
  await a.sync(1_502);
  assert.equal((await foods(a))[0].deleted_at, 1_500);
});

test("a second sync with nothing new sends nothing, and pulled rows are not queued to go back", async () => {
  const { a, b } = await twoDevices();
  await addFood(a, "f", "toast", 200, 1_000);
  await a.sync(1_001);
  assert.equal(await pendingPush(a.db), 0);
  await b.sync(1_002);
  assert.equal(await pendingPush(b.db), 0, "rows B pulled are not in B's outbox");
  const again = await a.sync(1_003);
  assert.deepEqual([again.pushed, again.pulled], [0, 0]);
});

test("clock skew: an edit stamped earlier than rows pulled from a device ahead in time is still pushed", async () => {
  const { a, b } = await twoDevices();
  // B's clock is a minute ahead. A pulls B's row, then edits another row with its own (earlier) clock.
  await addFood(b, "from-b", "b", 1, 60_000);
  await b.sync(60_001);
  await a.sync(1_000);
  await addFood(a, "from-a", "edited on A", 2, 1_500);
  await a.sync(1_501);
  await b.sync(60_002);
  assert.ok(
    (await foods(b)).some((f) => f.id === "from-a"),
    "the earlier-stamped edit reached B",
  );
});

test("an edit made while a push is running stays queued for the next one", async () => {
  const { a } = await twoDevices();
  await addFood(a, "f", "first", 1, 1_000);
  const api = syncApi(server.base, server.fetchFn, a.session.token);
  const slow = transportOf(api);
  const editDuringPush = {
    ...slow,
    push: async (rows: SyncRow[]) => {
      await addFood(a, "f", "second", 2, 2_000);
      return slow.push(rows);
    },
  };
  await cloudSync(a.db, editDuringPush, await syncKeys(fromHex(a.session.adk)), 1_001);
  assert.equal(await pendingPush(a.db), 1, "the edit made during the push is still waiting");
});

test("more rows than a page push and pull in pages, none lost", async () => {
  const { a, b } = await twoDevices();
  const n = SYNC_PAGE * 2 + 7;
  await a.db.exec("BEGIN");
  for (let i = 0; i < n; i++) await addFood(a, `f${String(i).padStart(5, "0")}`, "x", i, 5_000); // one timestamp for all
  await a.db.exec("COMMIT");
  assert.equal((await a.sync(5_001)).accepted, n);
  assert.equal((await b.sync(5_002)).pulled, n);
  assert.equal((await foods(b)).length, n);
});

test("a full-size food photo syncs (it used to stop every sync)", async () => {
  const { a, b } = await twoDevices();
  const data = Buffer.alloc(1_500_000, 7).toString("base64"); // MAX_PHOTO_BYTES
  await a.db.run(
    "INSERT INTO food_photos (id, mime, data_b64, bytes, created_at, updated_at, origin_device_id) VALUES ('p', 'image/jpeg', ?, 1500000, 1000, 1000, 'a')",
    [data],
  );
  await addFood(a, "f", "with photo", 1, 1_000);
  const r = await a.sync(1_001);
  assert.deepEqual([r.tooLarge, r.accepted], [0, 2]);
  await b.sync(1_002);
  const [photo] = await b.db.all<{ n: number }>("SELECT length(data_b64) AS n FROM food_photos WHERE id = 'p'");
  assert.equal(photo.n, data.length);
});

test("a row too big for any request is left on the device, and the rest still syncs", async () => {
  const { a } = await twoDevices();
  const big = "x".repeat(4_000_000);
  await a.db.run("INSERT INTO chat_conversations (id, title, created_at, updated_at, origin_device_id) VALUES ('c', 't', 1, 1, 'a')");
  await a.db.run(
    "INSERT INTO chat_messages (id, conversation_id, seq, role, content_json, created_at, updated_at, origin_device_id) VALUES ('m', 'c', 1, 'user', ?, 1, 1, 'a')",
    [big],
  );
  await addFood(a, "f", "x", 1, 1_000);
  const r = await a.sync(1_001);
  assert.equal(r.tooLarge, 1);
  assert.equal(r.accepted, 2, "the conversation and the food entry went");
});

test("a row nobody can open (another secret) is set aside, and every device keeps syncing", async () => {
  const { a, b } = await twoDevices();
  // A device with the wrong key pushes into the account.
  const wrong = await syncKeys(newAdk());
  const key = await rowKey(wrong, "food_entries", ["bad"]);
  await syncApi(server.base, server.fetchFn, a.session.token).push([
    { tbl: "food_entries", key, updatedAt: 1, blob: await seal(wrong, "food_entries", key, { c: ["id"], v: ["bad"] }) },
  ]);
  await addFood(a, "good", "x", 1, 2_000);
  await a.sync(2_001);
  const r = await b.sync(2_002);
  assert.equal(r.rejected, 1);
  assert.deepEqual(
    (await foods(b)).map((f) => f.id),
    ["good"],
  );
  assert.equal((await b.sync(2_003)).rejected, 0, "the bad row is passed, not read again");
});

test("health samples from another device merge on their natural key, not the other device's row id", async () => {
  const { a, b } = await twoDevices();
  const sample = (id: string, value: number, at: number) =>
    `INSERT INTO health_samples (id, source, device, external_id, metric, start_ms, value_num, created_at, updated_at)
     VALUES ('${id}', 'garmin', 'fr965', '2026-10-01', 'daily_steps', 0, ${value}, ${at}, ${at})`;
  await a.db.exec(sample("id-on-a", 9000, 1_000));
  await b.db.exec(sample("id-on-b", 9500, 2_000)); // the same day read again later on B
  await a.sync(2_001);
  await b.sync(2_002);
  await a.sync(2_003);
  for (const p of [a, b]) assert.deepEqual(await p.db.all("SELECT value_num FROM health_samples"), [{ value_num: 9500 }], p.name);
});

test("another account's rows never reach this account's devices", async () => {
  const one = await twoDevices();
  const other = await twoDevices();
  await addFood(other.a, "theirs", "x", 1, 1_000);
  await other.a.sync(1_001);
  await one.a.sync(1_002);
  assert.deepEqual(await foods(one.a), []);
});

test("a sealed row opens only as the row it was sealed for", async () => {
  const keys = await syncKeys(newAdk());
  const key = await rowKey(keys, "food_entries", ["f"]);
  const blob = await seal(keys, "food_entries", key, { c: ["id"], v: ["f"] });
  assert.deepEqual(await open(keys, "food_entries", key, blob), { c: ["id"], v: ["f"] });
  await assert.rejects(open(keys, "food_entries", await rowKey(keys, "food_entries", ["g"]), blob), "moved to another row");
  await assert.rejects(open(keys, "drink_entries", key, blob), "moved to another table");
});

test("duplicate keys in one push keep the newest copy", async () => {
  const { a } = await twoDevices();
  const row = (updatedAt: number, blob: string): SyncRow => ({ tbl: "food_entries", key: "a".repeat(64), updatedAt, blob });
  const res = await server.stores.sync.push({ id: a.session.deviceId, ownerId: a.session.accountId }, [row(1, "old"), row(3, "new"), row(2, "mid")]);
  assert.deepEqual(res, { accepted: 1, ignored: 2 });
  const pulled = await server.stores.sync.pull(a.session.accountId, -1, 10);
  assert.deepEqual(
    pulled.rows.map((r) => [r.updatedAt, r.blob]),
    [[3, "new"]],
  );
});

test("pushes split under the body limit Vercel allows", () => {
  const row = (n: number): SyncRow => ({ tbl: "food_photos", key: "a".repeat(64), updatedAt: 1, blob: "x".repeat(n) });
  assert.deepEqual(
    bySize([row(600), row(600), row(600), row(10)], 1_500).map((p) => p.length),
    [2, 2],
  );
  assert.equal(bySize([row(5_000)], 1_500).length, 1, "one big row still goes, alone");
});

test("synced tables: user data yes, this install's own bookkeeping no, and each has its outbox triggers", async () => {
  const names = SYNC_TABLES.map((t) => t.name);
  for (const t of ["food_entries", "health_samples", "meal_preps", "chat_messages", "account"]) assert.ok(names.includes(t), t);
  for (const t of ["app_settings", "sync_state", "sync_runs", "cloud_sync_cursors", "cloud_sync_outbox"]) assert.ok(!names.includes(t), t);
  assert.deepEqual(
    names,
    BACKUP_TABLES.map((t) => t.name).filter((n) => names.includes(n)),
    "restore order, so parents arrive before children",
  );
  const { a } = await twoDevices();
  const triggers = new Set((await a.db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'trigger'")).map((r) => r.name));
  for (const t of names) for (const op of ["ins", "upd"]) assert.ok(triggers.has(`cloud_sync_${t}_${op}`), `${t} needs its ${op} trigger in a migration`);
});

test("cloud sync bookkeeping stays out of backups", async () => {
  const { a } = await twoDevices();
  await addFood(a, "f", "x", 1, 1_000);
  await a.sync(1_001);
  const { rows } = await exportBackup(a.db, "password123", { iterations: 1_000 });
  for (const t of ["cloud_sync_cursors", "cloud_sync_outbox", "cloud_sync_pulling"]) assert.ok(!(t in rows), t);
  assert.ok("food_entries" in rows);
});

test("server migrations are numbered in order and split into statements", () => {
  const ms = serverMigrations();
  assert.deepEqual(
    ms.map((m) => m.version),
    ms.map((_, i) => i + 1),
  );
  assert.equal(statements("-- a comment\nCREATE TABLE a (x INT);\n\nCREATE INDEX i ON a (x);\n").length, 2);
});
