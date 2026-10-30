/**
 * Sync test on the simulated phones (scripts/phone-sim.ts): two phone containers of one account,
 * each with its own database, sync through the `sync` and `db` containers and must end up holding
 * the same rows, also after both were offline and edited the same rows meanwhile.
 *
 *   npm run docker:phones                                     db, sync, web, phone-a, phone-b
 *   docker compose --profile phones run --rm phones-check                      this test, inside the compose network
 *   npm run test:phones                                       the same from this PC (ports 8791, 8792)
 *   docker compose --profile phones restart phone-a phone-b && docker compose --profile phones run --rm phones-check --after-restart
 *
 * --after-restart also checks the phones kept their databases. Prints check names, counts and
 * short digests only, never row contents. Exit 1 on a failure.
 */
import { setTimeout as sleep } from "node:timers/promises";

const urls = (process.env.PHONE_URLS ?? "http://localhost:8791,http://localhost:8792").split(",").map((u) => u.trim());
const afterRestart = process.argv.includes("--after-restart");

interface State {
  name: string;
  digest: string;
  total: number;
  pending: number;
  lastError: string | null;
}

const failures: string[] = [];
const check = (ok: boolean, what: string) => {
  process.stdout.write(`${ok ? "ok  " : "FAIL"} ${what}\n`);
  if (!ok) failures.push(what);
};

async function call<T>(url: string, method: "GET" | "POST", path: string): Promise<{ status: number; body: T }> {
  const res = await fetch(`${url}${path}`, { method });
  return { status: res.status, body: (await res.json()) as T };
}
const state = (url: string) => call<State>(url, "GET", "/state").then((r) => r.body);
const states = () => Promise.all(urls.map(state));
const sync = async (url: string) => {
  const r = await call<{ error?: string }>(url, "POST", "/sync");
  if (r.status !== 200) throw new Error(`sync on ${url} failed: ${r.body.error}`);
};
/** Every phone syncs, then every phone again: after that each has pulled what the others pushed. */
const syncAll = async () => {
  for (let round = 0; round < 2; round++) for (const u of urls) await sync(u);
};
const same = (ss: State[]) => ss.every((s) => s.digest === ss[0]!.digest);
const short = (ss: State[]) => ss.map((s) => `${s.name} ${s.total} rows ${s.digest.slice(0, 8)}`).join(", ");

async function ready(url: string): Promise<boolean> {
  for (let i = 0; i < 90; i++) {
    if (
      await fetch(`${url}/health`).then(
        (r) => r.ok,
        () => false,
      )
    )
      return true;
    await sleep(1_000);
  }
  return false;
}

try {
  for (const u of urls) check(await ready(u), `${u} has joined the account`);
  if (afterRestart) for (const s of await states()) check(s.total > 0, `${s.name} kept its database across the restart (${s.total} rows)`);
  for (const u of urls) await call(u, "POST", "/online");

  await syncAll();
  let ss = await states();
  check(same(ss), `the phones start in step: ${short(ss)}`);

  for (const [i, u] of urls.entries()) {
    await call(u, "POST", "/write?n=20");
    await syncAll();
    ss = await states();
    check(same(ss) && ss.every((s) => s.pending === 0), `20 edits on phone ${i + 1} reach every phone: ${short(ss)}`);
  }

  // No network on either phone: syncs fail and the edits wait. Both write today's steps, so the
  // same row is edited on both, and the later edit must win everywhere once they are back.
  for (const u of urls) await call(u, "POST", "/offline");
  for (const u of urls) await call(u, "POST", "/write?n=30");
  const offline = await Promise.all(urls.map((u) => call<{ error?: string }>(u, "POST", "/sync")));
  check(
    offline.every((r) => r.status === 503),
    "a sync with no network fails",
  );
  ss = await states();
  check(
    ss.every((s) => s.pending > 0 && !!s.lastError),
    "offline edits stay queued and the error is kept for the Sync screen",
  );
  for (const u of urls) await call(u, "POST", "/online");
  await syncAll();
  ss = await states();
  check(same(ss) && ss.every((s) => s.pending === 0 && !s.lastError), `phones that were offline converge: ${short(ss)}`);
} catch (err) {
  check(false, `flow failed: ${(err as Error).message}`);
}
process.stdout.write(failures.length ? `${failures.length} check(s) failed\n` : "simulated phones in sync\n");
process.exit(failures.length ? 1 : 0);
