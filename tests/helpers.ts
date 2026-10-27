import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { nodeDb } from "../scripts/lib/nodeDb";
import { migrate, parseMigrations } from "../src/db/migrate";

/** In-memory SQLite behind the same SqlDriver interface the app uses. */
export function memoryDriver() {
  return nodeDb(":memory:");
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
