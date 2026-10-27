import { diskMigrations, nodeDb } from "../scripts/lib/nodeDb";
import { migrate, type Migration } from "../src/db/migrate";

/** In-memory SQLite behind the same SqlDriver interface the app uses. */
export function memoryDriver() {
  return nodeDb(":memory:");
}

/** The real migration files from src/db/migrations. */
let cached: Migration[] | null = null;
export function realMigrations(): Migration[] {
  // Read once per test process: most tests build a fresh migrated database.
  cached ??= diskMigrations();
  // Copies, so a test that edits one (CRLF, a failing migration) cannot change the next test's.
  return cached.map((m) => ({ ...m }));
}

export async function migratedDb() {
  const { db, raw } = memoryDriver();
  await migrate(db, realMigrations());
  return { db, raw };
}
