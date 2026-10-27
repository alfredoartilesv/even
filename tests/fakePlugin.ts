import { DatabaseSync } from "node:sqlite";
import type { PluginConnection } from "../src/platform/sqlite";
import type { SqlValue } from "../src/db/driver";

/**
 * node:sqlite dressed up as the plugin's Android connection: execute() splits on ";\n",
 * strips "--" comments and runs each piece as ONE statement (like execSQL), and both
 * execute() and run() open their own transaction unless told not to.
 */
export function fakePlugin(opts: { iosColumns?: boolean } = {}) {
  const raw = new DatabaseSync(":memory:");
  const calls: string[] = [];
  const firstStatement = (sql: string) => {
    const stmt = raw.prepare(sql); // prepare() rejects trailing statements, like execSQL ignores them
    stmt.run();
  };
  const wrap = async <T>(transaction: boolean | undefined, fn: () => T) => {
    if (transaction ?? true) raw.exec("BEGIN");
    try {
      const out = fn();
      if (transaction ?? true) raw.exec("COMMIT");
      return out;
    } catch (err) {
      if (transaction ?? true) raw.exec("ROLLBACK");
      throw err;
    }
  };
  const conn: PluginConnection = {
    async execute(statements, transaction) {
      calls.push(`execute:${transaction}`);
      return wrap(transaction, () => {
        for (const piece of statements.split(";\n")) {
          const sql = piece
            .split("\n")
            .map((l) => l.trim().replace(/--.*$/, ""))
            .filter(Boolean)
            .join(" ");
          if (sql) firstStatement(sql);
        }
        return { changes: { changes: 0 } };
      });
    },
    async run(statement, values, transaction) {
      calls.push(`run:${transaction}`);
      return wrap(transaction, () => {
        raw.prepare(statement).run(...((values ?? []) as SqlValue[]));
        return { changes: { changes: 1 } };
      });
    },
    async query(statement, values) {
      const rows = raw
        .prepare(statement)
        .all(...((values ?? []) as SqlValue[]))
        .map((r) => ({ ...r }));
      return { values: opts.iosColumns ? [{ ios_columns: Object.keys(rows[0] ?? {}) }, ...rows] : rows };
    },
    async beginTransaction() {
      calls.push("begin");
      raw.exec("BEGIN");
      return { changes: { changes: 0 } };
    },
    async commitTransaction() {
      calls.push("commit");
      raw.exec("COMMIT");
      return { changes: { changes: 0 } };
    },
    async rollbackTransaction() {
      calls.push("rollback");
      raw.exec("ROLLBACK");
      return { changes: { changes: 0 } };
    },
  };
  return { conn, raw, calls };
}
