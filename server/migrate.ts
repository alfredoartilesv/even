import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createLogger } from "../src/core/log";
import type { Pg } from "./pg";

const log = createLogger("server.migrate");

export interface ServerMigration {
  version: number;
  name: string;
  sql: string;
}

/** server/migrations/NNNN_name.sql, in order. Same rule as the phone's: never edit one that ran. */
export function serverMigrations(dir = join(import.meta.dirname, "migrations")): ServerMigration[] {
  return readdirSync(dir)
    .filter((f) => /^\d{4}_[a-z0-9_]+\.sql$/.test(f))
    .sort()
    .map((f) => ({ version: Number(f.slice(0, 4)), name: f.replace(/\.sql$/, ""), sql: readFileSync(join(dir, f), "utf8") }));
}

/** Applies the missing migrations, each in its own transaction with its schema_migrations row. */
export async function migrateServer(pg: Pg, migrations = serverMigrations()): Promise<number[]> {
  await pg.query("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at BIGINT NOT NULL)");
  const done = new Set((await pg.query<{ version: number }>("SELECT version FROM schema_migrations")).map((r) => r.version));
  const applied: number[] = [];
  for (const m of migrations) {
    if (done.has(m.version)) continue;
    await pg.tx(async (q) => {
      for (const statement of statements(m.sql)) await q.query(statement);
      await q.query("INSERT INTO schema_migrations (version, name, applied_at) VALUES ($1, $2, $3)", [m.version, m.name, Date.now()]);
    });
    applied.push(m.version);
  }
  if (applied.length) log.info("server migrations applied", { applied });
  return applied;
}

/** One statement per `;` at a line end: migration comments never hold a semicolon (CLAUDE.md). */
export function statements(sql: string): string[] {
  return sql
    .replace(/\r\n/g, "\n")
    .split(/;\s*$/m)
    .map((s) => s.replace(/^\s*--.*$/gm, "").trim())
    .filter(Boolean);
}
