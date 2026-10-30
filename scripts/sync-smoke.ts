/**
 * End-to-end check of the sync environment: the `sync` container on the `db` container (or the
 * Vercel deployment on Neon). Makes a throwaway account from an invite, joins a second device by
 * pairing, and two fresh phone databases must pass the sync scenarios (scripts/lib/syncScenario.ts)
 * through the real server: a round trip, last write wins, a delete, paging.
 *
 *   docker compose up -d --wait && docker compose run --rm sync npm run test:sync
 *   SYNC_URL=https://<app>.vercel.app DATABASE_URL=<neon url> npm run test:sync
 *
 * Prints check names only, never row contents. The account is deleted at the end. Exit 1 on a failure.
 */
import { accountStore } from "../server/accounts";
import { postgresJs } from "../server/pg";
import { deleteAccount } from "../src/domain/cloudsync/session";
import { memorySecretStore } from "../src/core/secretStore";
import { byPairing, byPassphrase, firstPhone, SCENARIOS, type Phone } from "./lib/syncScenario";

const base = process.env.SYNC_URL ?? "http://localhost:8787";
const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is not set (it makes the throwaway invite)");

const failures: string[] = [];
const check = (ok: boolean, what: string) => {
  process.stdout.write(`${ok ? "ok  " : "FAIL"} ${what}\n`);
  if (!ok) failures.push(what);
};

const pg = postgresJs(url, { max: 1 });
const server = { base };
const email = `smoke-${crypto.randomUUID()}@even.invalid`;
let a: Phone | null = null;
try {
  check((await fetch(`${base}/health`)).ok, "GET /health answers");
  check((await fetch(`${base}/v1/me`, { headers: { authorization: "Bearer not-a-token" } })).status === 401, "an unknown token is refused");
  a = await firstPhone(server, await accountStore(pg, { serverSecret: process.env.SERVER_SECRET ?? "even-local-only" }).createInvite(email), email, "smoke-a");
  check(true, "an invite makes an account");
  const b = await byPairing(server, a, "smoke-b");
  check(b.session.adk === a.session.adk, "a second device joins by pairing code");
  // The scenarios the unit tests run on PGlite, here on real Postgres over HTTP. Each starts later than the last.
  let t0 = Date.now();
  for (const [name, scenario] of SCENARIOS) {
    const missed = await scenario(a, b, (t0 += 10_000));
    check(missed.length === 0, `${name}${missed.length ? `: ${missed.join("; ")}` : ""}`);
  }
  const c = await byPassphrase(server, email, "smoke-c");
  check(c.session.accountId === a.session.accountId, "a third device joins by passphrase");
} catch (err) {
  check(false, `flow failed: ${(err as Error).message}`);
} finally {
  if (a) await deleteAccount(memorySecretStore(), a.session).catch(() => check(false, "the throwaway account is deleted"));
  await pg.close();
}
process.stdout.write(failures.length ? `${failures.length} check(s) failed\n` : "sync environment OK\n");
process.exit(failures.length ? 1 : 0);
