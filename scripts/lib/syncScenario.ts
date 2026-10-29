import { memorySecretStore } from "../../src/core/secretStore";
import type { SqlDriver } from "../../src/db/driver";
import { approvePairing, createAccount, signInWithPassphrase, startPairing, type SyncSession } from "../../src/domain/cloudsync/session";
import { syncNow, type CloudSyncResult } from "../../src/domain/cloudsync/syncNow";
import { migratedNodeDb } from "./nodeDb";

/**
 * The owner's devices, each with its own migrated database (node:sqlite, the app's migrations),
 * joined to one account the ways docs/users.md describes, syncing through one server. The unit
 * tests run it on the Hono app over PGlite (tests/cloudSync.test.ts); the smoke test against the
 * `sync` and `db` containers, or a Vercel deployment (scripts/sync-smoke.ts).
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

async function device(name: string, session: SyncSession, server: Server): Promise<Phone> {
  const { db } = await migratedNodeDb(":memory:", { foreignKeys: true });
  return { name, db, session, sync: (nowMs) => syncNow(db, session, { fetchFn: server.fetchFn, today: "2026-10-28", nowMs }) };
}

/** A new account's first phone, from an invite. */
export async function firstPhone(server: Server, inviteCode: string, email: string, name = "a"): Promise<Phone> {
  const session = await createAccount(
    server.base,
    memorySecretStore(),
    { inviteCode, email, displayName: `Owner of ${name}`, passphrase: TEST_PASSPHRASE, device: { name, kind: "phone" } },
    { fetchFn: server.fetchFn, iterations: TEST_ITERATIONS },
  );
  return device(name, session, server);
}

/** Another device of the same account, by passphrase. */
export async function byPassphrase(server: Server, email: string, name = "b", passphrase = TEST_PASSPHRASE): Promise<Phone> {
  const session = await signInWithPassphrase(
    server.base,
    memorySecretStore(),
    { email, passphrase, device: { name, kind: "web" } },
    { fetchFn: server.fetchFn },
  );
  return device(name, session, server);
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

/** The round trip every environment must pass: A writes, B reads, B edits, A reads the edit. */
export async function roundTrip(a: Phone, b: Phone, t0 = Date.now()): Promise<string[]> {
  const failures: string[] = [];
  const check = (ok: boolean, what: string) => void (ok || failures.push(what));
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
}
