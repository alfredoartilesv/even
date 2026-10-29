/**
 * A phone database on the PC, synced with the sync server: the same migrations, keys and sync code
 * as the app, in a node:sqlite file instead of SQLCipher on the phone. For trying sync by hand.
 *
 *   npm run sync:phone -- --db out/phone-a.sqlite
 *
 * Reads from .env: SYNC_URL (default http://localhost:8787), SYNC_EMAIL and SYNC_PASSPHRASE of an
 * account made in the app or the web (docs/users.md). Joins as a "pc" device each run. Prints counts only.
 */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { memorySecretStore } from "../src/core/secretStore";
import { disconnect, signInWithPassphrase } from "../src/domain/cloudsync/session";
import { syncNow } from "../src/domain/cloudsync/syncNow";
import { migratedNodeDb } from "./lib/nodeDb";

const args = process.argv.slice(2);
const path = args.includes("--db") ? args[args.indexOf("--db") + 1] : "out/phone.sqlite";
const { SYNC_URL = "http://localhost:8787", SYNC_EMAIL, SYNC_PASSPHRASE } = process.env;
if (!SYNC_EMAIL || !SYNC_PASSPHRASE) throw new Error("Set SYNC_EMAIL and SYNC_PASSPHRASE in .env (an account made in the app or on the web)");

mkdirSync(dirname(path), { recursive: true });
const { db } = await migratedNodeDb(path, { foreignKeys: true });
const store = memorySecretStore();
const session = await signInWithPassphrase(SYNC_URL, store, { email: SYNC_EMAIL, passphrase: SYNC_PASSPHRASE, device: { name: `PC (${path})`, kind: "pc" } });
try {
  const r = await syncNow(db, session, { today: new Date().toISOString().slice(0, 10) });
  process.stdout.write(
    `${path}: pushed ${r.pushed} (${r.accepted} new), pulled ${r.pulled}, too large ${r.tooLarge}, rejected ${r.rejected}, friend days ${r.shared}\n`,
  );
} finally {
  // One device per run would pile up: this one leaves again.
  await disconnect(store, session);
}
