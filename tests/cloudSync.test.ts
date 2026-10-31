import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { SYNC_PAGE, type SyncRow } from "../src/core/syncWire";
import { bySize, cloudPull, cloudSync, cloudSyncSettings, pendingPush, SYNC_TABLES, type SyncTransport } from "../src/domain/cloudsync/cloudSync";
import { open, rowKey, seal, syncKeys } from "../src/domain/cloudsync/seal";
import { fromHex, newAdk, passphraseHint } from "../src/domain/cloudsync/keys";
import { serverBase, SyncHttpError, syncApi, transportOf } from "../src/domain/cloudsync/api";
import { sessionApi } from "../src/domain/cloudsync/session";
import { pushSettingsNow, syncNow } from "../src/domain/cloudsync/syncNow";
import { BACKUP_TABLES, exportBackup } from "../src/domain/backup/backup";
import { serverMigrations, statements } from "../server/migrate";
import { addFood, byPassphrase, firstPhone, foods, lastWriteWins, paging, roundTrip, softDelete, syncedDigest, type Phone } from "../scripts/lib/syncScenario";
import { testServer } from "./serverHelpers";
import { loadProfile, loadProfilePhoto, saveProfile, saveProfilePhoto } from "../src/domain/settings/profile";
import { deviceId, getSetting, setSetting } from "../src/db/settings";

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
  assert.deepEqual(await lastWriteWins(a, b, 1_000), []);
});

test("a soft delete syncs like any other edit", async () => {
  const { a, b } = await twoDevices();
  assert.deepEqual(await softDelete(a, b, 1_000), []);
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
  assert.deepEqual(await paging(a, b, 5_000), []);
});

test("two devices that wrote different tables converge to the same synced rows", async () => {
  const { a, b } = await twoDevices();
  await addFood(a, "f", "toast", 200, 1_000);
  await b.db.run(
    "INSERT INTO drink_entries (id, drunk_at_ms, name, volume_ml, abv_percent, created_at, updated_at, origin_device_id) VALUES ('d', 1, 'x', 330, 5, 1, 1, 'b')",
  );
  for (const [p, t] of [
    [a, 1_001],
    [b, 1_002],
    [a, 1_003],
  ] as const)
    await p.sync(t);
  const [da, db] = await Promise.all([syncedDigest(a.db), syncedDigest(b.db)]);
  assert.equal(da.digest, db.digest);
  assert.deepEqual([da.rows.food_entries, da.rows.drink_entries], [1, 1]);
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
  for (const t of ["food_entries", "health_samples", "meal_preps", "chat_messages", "account", "app_settings"]) assert.ok(names.includes(t), t);
  for (const t of ["sync_state", "sync_runs", "cloud_sync_cursors", "cloud_sync_outbox"]) assert.ok(!names.includes(t), t);
  assert.deepEqual(
    names,
    BACKUP_TABLES.map((t) => t.name).filter((n) => names.includes(n)),
    "restore order, so parents arrive before children",
  );
  const { a } = await twoDevices();
  const triggers = new Set((await a.db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'trigger'")).map((r) => r.name));
  for (const t of names) for (const op of ["ins", "upd"]) assert.ok(triggers.has(`cloud_sync_${t}_${op}`), `${t} needs its ${op} trigger in a migration`);
});

test("the profile and its picture reach the other device, so the web app greets the owner by name", async () => {
  const { a, b } = await twoDevices();
  await saveProfile(a.db, { name: "Alex Doe", heightCm: 180 }, "2026-10-31", 1_000);
  await saveProfilePhoto(a.db, "data:image/jpeg;base64,AAAA", 1_000);
  await a.sync(1_001);
  await b.sync(1_002);
  const p = await loadProfile(b.db);
  assert.equal(p.name, "Alex Doe");
  assert.equal(p.heightCm, 180);
  assert.equal(await loadProfilePhoto(b.db), "data:image/jpeg;base64,AAAA");
});

test("of the settings, only the profile syncs: each install keeps its own device id and the rest", async () => {
  const { a, b } = await twoDevices();
  const idB = await deviceId(b.db);
  await setSetting(a.db, "backup.last_at", "123", 1_000);
  await saveProfile(a.db, { name: "Alex" }, "2026-10-31", 1_000);
  await a.sync(1_001);
  const pushed = await server.pg.query<{ tbl: string }>("SELECT tbl FROM sync_rows WHERE owner_id = $1 AND tbl = 'app_settings'", [a.session.accountId]);
  assert.equal(pushed.length, 1, "the profile alone is pushed");

  // A row for another key, as a newer or misbehaving device could push it, is skipped on pull.
  const keys = await syncKeys(fromHex(a.session.adk));
  const key = await rowKey(keys, "app_settings", ["log.level"]);
  const blob = await seal(keys, "app_settings", key, { c: ["key", "value", "updated_at"], v: ["log.level", "debug", 2_000] });
  await syncApi(server.base, server.fetchFn, a.session.token).push([{ tbl: "app_settings", key, updatedAt: 2_000, blob }]);
  await b.sync(2_001);
  assert.equal(await getSetting(b.db, "log.level"), null);
  assert.equal(await getSetting(b.db, "backup.last_at"), null);
  assert.equal(await deviceId(b.db), idB);
  assert.equal((await loadProfile(b.db)).name, "Alex");
});

test("cloud sync bookkeeping stays out of backups", async () => {
  const { a } = await twoDevices();
  await addFood(a, "f", "x", 1, 1_000);
  await a.sync(1_001);
  const { rows } = await exportBackup(a.db, "password123", { iterations: 1_000 });
  for (const t of ["cloud_sync_cursors", "cloud_sync_outbox", "cloud_sync_pulling"]) assert.ok(!(t in rows), t);
  assert.ok("food_entries" in rows);
});

/** Rows another device wrote over time: many older ones in one sync, then one for today. */
async function historyThenToday(a: Phone, n: number): Promise<void> {
  await a.db.exec("BEGIN");
  for (let i = 0; i < n; i++) await addFood(a, `old-${String(i).padStart(5, "0")}`, "older day", i, 1_000);
  await a.db.exec("COMMIT");
  await a.sync(1_001);
  await addFood(a, "today", "lunch today", 600, 2_000);
  await a.sync(2_001);
}

const transportFor = async (p: Phone) => ({ server: transportOf(sessionApi(p.session, server.fetchFn)), keys: await syncKeys(fromHex(p.session.adk)) });
const cursorNames = async (p: Phone) => (await p.db.all<{ name: string }>("SELECT name FROM cloud_sync_cursors ORDER BY name")).map((r) => r.name);

test("a device catching up gets today's rows in its first page, and a catch-up cut short goes on where it stopped", async () => {
  const { a, b } = await twoDevices();
  await historyThenToday(a, SYNC_PAGE * 2);
  const { server: real, keys } = await transportFor(b);
  let calls = 0;
  const cut: SyncTransport = {
    ...real,
    pullNewest: async (...args) => {
      if (++calls > 1) throw new SyncHttpError(0);
      return real.pullNewest!(...args);
    },
  };
  let shown = 0;
  await assert.rejects(cloudPull(b.db, cut, keys, 3_000, { onProgress: () => shown++ }));
  const first = await foods(b);
  assert.ok(
    first.some((f) => f.id === "today"),
    "today's row came in the first page",
  );
  assert.equal(first.length, SYNC_PAGE);
  assert.equal(shown, 1, "the screens were told after the first page");
  assert.deepEqual(await cursorNames(b), ["pull.head", "pull.low"]);

  const rest = await b.sync(3_001);
  assert.equal(rest.pulled, SYNC_PAGE + 1, "only the rows the first try did not get");
  assert.equal((await foods(b)).length, SYNC_PAGE * 2 + 1);
  assert.deepEqual(await cursorNames(b), ["pull"], "the catch-up is over");
  assert.equal((await b.sync(3_002)).pulled, 0);
});

test("rows pushed while a device catches up are pulled in the same sync", async () => {
  const { a, b } = await twoDevices();
  await historyThenToday(a, SYNC_PAGE + 10);
  const { server: real, keys } = await transportFor(b);
  let added = false;
  const meanwhile: SyncTransport = {
    ...real,
    pullNewest: async (...args) => {
      const page = await real.pullNewest!(...args);
      if (!added) {
        added = true;
        await addFood(a, "meanwhile", "logged during the catch-up", 1, 2_500);
        await a.sync(2_501);
      }
      return page;
    },
  };
  await cloudPull(b.db, meanwhile, keys, 3_000);
  assert.ok((await foods(b)).some((f) => f.id === "meanwhile"));
});

test("a child row pushed after its parent's page still merges, though it arrives first", async () => {
  const { a, b } = await twoDevices();
  await a.db.run("INSERT INTO meal_preps (id, name, created_at, updated_at, origin_device_id) VALUES ('prep', 'chili', 1000, 1000, 'a')");
  await a.sync(1_001);
  await historyThenToday(a, SYNC_PAGE);
  await a.db.run(
    "INSERT INTO meal_prep_tags (id, meal_prep_id, tag, created_at, updated_at, origin_device_id) VALUES ('tag', 'prep', 'batch', 3000, 3000, 'a')",
  );
  await a.sync(3_001);
  const r = await b.sync(4_000);
  assert.equal(r.rejected, 0);
  assert.deepEqual(await b.db.all("SELECT id, meal_prep_id FROM meal_prep_tags"), [{ id: "tag", meal_prep_id: "prep" }]);
  assert.deepEqual(await b.db.all("PRAGMA foreign_key_check"), [], "every parent is there once the pull is over");
  assert.equal((await b.db.all<{ foreign_keys: number }>("PRAGMA foreign_keys"))[0].foreign_keys, 1, "foreign keys are on again");
});

test("a profile change goes up on its own at once, and reaches another device before the rest of its pull", async () => {
  const { a, b } = await twoDevices();
  await addFood(a, "f", "toast", 200, 1_000);
  await saveProfile(a.db, { name: "Alex Doe", heightCm: 180 }, "2026-10-31", 1_000);
  await pushSettingsNow(a.db, a.session, { fetchFn: server.fetchFn });
  assert.equal(await pendingPush(a.db), 1, "only the settings went: the food entry waits for the sync");

  const { server: transport, keys } = await transportFor(b);
  await cloudSyncSettings(b.db, transport, keys, 1_100);
  assert.equal((await loadProfile(b.db)).name, "Alex Doe");
  assert.deepEqual(await cursorNames(b), [], "the pull cursor did not move, so the full pull misses nothing");
  await a.sync(1_200);
  await b.sync(1_300);
  assert.deepEqual(
    (await foods(b)).map((f) => f.id),
    ["f"],
  );
});

test("against a server without the newest-first pull, the pull goes oldest first as before", async () => {
  const { a, b } = await twoDevices();
  await addFood(a, "f", "toast", 200, 1_000);
  await a.sync(1_001);
  const { server: real, keys } = await transportFor(b);
  const old: SyncTransport = {
    ...real,
    pullNewest: async () => {
      throw new SyncHttpError(404);
    },
  };
  assert.equal((await cloudSync(b.db, old, keys, 1_100)).pulled, 1);
  assert.deepEqual(await cursorNames(b), ["pull"]);
});

test("the newest-first pull refuses an empty range or a table name that is not one", async () => {
  const { a } = await twoDevices();
  const get = (q: string) => server.fetchFn(`${server.base}/v1/pull/newest?${q}`, { headers: { authorization: `Bearer ${a.session.token}` } });
  assert.equal((await get("after=5&before=5")).status, 400);
  assert.equal((await get("after=-1&tbl=food_entries;drop")).status, 400);
  assert.equal((await get("after=-1&tbl=food_entries")).status, 200);
});

test("syncNow tells the screens after each page it stores", async () => {
  const { a, b } = await twoDevices();
  await historyThenToday(a, SYNC_PAGE + 1);
  let shown = 0;
  await syncNow(b.db, b.session, { fetchFn: server.fetchFn, today: "2026-10-31", nowMs: 3_000, onProgress: () => shown++ });
  assert.equal(shown, 2);
});

test("server migrations are numbered in order and split into statements", () => {
  const ms = serverMigrations();
  assert.deepEqual(
    ms.map((m) => m.version),
    ms.map((_, i) => i + 1),
  );
  assert.equal(statements("-- a comment\nCREATE TABLE a (x INT);\n\nCREATE INDEX i ON a (x);\n").length, 2);
});

test("a server address typed without https gets it, so the phone can reach the server", async () => {
  assert.equal(serverBase(" even-sepia.vercel.app/ "), "https://even-sepia.vercel.app");
  assert.equal(serverBase("http://localhost:8787"), "http://localhost:8787");
  assert.equal(serverBase(""), "");
  const urls: string[] = [];
  const fetchFn = (async (url: string) => {
    urls.push(url);
    return new Response(JSON.stringify({ ok: true }));
  }) as typeof fetch;
  await syncApi("even-sepia.vercel.app", fetchFn).health();
  assert.deepEqual(urls, ["https://even-sepia.vercel.app/health"]);
});

test("the new account form says what the passphrase still needs, and only a mismatch is an error", () => {
  assert.equal(passphraseHint("", "", false), null);
  assert.deepEqual(passphraseHint("short pass", "", false), { text: "2 more characters (at least 12). A few words make a strong one.", error: false });
  assert.equal(passphraseHint("eleven char ", "", false)?.text.startsWith("1 more character "), true, "spaces at the ends do not count, as in checkPassphrase");
  assert.deepEqual(passphraseHint("correct horse battery", "", false), { text: "Long enough. Now type it again below.", error: false });
  assert.deepEqual(passphraseHint("correct horse battery", "correct horse", false), { text: "The two passphrases are different.", error: true });
  assert.deepEqual(passphraseHint("correct horse battery", "correct horse battery", false), {
    text: "Both match. Write it down, then say so below.",
    error: false,
  });
  assert.deepEqual(passphraseHint("correct horse battery", "correct horse battery", true), { text: "Both match.", error: false });
});
