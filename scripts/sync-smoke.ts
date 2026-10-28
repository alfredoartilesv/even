/**
 * End-to-end check of the sync environment: the `sync` container on the `db` container (or the
 * Vercel deployment on Neon). Registers two throwaway devices for a throwaway owner, then two
 * fresh phone databases sync through the real server and must see each other's writes.
 *
 *   docker compose up -d --wait && docker compose run --rm sync npm run test:sync
 *   SYNC_URL=https://<app>.vercel.app DATABASE_URL=<neon url> npm run test:sync
 *
 * Prints check names only, never row contents. Exit code 1 when a check fails.
 */
import { postgresJs } from "../server/pg";
import { syncStore } from "../server/store";
import { newSecret, phone, roundTrip } from "./lib/syncScenario";

const base = process.env.SYNC_URL ?? "http://localhost:8787";
const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is not set (it registers the test devices)");

const failures: string[] = [];
const check = (ok: boolean, what: string) => {
  process.stdout.write(`${ok ? "ok  " : "FAIL"} ${what}\n`);
  if (!ok) failures.push(what);
};

const pg = postgresJs(url, { max: 1 });
const store = syncStore(pg);
const owner = `smoke-${crypto.randomUUID()}`;
try {
  check((await fetch(`${base}/health`)).ok, "GET /health answers");
  check((await fetch(`${base}/v1/pull`, { headers: { authorization: "Bearer not-a-token" } })).status === 401, "an unknown token is refused");
  const [da, db] = [await store.addDevice(owner, "smoke-a"), await store.addDevice(owner, "smoke-b")];
  const secret = newSecret();
  const a = await phone("smoke-a", base, da.token, secret);
  const b = await phone("smoke-b", base, db.token, secret);
  const missed = await roundTrip(a, b);
  check(missed.length === 0, `two phone databases sync through the server${missed.length ? `: ${missed.join("; ")}` : ""}`);
  await store.revokeDevice(da.id);
  check((await fetch(`${base}/v1/pull`, { headers: { authorization: `Bearer ${da.token}` } })).status === 401, "a revoked device is refused");
} finally {
  // The throwaway owner's rows and devices go; nothing else is touched.
  await pg.query("DELETE FROM sync_rows WHERE owner_id = $1", [owner]);
  await pg.query("DELETE FROM devices WHERE owner_id = $1", [owner]);
  await pg.close();
}
process.stdout.write(failures.length ? `${failures.length} check(s) failed\n` : "sync environment OK\n");
process.exit(failures.length ? 1 : 0);
