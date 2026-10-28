import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { SYNC_PAGE, type SyncRow } from "../src/core/syncWire";
import { bySize, SYNC_TABLES } from "../src/features/cloudsync/cloudSync";
import { open, rowKey, seal, syncKeys } from "../src/features/cloudsync/seal";
import { BACKUP_TABLES, exportBackup } from "../src/features/backup/backup";
import { serverMigrations, statements } from "../server/migrate";
import { addFood, foods, newSecret, phone, roundTrip } from "../scripts/lib/syncScenario";
import { testServer } from "./serverHelpers";

// One PGlite server for the file (it takes about a second to start); each test uses its own owner.
let server: Awaited<ReturnType<typeof testServer>>;
before(async () => {
  server = await testServer();
});
after(() => server.pg.close());

async function twoPhones(owner = crypto.randomUUID()) {
  const secret = newSecret();
  const [da, db] = [await server.store.addDevice(owner, "a"), await server.store.addDevice(owner, "b")];
  return {
    owner,
    secret,
    a: await phone("a", server.base, da.token, secret, server.fetchFn),
    b: await phone("b", server.base, db.token, secret, server.fetchFn),
  };
}

const req = (path: string, token?: string, init: RequestInit = {}) =>
  server.app.request(path, { ...init, headers: { ...init.headers, ...(token ? { authorization: `Bearer ${token}` } : {}) } });

test("a write on one phone reaches the other, and an edit comes back", async () => {
  const { a, b } = await twoPhones();
  assert.deepEqual(await roundTrip(a, b, 1_000), []);
});

test("the server stores sealed rows only: no name, value or id of the row is readable there", async () => {
  const { owner, a } = await twoPhones();
  await addFood(a, "food-secret-id", "chocolate cake", 512, 1_000);
  await a.sync(1_001);
  const rows = await server.pg.query<Record<string, unknown>>("SELECT * FROM sync_rows WHERE owner_id = $1", [owner]);
  assert.equal(rows.length, 1);
  const stored = JSON.stringify(rows);
  for (const plain of ["chocolate", "512", "food-secret-id", "lunch"]) assert.ok(!stored.includes(plain), `${plain} must not be readable on the server`);
  assert.equal(rows[0].tbl, "food_entries");
  assert.equal(rows[0].updated_at, 1_000);
});

test("last write wins per row on updated_at, whichever phone syncs last", async () => {
  const { a, b } = await twoPhones();
  await addFood(a, "f", "newer on A", 2, 2_000);
  await addFood(b, "f", "older on B", 1, 1_000);
  await a.sync(2_001);
  await b.sync(2_002); // B's older edit is pushed, refused, then A's is pulled
  await a.sync(2_003);
  for (const p of [a, b]) assert.equal((await foods(p))[0].name, "newer on A", p.name);
});

test("a soft delete syncs like any other edit", async () => {
  const { a, b } = await twoPhones();
  await addFood(a, "f", "toast", 200, 1_000);
  await a.sync(1_001);
  await b.sync(1_002);
  await b.db.run("UPDATE food_entries SET deleted_at = ?, updated_at = ? WHERE id = 'f'", [1_500, 1_500]);
  await b.sync(1_501);
  await a.sync(1_502);
  assert.equal((await foods(a))[0].deleted_at, 1_500);
});

test("a second sync with nothing new sends nothing and pulls nothing", async () => {
  const { a } = await twoPhones();
  await addFood(a, "f", "toast", 200, 1_000);
  await a.sync(1_001);
  assert.deepEqual(await a.sync(1_002), { pushed: 0, accepted: 0, pulled: 0, skipped: 0 });
});

test("more rows than a page push and pull in pages, none lost at the page edges (same updated_at)", async () => {
  const { a, b } = await twoPhones();
  const n = SYNC_PAGE * 2 + 7;
  await a.db.exec("BEGIN");
  for (let i = 0; i < n; i++) await addFood(a, `f${String(i).padStart(5, "0")}`, "x", i, 5_000); // one timestamp for all
  await a.db.exec("COMMIT");
  const pushed = await a.sync(5_001);
  assert.equal(pushed.accepted, n);
  const pulled = await b.sync(5_002);
  assert.equal(pulled.pulled, n);
  assert.equal((await foods(b)).length, n);
});

test("health samples from another phone merge on their natural key, not the other phone's row id", async () => {
  const { a, b } = await twoPhones();
  const sample = (id: string, value: number, at: number) =>
    `INSERT INTO health_samples (id, source, device, external_id, metric, start_ms, value_num, created_at, updated_at)
     VALUES ('${id}', 'garmin', 'fr965', '2026-10-01', 'daily_steps', 0, ${value}, ${at}, ${at})`;
  await a.db.exec(sample("id-on-a", 9000, 1_000));
  await b.db.exec(sample("id-on-b", 9500, 2_000)); // the same day read again later on B
  await a.sync(2_001);
  await b.sync(2_002);
  await a.sync(2_003);
  for (const p of [a, b]) {
    const rows = await p.db.all<{ value_num: number }>("SELECT value_num FROM health_samples");
    assert.deepEqual(rows, [{ value_num: 9500 }], p.name);
  }
});

test("another owner's rows never reach this owner's phones", async () => {
  const one = await twoPhones();
  const other = await twoPhones();
  await addFood(other.a, "theirs", "x", 1, 1_000);
  await other.a.sync(1_001);
  await one.a.sync(1_002);
  assert.deepEqual(await foods(one.a), []);
});

test("a phone with another secret cannot read the rows and the sync fails loudly", async () => {
  const owner = crypto.randomUUID();
  const { a } = await twoPhones(owner);
  await addFood(a, "f", "x", 1, 1_000);
  await a.sync(1_001);
  const stranger = await phone("c", server.base, (await server.store.addDevice(owner, "c")).token, newSecret(), server.fetchFn);
  await assert.rejects(stranger.sync(1_002));
  assert.deepEqual(await foods(stranger), [], "nothing half-applied");
});

test("a sealed row opens only as the row it was sealed for", async () => {
  const keys = await syncKeys(newSecret());
  const key = await rowKey(keys, "food_entries", ["f"]);
  const blob = await seal(keys, "food_entries", key, { c: ["id"], v: ["f"] });
  assert.deepEqual(await open(keys, "food_entries", key, blob), { c: ["id"], v: ["f"] });
  const otherKey = await rowKey(keys, "food_entries", ["g"]);
  await assert.rejects(open(keys, "food_entries", otherKey, blob), "moved to another row");
  await assert.rejects(open(keys, "drink_entries", key, blob), "moved to another table");
  assert.equal(await rowKey(keys, "food_entries", ["f"]), key, "the same row has the same key on every device");
});

test("the API refuses missing, unknown and revoked tokens, bad bodies and bad cursors", async () => {
  const owner = crypto.randomUUID();
  const d = await server.store.addDevice(owner, "x");
  assert.equal((await req("/health")).status, 200);
  assert.equal((await req("/v1/pull")).status, 401);
  assert.equal((await req("/v1/pull", "nope")).status, 401);
  assert.equal((await req("/v1/pull?after=abc", d.token)).status, 400);
  assert.equal((await req(`/v1/pull?limit=${SYNC_PAGE + 1}`, d.token)).status, 400);
  const post = (body: unknown) => req("/v1/push", d.token, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  assert.equal((await post({ rows: [{ tbl: "food_entries; DROP", key: "0".repeat(64), updatedAt: 1, blob: "x" }] })).status, 400);
  assert.equal((await post({ rows: [{ tbl: "food_entries", key: "short", updatedAt: 1, blob: "x" }] })).status, 400);
  assert.equal((await post({ rows: [] })).status, 200);
  await server.store.revokeDevice(d.id);
  assert.equal((await req("/v1/pull", d.token)).status, 401);
});

test("the server keeps only a hash of each device token", async () => {
  const d = await server.store.addDevice(crypto.randomUUID(), "x");
  const [row] = await server.pg.query<{ token_hash: string }>("SELECT token_hash FROM devices WHERE id = $1", [d.id]);
  assert.notEqual(row.token_hash, d.token);
  assert.match(row.token_hash, /^[0-9a-f]{64}$/);
});

test("duplicate keys in one push keep the newest copy", async () => {
  const owner = crypto.randomUUID();
  const d = await server.store.addDevice(owner, "x");
  const row = (updatedAt: number, blob: string): SyncRow => ({ tbl: "food_entries", key: "a".repeat(64), updatedAt, blob });
  const res = await server.store.push({ id: d.id, ownerId: owner }, [row(1, "old"), row(3, "new"), row(2, "mid")]);
  assert.deepEqual(res, { accepted: 1, ignored: 2 });
  const pulled = await server.store.pull(owner, -1, 10);
  assert.deepEqual(
    pulled.rows.map((r) => [r.updatedAt, r.blob]),
    [[3, "new"]],
  );
});

test("pushes split under the body limit Vercel allows", () => {
  const row = (n: number): SyncRow => ({ tbl: "food_photos", key: "a".repeat(64), updatedAt: 1, blob: "x".repeat(n) });
  const parts = bySize([row(600), row(600), row(600), row(10)], 1_500);
  assert.deepEqual(
    parts.map((p) => p.length),
    [2, 2],
  );
  assert.deepEqual(bySize([row(5_000)], 1_500).length, 1, "one big row still goes, alone");
});

test("synced tables: user data yes, this install's own bookkeeping no", () => {
  const names = SYNC_TABLES.map((t) => t.name);
  for (const t of ["food_entries", "health_samples", "meal_preps", "chat_messages", "account"]) assert.ok(names.includes(t), t);
  for (const t of ["app_settings", "sync_state", "sync_runs", "cloud_sync_cursors"]) assert.ok(!names.includes(t), t);
  // Restore order is kept, so parents arrive before children.
  assert.deepEqual(
    names,
    BACKUP_TABLES.map((t) => t.name).filter((n) => names.includes(n)),
  );
});

test("cloud sync cursors stay out of backups", async () => {
  const { a } = await twoPhones();
  await addFood(a, "f", "x", 1, 1_000);
  await a.sync(1_001);
  const { rows } = await exportBackup(a.db, "password123", { iterations: 1_000 });
  assert.ok(!("cloud_sync_cursors" in rows));
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
