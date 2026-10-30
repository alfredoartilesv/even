/**
 * A simulated phone for the sync tests: the app's database (node:sqlite, its migrations, in a file
 * that survives restarts), its sync code and a bit of daily use, in one container per phone
 * (docker-compose.yml, profile `phones`). scripts/sync-phones.ts drives them through this control API:
 *
 *   GET  /health     200 once the phone has joined the account
 *   GET  /state      row counts per synced table, a digest of every synced row, rows waiting, last sync
 *   POST /write?n=5  n random edits as the owner would make them (food, drinks, today's steps)
 *   POST /sync       one full sync, as the Sync button does; 503 with the error when it fails
 *   POST /offline    every request to the server fails from now on, as with no network
 *   POST /online
 *
 * Env: PHONE_NAME, PHONE_ROLE (`first` makes the account from an invite, needs DATABASE_URL;
 * `join` signs in by passphrase), SYNC_URL, SIM_EMAIL, SIM_PASSPHRASE, PHONE_DB (default
 * /data/<name>.sqlite), PORT (8790), SIM_EVERY_MS (write and sync on a timer; 0, the default, waits
 * for the API). Logs and answers counts and hashes only, never row contents.
 */
import { createServer } from "node:http";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createLogger, setLogLevel } from "../src/core/log";
import { memorySecretStore } from "../src/core/secretStore";
import { syncApi, SyncHttpError } from "../src/domain/cloudsync/api";
import { pendingPush } from "../src/domain/cloudsync/cloudSync";
import { disconnect } from "../src/domain/cloudsync/session";
import { lastCloudSync } from "../src/domain/cloudsync/syncNow";
import { accountStore } from "../server/accounts";
import { postgresJs } from "../server/pg";
import { addFood, byPassphrase, firstPhone, syncedDigest, TEST_PASSPHRASE, type Phone, type Server } from "./lib/syncScenario";

const log = createLogger("phone-sim");
setLogLevel((process.env.LOG_LEVEL as never) ?? "info");

const env = process.env;
const name = env.PHONE_NAME ?? "phone";
const role = env.PHONE_ROLE ?? "join";
const base = env.SYNC_URL ?? "http://localhost:8787";
const email = env.SIM_EMAIL ?? "phones@even.invalid";
const passphrase = env.SIM_PASSPHRASE ?? TEST_PASSPHRASE;
const dbPath = env.PHONE_DB ?? `/data/${name}.sqlite`;
const port = Number(env.PORT ?? 8790);
const every = Number(env.SIM_EVERY_MS ?? 0);

let online = true;
const server: Server = {
  base,
  fetchFn: (...a) => (online ? fetch(...a) : Promise.reject(new TypeError("fetch failed: the simulated phone is offline"))),
};
const today = () => new Date().toISOString().slice(0, 10);

// Each write gets its own millisecond, so last write wins never meets a tie on this phone.
let lastStamp = 0;
const stamp = () => (lastStamp = Math.max(Date.now(), lastStamp + 1));

async function waitForServer(): Promise<void> {
  for (let i = 0; ; i++) {
    if (
      await syncApi(base)
        .health()
        .then(
          () => true,
          () => false,
        )
    )
      return;
    if (i === 60) throw new Error("the sync server did not answer in 60 s");
    await new Promise((r) => setTimeout(r, 1_000));
  }
}

/** Signs in by passphrase; the `first` phone makes the account when there is none yet, the others wait for it. */
async function join(): Promise<Phone> {
  mkdirSync(dirname(dbPath), { recursive: true });
  const opts = { dbPath, today, kind: "phone" as const };
  for (let i = 0; ; i++) {
    try {
      return await byPassphrase(server, email, name, passphrase, opts);
    } catch (err) {
      if (!(err instanceof Error) || i === 60) throw err;
      // A 4xx is "no such account" (or a wrong passphrase, which the invite then also refuses); 0 and 5xx are worth waiting out.
      if (role === "first" && err instanceof SyncHttpError && err.status >= 400 && err.status < 500 && err.status !== 429) {
        if (!env.DATABASE_URL) throw new Error("PHONE_ROLE=first needs DATABASE_URL to make the invite", { cause: err });
        const pg = postgresJs(env.DATABASE_URL, { max: 1 });
        try {
          const code = await accountStore(pg, { serverSecret: env.SERVER_SECRET ?? "even-local-only" }).createInvite(email);
          log.info("making the account", { name });
          return await firstPhone(server, code, email, name, { dbPath, today });
        } finally {
          await pg.close();
        }
      }
      await new Promise((r) => setTimeout(r, 1_000));
    }
  }
}

const pick = <T>(xs: T[]): T => xs[Math.floor(Math.random() * xs.length)]!;

/** One edit the owner could make on this phone. Ids are this phone's own, so rows from the two phones never collide by chance. */
async function useOnce(p: Phone): Promise<void> {
  const now = stamp();
  const live = await p.db.all<{ id: string }>("SELECT id FROM food_entries WHERE deleted_at IS NULL");
  const action = pick(live.length ? ["food", "food", "edit", "delete", "drink", "steps"] : ["food", "drink", "steps"]);
  if (action === "food")
    await addFood(p, `${name}-${crypto.randomUUID()}`, pick(["oats", "rice", "salad", "soup"]), 100 + Math.round(Math.random() * 600), now);
  else if (action === "edit")
    await p.db.run("UPDATE food_entries SET calories = ?, updated_at = ? WHERE id = ?", [Math.round(Math.random() * 900), now, pick(live).id]);
  else if (action === "delete") await p.db.run("UPDATE food_entries SET deleted_at = ?, updated_at = ? WHERE id = ?", [now, now, pick(live).id]);
  else if (action === "drink")
    await p.db.run(
      `INSERT INTO drink_entries (id, drunk_at_ms, name, volume_ml, abv_percent, created_at, updated_at, origin_device_id) VALUES (?, ?, 'beer', 330, 5, ?, ?, ?)`,
      [`${name}-${crypto.randomUUID()}`, now, now, now, name],
    );
  // Both phones read the same watch: today's steps share one natural key, and the newer reading must win everywhere.
  else
    await p.db.run(
      `INSERT INTO health_samples (id, source, device, external_id, metric, start_ms, value_num, created_at, updated_at)
       VALUES (?, 'garmin', 'sim-watch', ?, 'daily_steps', ?, ?, ?, ?)
       ON CONFLICT (source, device, metric, external_id) DO UPDATE SET value_num = excluded.value_num, updated_at = excluded.updated_at`,
      [crypto.randomUUID(), today(), Date.parse(today()), Math.round(Math.random() * 15_000), now, now],
    );
}

async function state(p: Phone) {
  const [{ digest, rows }, pending, last] = await Promise.all([syncedDigest(p.db), pendingPush(p.db), lastCloudSync(p.db)]);
  return { name, online, digest, rows, total: Object.values(rows).reduce((s, n) => s + n, 0), pending, lastSyncMs: last.at, lastError: last.error };
}

await waitForServer();
const phone = await join();
log.info("phone joined", { name, role, rows: (await state(phone)).total });

// One request at a time, as on the phone: a write never lands in the middle of a sync.
let queue: Promise<unknown> = Promise.resolve();
const serial = <T>(f: () => Promise<T>): Promise<T> => {
  const next = queue.then(f, f);
  queue = next.catch(() => undefined);
  return next;
};

async function syncOnce() {
  const done = log.time("sync");
  const r = await phone.sync(stamp());
  done({ pushed: r.pushed, pulled: r.pulled, rejected: r.rejected });
  return r;
}

const http = createServer((req, res) => {
  const reply = (status: number, body: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
  const url = new URL(req.url ?? "/", "http://phone");
  const route = `${req.method} ${url.pathname}`;
  const handle = async () => {
    if (route === "GET /health") return reply(200, { ok: true, name });
    if (route === "GET /state") return reply(200, await serial(() => state(phone)));
    if (route === "POST /offline" || route === "POST /online") {
      online = route === "POST /online";
      log.info(online ? "online" : "offline", { name });
      return reply(200, { online });
    }
    if (route === "POST /write") {
      const n = Math.min(Math.max(Number(url.searchParams.get("n") ?? 1), 1), 1_000);
      await serial(async () => {
        for (let i = 0; i < n; i++) await useOnce(phone);
      });
      return reply(200, { written: n });
    }
    if (route === "POST /sync") {
      try {
        return reply(200, await serial(syncOnce));
      } catch (err) {
        log.warn("sync failed", { name, err: (err as Error).name });
        return reply(503, { error: (err as Error).message });
      }
    }
    reply(404, { error: "no such route" });
  };
  handle().catch((err: Error) => reply(500, { error: err.message }));
});
http.listen(port, "0.0.0.0", () => log.info("control API listening", { name, port }));

if (every > 0)
  setInterval(
    () =>
      void serial(async () => {
        await useOnce(phone);
        if (online) await syncOnce().catch(() => undefined);
      }),
    every,
  );

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    // The session lives in memory only (secrets never go in a file): a restarted phone signs in
    // again as a new device, so this one leaves the account's device list on the way out.
    log.info("phone stopping", { name, signal });
    http.close();
    void disconnect(memorySecretStore(), phone.session, { fetchFn: server.fetchFn })
      .catch(() => undefined)
      .then(() => process.exit(0));
  });
}
