import { createHash } from "node:crypto";
import { memorySecretStore } from "../../src/core/secretStore";
import { SYNC_PAGE } from "../../src/core/syncWire";
import type { SqlDriver } from "../../src/db/driver";
import { SYNC_TABLES } from "../../src/domain/cloudsync/cloudSync";
import { approvePairing, createAccount, signInWithPassphrase, startPairing, type SyncSession } from "../../src/domain/cloudsync/session";
import { syncNow, type CloudSyncResult } from "../../src/domain/cloudsync/syncNow";
import { migratedNodeDb } from "./nodeDb";

/**
 * The owner's devices, each with its own migrated database (node:sqlite, the app's migrations),
 * joined to one account the ways docs/users.md describes, syncing through one server. The unit
 * tests run it on the Hono app over PGlite (tests/cloudSync.test.ts); the smoke test against the
 * `sync` and `db` containers, or a Vercel deployment (scripts/sync-smoke.ts); the simulated phones
 * in their own containers (scripts/phone-sim.ts).
 */
export interface Phone {
  name: string;
  db: SqlDriver;
  session: SyncSession;
  sync(nowMs?: number): Promise<CloudSyncResult>;
}

/** PBKDF2 at the lowest count the server takes: real flows, quicker tests. */
export const TEST_ITERATIONS = 100_000;
export const TEST_PASSPHRASE = "correct horse battery staple";

export interface Server {
  base: string;
  fetchFn?: typeof fetch;
}

/** Where the device keeps its database (in memory unless a file is given) and what it calls today. */
export interface DeviceOpts {
  dbPath?: string;
  today?: () => string;
}

async function device(name: string, session: SyncSession, server: Server, opts: DeviceOpts = {}): Promise<Phone> {
  const { db } = await migratedNodeDb(opts.dbPath ?? ":memory:", { foreignKeys: true });
  const today = opts.today ?? (() => "2026-10-28");
  return { name, db, session, sync: (nowMs) => syncNow(db, session, { fetchFn: server.fetchFn, today: today(), nowMs }) };
}

/** A new account's first phone, from an invite. */
export async function firstPhone(server: Server, inviteCode: string, email: string, name = "a", opts?: DeviceOpts): Promise<Phone> {
  const session = await createAccount(
    server.base,
    memorySecretStore(),
    { inviteCode, email, displayName: `Owner of ${name}`, passphrase: TEST_PASSPHRASE, device: { name, kind: "phone" } },
    { fetchFn: server.fetchFn, iterations: TEST_ITERATIONS },
  );
  return device(name, session, server, opts);
}

/** Another device of the same account, by passphrase. */
export async function byPassphrase(
  server: Server,
  email: string,
  name = "b",
  passphrase = TEST_PASSPHRASE,
  opts?: DeviceOpts & { kind?: "phone" | "web" },
): Promise<Phone> {
  const session = await signInWithPassphrase(
    server.base,
    memorySecretStore(),
    { email, passphrase, device: { name, kind: opts?.kind ?? "web" } },
    { fetchFn: server.fetchFn },
  );
  return device(name, session, server, opts);
}

/** Another device of the same account, approved from `by`. */
export async function byPairing(server: Server, by: Phone, name = "c"): Promise<Phone> {
  const req = await startPairing(server.base, memorySecretStore(), { name, kind: "web" }, { fetchFn: server.fetchFn, pollMs: 10 });
  await approvePairing(by.session, req.code, { fetchFn: server.fetchFn });
  return device(name, await req.done, server);
}

export async function addFood(p: Phone, id: string, name: string, kcal: number, nowMs: number): Promise<void> {
  await p.db.run(
    `INSERT INTO food_entries (id, eaten_at_ms, offset_min, local_day, name, meal, calories, created_at, updated_at, origin_device_id)
     VALUES (?, ?, 0, date(? / 1000, 'unixepoch'), ?, 'lunch', ?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET name = excluded.name, calories = excluded.calories, updated_at = excluded.updated_at`,
    [id, nowMs, nowMs, name, kcal, nowMs, nowMs, p.name],
  );
}

export async function foods(p: Phone): Promise<{ id: string; name: string; calories: number; deleted_at: number | null }[]> {
  return p.db.all("SELECT id, name, calories, deleted_at FROM food_entries ORDER BY id");
}

/**
 * One hash over every synced row, so two devices can be compared without showing their data.
 * `id` is left out where it is not the row's key: a health sample keeps the id it got on each
 * device and merges on its natural key (mergeRows).
 */
export async function syncedDigest(db: SqlDriver): Promise<{ digest: string; rows: Record<string, number> }> {
  const hash = createHash("sha256");
  const rows: Record<string, number> = {};
  for (const t of SYNC_TABLES) {
    const all = await db.all<Record<string, unknown>>(`SELECT * FROM ${t.name} ORDER BY ${t.key.join(", ")}`);
    rows[t.name] = all.length;
    for (const r of all) {
      if (!t.key.includes("id")) delete r.id;
      hash.update(`${t.name}\0${JSON.stringify(r)}\n`);
    }
  }
  return { digest: hash.digest("hex"), rows };
}

type Scenario = (a: Phone, b: Phone, t0: number) => Promise<string[]>;

function checker(): { failures: string[]; check: (ok: boolean, what: string) => void } {
  const failures: string[] = [];
  return { failures, check: (ok, what) => void (ok || failures.push(what)) };
}

/** The round trip every environment must pass: A writes, B reads, B edits, A reads the edit. */
export const roundTrip: Scenario = async (a, b, t0 = Date.now()) => {
  const { failures, check } = checker();
  await addFood(a, "food-1", "oats", 380, t0);
  await a.sync(t0 + 1);
  await b.sync(t0 + 2);
  check(
    (await foods(b)).some((f) => f.id === "food-1" && f.name === "oats"),
    "a row written on phone A reaches device B",
  );
  await addFood(b, "food-1", "oats and milk", 450, t0 + 10);
  await b.sync(t0 + 11);
  await a.sync(t0 + 12);
  check((await foods(a)).find((f) => f.id === "food-1")?.calories === 450, "an edit on device B reaches phone A");
  return failures;
};

/** Both edit one row before either syncs: the later edit wins on both, whichever pushed last. */
export const lastWriteWins: Scenario = async (a, b, t0) => {
  const { failures, check } = checker();
  await addFood(a, "lww", "newer on A", 2, t0 + 1_000);
  await addFood(b, "lww", "older on B", 1, t0);
  await a.sync(t0 + 1_001);
  await b.sync(t0 + 1_002); // B's older edit is pushed, refused, then A's is pulled
  await a.sync(t0 + 1_003);
  for (const p of [a, b]) check((await foods(p)).find((f) => f.id === "lww")?.name === "newer on A", `the later edit wins on ${p.name}`);
  return failures;
};

/** A delete is an edit (deleted_at): it reaches the other device and the row stays as a tombstone. */
export const softDelete: Scenario = async (a, b, t0) => {
  const { failures, check } = checker();
  await addFood(a, "gone", "toast", 200, t0);
  await a.sync(t0 + 1);
  await b.sync(t0 + 2);
  await b.db.run("UPDATE food_entries SET deleted_at = ?, updated_at = ? WHERE id = 'gone'", [t0 + 500, t0 + 500]);
  await b.sync(t0 + 501);
  await a.sync(t0 + 502);
  check((await foods(a)).find((f) => f.id === "gone")?.deleted_at === t0 + 500, "a delete on device B reaches phone A");
  return failures;
};

/** More rows than one page each way: pushed and pulled in pages, none lost. */
export const paging: Scenario = async (a, b, t0) => {
  const { failures, check } = checker();
  const n = SYNC_PAGE * 2 + 7;
  await a.db.exec("BEGIN");
  for (let i = 0; i < n; i++) await addFood(a, `page-${String(i).padStart(5, "0")}`, "x", i, t0); // one timestamp for all
  await a.db.exec("COMMIT");
  check((await a.sync(t0 + 1)).accepted === n, `${n} rows pushed in pages`);
  check((await b.sync(t0 + 2)).pulled >= n, `${n} rows pulled in pages`);
  const [d1, d2] = await Promise.all([syncedDigest(a.db), syncedDigest(b.db)]);
  check(d1.digest === d2.digest, "both devices hold the same rows afterwards");
  return failures;
};

/** Every scenario, in the order the smoke test runs them on one pair of devices. */
export const SCENARIOS: [string, Scenario][] = [
  ["two devices sync through the server", roundTrip],
  ["the later of two edits wins on both devices", lastWriteWins],
  ["a delete syncs", softDelete],
  ["more rows than a page sync in pages", paging],
];
