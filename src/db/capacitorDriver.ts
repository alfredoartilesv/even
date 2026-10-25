import type { SQLiteDBConnection } from "@capacitor-community/sqlite";
import type { SqlDriver, SqlValue } from "./driver";

/** The slice of the plugin connection the driver uses; tests fake exactly this. */
export type PluginConnection = Pick<
  SQLiteDBConnection,
  "execute" | "run" | "query" | "beginTransaction" | "commitTransaction" | "rollbackTransaction"
>;

const TXN = /^(BEGIN|COMMIT|END|ROLLBACK)(\s+TRANSACTION)?\s*;?$/i;

/**
 * SqlDriver on top of @capacitor-community/sqlite.
 *
 * Plugin quirks handled here:
 * - execute() and run() wrap each call in their own transaction by default. migrate() and
 *   upsertSamples() manage transactions themselves, so we always pass transaction=false
 *   and map BEGIN/COMMIT/ROLLBACK onto the plugin's transaction calls.
 * - Android's execute() splits statements on ";\n" and runs each one alone, so CRLF input
 *   (a Windows checkout) would collapse into one statement and silently drop the rest.
 * - iOS query() may prepend a { ios_columns: [...] } row.
 */
export function capacitorDriver(conn: PluginConnection): SqlDriver {
  return {
    async exec(sql) {
      const m = TXN.exec(sql.trim());
      if (m) {
        const verb = m[1].toUpperCase();
        if (verb === "BEGIN") await conn.beginTransaction();
        else if (verb === "ROLLBACK") await conn.rollbackTransaction();
        else await conn.commitTransaction();
        return;
      }
      await conn.execute(sql.replace(/\r\n?/g, "\n"), false);
    },
    async run(sql, params: SqlValue[] = []) {
      await conn.run(sql, params, false, "no");
    },
    async all<T>(sql: string, params: SqlValue[] = []) {
      const res = await conn.query(sql, params);
      const rows = (res.values ?? []) as Record<string, unknown>[];
      return (rows[0] && "ios_columns" in rows[0] ? rows.slice(1) : rows) as T[];
    },
  };
}
