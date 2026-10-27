import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { SqlDriver, SqlValue } from "../../src/db/driver";
import { migrate, parseMigrations, type Migration } from "../../src/db/migrate";

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

/** The app's migrations, read from src/db/migrations (the app bundles them with import.meta.glob). */
export function diskMigrations(): Migration[] {
  const dir = join(import.meta.dirname, "../../src/db/migrations");
  const files: Record<string, string> = {};
  for (const name of readdirSync(dir).filter((n) => n.endsWith(".sql"))) files[`./migrations/${name}`] = readFileSync(join(dir, name), "utf8");
  return parseMigrations(files);
}

/** A node:sqlite database brought up to the app's schema. */
export async function migratedNodeDb(path = ":memory:", opts: { foreignKeys?: boolean } = {}): Promise<{ db: SqlDriver; raw: DatabaseSync }> {
  const out = nodeDb(path, opts);
  await migrate(out.db, diskMigrations());
  return out;
}
