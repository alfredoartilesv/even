import { DatabaseSync } from "node:sqlite";
import type { SqlDriver, SqlValue } from "../../src/db/driver";

/**
 * node:sqlite behind the app's SqlDriver, for the PC scripts and the tests (the phone uses the
 * Capacitor plugin, src/platform/sqlite.ts). `raw` is the database itself, for checks the driver
 * does not offer (query plans, PRAGMAs).
 */
export function nodeDb(path = ":memory:", opts: { foreignKeys?: boolean } = {}): { db: SqlDriver; raw: DatabaseSync } {
  const raw = new DatabaseSync(path);
  if (opts.foreignKeys) raw.exec("PRAGMA foreign_keys = ON");
  const db: SqlDriver = {
    async exec(sql) {
      raw.exec(sql);
    },
    async run(sql, params = []) {
      raw.prepare(sql).run(...(params as SqlValue[]));
    },
    async all<T>(sql: string, params: SqlValue[] = []) {
      // node:sqlite returns null-prototype rows; plain objects compare and spread as expected.
      return raw
        .prepare(sql)
        .all(...params)
        .map((r) => ({ ...r })) as T[];
    },
  };
  return { db, raw };
}
