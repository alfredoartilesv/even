import { PGlite, type Transaction } from "@electric-sql/pglite";
import { createApp } from "../server/app";
import { AuthError } from "../server/accounts";
import { migrateServer } from "../server/migrate";
import { numbers, type Pg } from "../server/pg";
import { createStores } from "../server/stores";

/** Real Postgres in-process (PGlite, WebAssembly) behind the server's Pg interface: no Docker needed. */
export function pglitePg(): Pg {
  const db = new PGlite();
  const query =
    (q: PGlite | Transaction) =>
    async <T>(sql: string, params: unknown[] = []) =>
      (await q.query<Record<string, unknown>>(sql, params)).rows.map((r) => numbers(r)) as T[];
  return {
    query: query(db),
    tx: (fn) => db.transaction((t) => fn({ query: query(t) })),
    close: () => db.close(),
  };
}

/** Google stands in: a token "google:<subject>:<email>" is valid, anything else is not. */
async function fakeGoogle(idToken: string) {
  const [tag, subject, email] = idToken.split(":");
  if (tag !== "google" || !subject || !email) throw new AuthError(401, "Google did not confirm this account");
  return { subject, email };
}

/** A migrated server: the Hono app, its stores, and a fetch that calls the app in-process. Rate limits off unless asked for. */
export async function testServer(opts: { rateLimits?: boolean } = {}) {
  const pg = pglitePg();
  await migrateServer(pg);
  const stores = createStores(pg, { SERVER_SECRET: "test-secret" }, { google: fakeGoogle, rateLimits: opts.rateLimits ?? false });
  const app = createApp(stores);
  const fetchFn = ((input: string, init?: RequestInit) => app.request(input, init)) as typeof fetch;
  return { pg, stores, app, fetchFn, base: "http://sync.test" };
}
