import type { SqlDriver } from "./driver";
import { createLogger } from "../core/log";

const log = createLogger("db");

const depth = new WeakMap<SqlDriver, number>();

/** Whether a withTransaction is open on this driver: a plain write now would join it, and go with its rollback. */
export const inTransaction = (db: SqlDriver): boolean => depth.has(db);

/**
 * Run fn inside BEGIN / COMMIT, rolling back if it throws. The Capacitor driver maps these
 * onto the plugin's transaction calls. A call made inside another withTransaction on the same
 * driver joins the outer transaction (SQLite cannot nest BEGIN), so an error anywhere rolls
 * back the whole unit.
 */
export async function withTransaction<T>(db: SqlDriver, fn: () => Promise<T>): Promise<T> {
  const d = depth.get(db) ?? 0;
  if (d > 0) {
    depth.set(db, d + 1);
    try {
      return await fn();
    } finally {
      depth.set(db, d);
    }
  }
  await db.exec("BEGIN");
  depth.set(db, 1);
  try {
    const out = await fn();
    await db.exec("COMMIT");
    return out;
  } catch (err) {
    await db.exec("ROLLBACK");
    log.debug("transaction rolled back", { err });
    throw err;
  } finally {
    depth.delete(db);
  }
}
