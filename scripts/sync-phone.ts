/**
 * A phone database on the PC, synced with the sync server: the same migrations and sync code as
 * the app, in a node:sqlite file instead of SQLCipher on the phone. For trying sync by hand.
 *
 *   npm run sync:phone -- --db out/phone-a.sqlite
 *
 * Reads from .env: SYNC_URL (default http://localhost:8787), SYNC_TOKEN (npm run sync:device) and
 * SYNC_SECRET (64 hex characters, the same on every device of one owner; make one with
 * `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`). Prints counts only.
 */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { cloudSync } from "../src/features/cloudsync/cloudSync";
import { syncKeys } from "../src/features/cloudsync/seal";
import { httpTransport } from "../src/features/cloudsync/transport";
import { migratedNodeDb } from "./lib/nodeDb";

const args = process.argv.slice(2);
const path = args.includes("--db") ? args[args.indexOf("--db") + 1] : "out/phone.sqlite";
const { SYNC_URL = "http://localhost:8787", SYNC_TOKEN, SYNC_SECRET } = process.env;
if (!SYNC_TOKEN) throw new Error("SYNC_TOKEN is not set: npm run sync:device -- --owner <id> --name pc");
if (!SYNC_SECRET || !/^[0-9a-f]{64}$/i.test(SYNC_SECRET)) throw new Error("SYNC_SECRET must be 64 hex characters");

mkdirSync(dirname(path), { recursive: true });
const { db } = await migratedNodeDb(path, { foreignKeys: true });
const secret = Uint8Array.from(SYNC_SECRET.match(/../g)!.map((h) => parseInt(h, 16)));
const report = await cloudSync(db, httpTransport(SYNC_URL, SYNC_TOKEN), await syncKeys(secret));
process.stdout.write(`${path}: pushed ${report.pushed} (${report.accepted} new on the server), pulled ${report.pulled}, skipped ${report.skipped}\n`);
