import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { nodeDb } from "../scripts/lib/nodeDb";
import { migrate, parseMigrations } from "../src/db/migrate";

/** In-memory SQLite behind the same SqlDriver interface the app uses. */
export function memoryDriver() {
  return nodeDb(":memory:");
}

/** The real migration files from src/db/migrations. */
let cached: ReturnType<typeof parseMigrations> | null = null;
export function realMigrations() {
  // Read once per test process: most tests build a fresh migrated database.
  if (!cached) {
    const dir = join(import.meta.dirname, "../src/db/migrations");
    const files: Record<string, string> = {};
    for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql"))) {
      files[`./migrations/${f}`] = readFileSync(join(dir, f), "utf8");
    }
    cached = parseMigrations(files);
  }
  // Copies, so a test that edits one (CRLF, a failing migration) cannot change the next test's.
  return cached.map((m) => ({ ...m }));
}

export async function migratedDb() {
  const { db, raw } = memoryDriver();
  await migrate(db, realMigrations());
  return { db, raw };
}
