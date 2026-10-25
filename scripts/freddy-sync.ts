/**
 * End-to-end check on your own computer: real freddy endpoint -> parser -> real migrations -> SQLite.
 *
 *   node --env-file=.env --import tsx scripts/freddy-sync.ts            # in-memory, thrown away
 *   node --env-file=.env --import tsx scripts/freddy-sync.ts --db health.sqlite   # keep a file
 *
 * Prints counts, ranges and warnings only. It never prints the URL, the key, or health values.
 * (*.sqlite is git-ignored.)
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { SqlDriver, SqlValue } from "../src/db/driver";
import { migrate, parseMigrations } from "../src/db/migrate";
import { loadCursor, saveSyncState, upsertSamples } from "../src/db/samples";
import { FreddySource } from "../src/sources/freddy";
import { McpHttpCaller } from "../src/sources/mcpHttp";

function openDb(path: string): SqlDriver {
  const raw = new DatabaseSync(path);
  return {
    async exec(sql) {
      raw.exec(sql);
    },
    async run(sql, params = []) {
      raw.prepare(sql).run(...(params as SqlValue[]));
    },
    async all<T>(sql: string, params: SqlValue[] = []) {
      return raw.prepare(sql).all(...params).map((r) => ({ ...r })) as T[];
    },
  };
}

function loadMigrations() {
  const dir = join(import.meta.dirname, "../src/db/migrations");
  const files: Record<string, string> = {};
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql"))) files[`./migrations/${f}`] = readFileSync(join(dir, f), "utf8");
  return parseMigrations(files);
}

async function main() {
  const url = process.env.FREDDY_MCP_URL;
  const apiKey = process.env.FREDDY_MCP_KEY;
  if (!url) throw new Error("FREDDY_MCP_URL is empty. Fill .env and run with --env-file=.env");

  const dbArg = process.argv.indexOf("--db");
  const dbPath = dbArg > -1 ? process.argv[dbArg + 1] : ":memory:";
  const db = openDb(dbPath);
  const applied = await migrate(db, loadMigrations());
  console.log(`database: ${dbPath === ":memory:" ? "in memory" : dbPath}; migrations applied now: ${applied.length}`);

  const source = new FreddySource({ caller: new McpHttpCaller({ url, apiKey }) });
  const cursor = await loadCursor(db, source.id);
  console.log(`cursor before: ${cursor ?? "(none, first sync)"}`);

  const res = await source.fetchSince(cursor);
  const written = await upsertSamples(db, res.samples);
  await saveSyncState(db, source.id, res.nextCursor);
  console.log(`samples fetched and stored: ${written}`);

  const summary = await db.all<{ metrics: number; first: string; last: string }>(
    `SELECT COUNT(DISTINCT metric) AS metrics, MIN(substr(external_id,1,10)) AS first, MAX(substr(external_id,1,10)) AS last FROM health_samples`,
  );
  const s = summary[0];
  if (s.metrics > 0) {
    console.log(`distinct metrics: ${s.metrics}; local days covered: ${s.first} to ${s.last}`);
    const byFamily = await db.all<{ family: string; n: number }>(
      `SELECT CASE WHEN instr(metric,'_')>0 THEN substr(metric,1,instr(metric,'_')-1) ELSE metric END AS family, COUNT(*) AS n
       FROM health_samples GROUP BY family ORDER BY n DESC`,
    );
    console.log("rows per metric family: " + byFamily.map((r) => `${r.family}=${r.n}`).join(", "));
    const text = await db.all<{ n: number }>("SELECT COUNT(*) AS n FROM health_samples WHERE value_num IS NULL");
    console.log(`rows kept as text (not read as a number): ${text[0].n}`);
  }
  console.log(`cursor after: ${res.nextCursor}`);
  for (const w of res.warnings ?? []) console.log(`WARNING: ${w}`);

  // Idempotency check: a second run must not add rows.
  const before = (await db.all<{ n: number }>("SELECT COUNT(*) AS n FROM health_samples"))[0].n;
  await upsertSamples(db, res.samples);
  const after = (await db.all<{ n: number }>("SELECT COUNT(*) AS n FROM health_samples"))[0].n;
  console.log(`re-sync adds rows: ${after - before} (should be 0)`);
}

main().catch((e) => {
  console.error(`FAILED: ${(e as Error).message}`);
  process.exit(1);
});
