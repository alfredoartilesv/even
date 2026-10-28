import postgres from "postgres";

/**
 * The little the server needs from Postgres. One implementation over postgres.js (Docker and
 * Neon on Vercel), one over PGlite in the tests (tests/serverHelpers.ts): real Postgres both times.
 */
export interface Pg {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  tx<T>(fn: (q: Pick<Pg, "query">) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/**
 * `prepare: false` because Neon's pooled URL is PgBouncer in transaction mode, which cannot keep
 * prepared statements; `max` 1 on Vercel, where every function instance has its own pool.
 */
export function postgresJs(url: string, opts: { max?: number } = {}): Pg {
  const sql = postgres(url, { prepare: false, max: opts.max ?? 5, onnotice: () => {}, types: { bigint: postgres.BigInt } });
  const asNumbers = <T>(rows: readonly Record<string, unknown>[]) => rows.map((r) => numbers(r)) as T[];
  const query =
    (q: postgres.Sql | postgres.TransactionSql) =>
    async <T>(text: string, params: unknown[] = []) =>
      asNumbers<T>(await q.unsafe(text, params as postgres.ParameterOrJSON<never>[]));
  return {
    query: query(sql),
    async tx(fn) {
      return (await sql.begin((t) => fn({ query: query(t) }))) as never;
    },
    close: () => sql.end({ timeout: 5 }),
  };
}

/** BIGINT columns arrive as bigint; every one the server stores (epoch ms, seq) fits in a number. */
export function numbers(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) out[k] = typeof v === "bigint" ? Number(v) : v;
  return out;
}
