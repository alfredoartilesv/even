import type { SqlDriver } from "../../src/db/driver";
import { cloudSync, type CloudSyncReport, type SyncTransport } from "../../src/features/cloudsync/cloudSync";
import { syncKeys, SYNC_SECRET_BYTES } from "../../src/features/cloudsync/seal";
import { httpTransport } from "../../src/features/cloudsync/transport";
import { migratedNodeDb } from "./nodeDb";

/**
 * Two of the owner's phones, each with its own migrated database, syncing through one server.
 * The unit tests run it against the Hono app on PGlite (tests/cloudSync.test.ts); the smoke test
 * runs it against the `sync` and `db` Docker containers (scripts/sync-smoke.ts).
 */
export interface Phone {
  name: string;
  db: SqlDriver;
  server: SyncTransport;
  sync(nowMs?: number): Promise<CloudSyncReport>;
}

/** `fetchFn` reaches the server: real HTTP, or Hono's app.request in-process. */
export async function phone(name: string, baseUrl: string, token: string, secret: Uint8Array, fetchFn?: typeof fetch): Promise<Phone> {
  const server = httpTransport(baseUrl, token, fetchFn);
  const keys = await syncKeys(secret);
  const { db } = await migratedNodeDb(":memory:", { foreignKeys: true });
  return { name, db, server, sync: (nowMs) => cloudSync(db, server, keys, nowMs) };
}

export const newSecret = () => crypto.getRandomValues(new Uint8Array(SYNC_SECRET_BYTES));

export async function addFood(p: Phone, id: string, name: string, kcal: number, nowMs: number): Promise<void> {
  await p.db.run(
    `INSERT INTO food_entries (id, eaten_at_ms, offset_min, name, meal, calories, created_at, updated_at, origin_device_id)
     VALUES (?, ?, 0, ?, 'lunch', ?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET name = excluded.name, calories = excluded.calories, updated_at = excluded.updated_at`,
    [id, nowMs, name, kcal, nowMs, nowMs, p.name],
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
    "a row written on phone A reaches phone B",
  );
  await addFood(b, "food-1", "oats and milk", 450, t0 + 10);
  await b.sync(t0 + 11);
  await a.sync(t0 + 12);
  check((await foods(a)).find((f) => f.id === "food-1")?.calories === 450, "an edit on phone B reaches phone A");
  return failures;
}
