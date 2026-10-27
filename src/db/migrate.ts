import type { SqlDriver } from "./driver";
import { createLogger } from "../core/log";

const log = createLogger("db.migrate");

export interface Migration {
  /** Monotonic integer parsed from the file name, e.g. 0001_init.sql -> 1 */
  version: number;
  name: string;
  sql: string;
}

/** Turn { "./migrations/0001_init.sql": "<sql>" } into sorted Migration[]. */
export function parseMigrations(files: Record<string, string>): Migration[] {
  const out: Migration[] = [];
  for (const [path, sql] of Object.entries(files)) {
    const file = path.split("/").pop() ?? path;
    const m = /^(\d+)_(.+)\.sql$/.exec(file);
    if (!m) throw new Error(`Bad migration file name: ${file} (expected 0001_name.sql)`);
    out.push({ version: Number(m[1]), name: m[2], sql });
  }
  out.sort((a, b) => a.version - b.version);
  for (let i = 1; i < out.length; i++) {
    if (out[i].version === out[i - 1].version) {
      throw new Error(`Duplicate migration version ${out[i].version}`);
    }
  }
  return out;
}

/**
 * Apply pending migrations in order. Schema version lives in PRAGMA user_version.
 * Each migration runs in its own transaction, so a failure leaves the DB at the
 * last good version. Returns the versions that were applied.
 */
export async function migrate(db: SqlDriver, migrations: Migration[]): Promise<number[]> {
  const rows = await db.all<{ user_version: number }>("PRAGMA user_version");
  let current = Number(rows[0]?.user_version ?? 0);
  const applied: number[] = [];

  for (const m of migrations) {
    if (m.version <= current) continue;
    const done = log.time("migration applied", "info");
    await db.exec("BEGIN");
    try {
      await db.exec(m.sql);
      // PRAGMA cannot take bound parameters; version is a validated integer.
      await db.exec(`PRAGMA user_version = ${Math.trunc(m.version)}`);
      await db.exec("COMMIT");
    } catch (err) {
      await db.exec("ROLLBACK");
      log.error("migration failed, rolled back", { version: m.version, name: m.name, err });
      throw new Error(`Migration ${m.version}_${m.name} failed: ${(err as Error).message}`, { cause: err });
    }
    current = m.version;
    applied.push(m.version);
    done({ version: m.version, name: m.name });
  }
  log.debug("schema up to date", { version: current, applied: applied.length });
  return applied;
}
