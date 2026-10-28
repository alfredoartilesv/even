import type { Pg } from "./pg";
import { numbers, postgresJs } from "./pg";

/**
 * The server's database: Postgres at DATABASE_URL (the Docker `db` service, Neon on Vercel), or,
 * when it is not set, PGlite (real Postgres in WebAssembly) saved in PGLITE_DIR (default
 * .data/pglite, git-ignored): `npm run dev:web` without Docker. One process at a time on PGlite.
 */
export async function openDb(env: { DATABASE_URL?: string; PGLITE_DIR?: string }, opts: { max?: number } = {}): Promise<Pg> {
  if (env.DATABASE_URL) return postgresJs(env.DATABASE_URL, opts);
  return pglitePg(env.PGLITE_DIR ?? ".data/pglite");
}

/** PGlite behind the Pg interface. `dir` undefined is in memory (the tests). */
export async function pglitePg(dir?: string): Promise<Pg> {
  const { PGlite } = await import("@electric-sql/pglite");
  if (dir) (await import("node:fs")).mkdirSync(dir, { recursive: true });
  const db = new PGlite(dir);
  type Q = { query<R>(sql: string, params?: unknown[]): Promise<{ rows: R[] }> };
  const query =
    (q: Q) =>
    async <T>(sql: string, params: unknown[] = []) =>
      (await q.query<Record<string, unknown>>(sql, params)).rows.map((r) => numbers(r)) as T[];
  return {
    query: query(db),
    tx: (fn) => db.transaction((t) => fn({ query: query(t) })),
    close: () => db.close(),
  };
}
