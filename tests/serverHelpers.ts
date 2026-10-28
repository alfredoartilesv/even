import { PGlite, type Transaction } from "@electric-sql/pglite";
import { createApp } from "../server/app";
import { migrateServer } from "../server/migrate";
import { numbers, type Pg } from "../server/pg";
import { syncStore } from "../server/store";

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

/** A migrated server: the Hono app, its store, and a fetch that calls the app in-process. */
export async function testServer() {
  const pg = pglitePg();
  await migrateServer(pg);
  const store = syncStore(pg);
  const app = createApp(store);
  const fetchFn = ((input: string, init?: RequestInit) => app.request(input, init)) as typeof fetch;
  return { pg, store, app, fetchFn, base: "http://sync.test" };
}
