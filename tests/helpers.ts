import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { SqlDriver, SqlValue } from "../src/db/driver";
import { migrate, parseMigrations } from "../src/db/migrate";

/** In-memory SQLite behind the same SqlDriver interface the app uses. */
export function memoryDriver(): { db: SqlDriver; raw: DatabaseSync } {
  const raw = new DatabaseSync(":memory:");
  const db: SqlDriver = {
    async exec(sql) {
      raw.exec(sql);
    },
    async run(sql, params = []) {
      raw.prepare(sql).run(...(params as SqlValue[]));
    },
    async all<T>(sql: string, params: SqlValue[] = []) {
      // node:sqlite returns null-prototype rows; normalise to plain objects.
      return raw.prepare(sql).all(...params).map((r) => ({ ...r })) as T[];
    },
  };
  return { db, raw };
}

/** The real migration files from src/db/migrations. */
export function realMigrations() {
  const dir = join(import.meta.dirname, "../src/db/migrations");
  const files: Record<string, string> = {};
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql"))) {
    files[`./migrations/${f}`] = readFileSync(join(dir, f), "utf8");
  }
  return parseMigrations(files);
}

export async function migratedDb() {
  const { db, raw } = memoryDriver();
  await migrate(db, realMigrations());
  return { db, raw };
}
