/**
 * End-to-end check on your own computer: real Garmin Personal API -> parser -> real migrations -> SQLite.
 *
 *   node --env-file=.env --import tsx scripts/garmin-sync.ts            # in-memory, thrown away
 *   node --env-file=.env --import tsx scripts/garmin-sync.ts --db health.sqlite   # keep a file
 *
 * Prints counts, ranges and warnings only. It never prints the key, the token, or health values.
 * (*.sqlite is git-ignored.)
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { nodeDb } from "./lib/nodeDb";
import { migrate, parseMigrations } from "../src/db/migrate";
import { loadCursor, saveSyncState, upsertSamples } from "../src/features/metrics/samples";
import { GarminApi, GarminSource } from "../src/features/sync/garmin";
import { setLogLevel } from "../src/core/log";

// Library logs go to stderr-ish console lines; LOG_LEVEL=debug for the detail.
setLogLevel((process.env.LOG_LEVEL as never) ?? "info");

function loadMigrations() {
  const dir = join(import.meta.dirname, "../src/db/migrations");
  const files: Record<string, string> = {};
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql"))) files[`./migrations/${f}`] = readFileSync(join(dir, f), "utf8");
  return parseMigrations(files);
}

async function main() {
  const apiKey = process.env.GARMIN_API_KEY?.trim();
  if (!apiKey) throw new Error("GARMIN_API_KEY is empty. Fill .env and run with --env-file=.env");

  const dbArg = process.argv.indexOf("--db");
  const dbPath = dbArg > -1 ? process.argv[dbArg + 1] : ":memory:";
  const db = nodeDb(dbPath).db;
  const applied = await migrate(db, loadMigrations());
  console.log(`database: ${dbPath === ":memory:" ? "in memory" : dbPath}; migrations applied now: ${applied.length}`);

  const source = new GarminSource({ api: new GarminApi({ apiKey }) });
  const cursor = await loadCursor(db, source.id);
  console.log(`cursor before: ${cursor ?? "(none, first sync)"}`);

  const res = await source.fetchSince(cursor);
  const written = await upsertSamples(db, res.samples);
  await saveSyncState(db, source.id, res.nextCursor);
  console.log(`samples fetched and stored: ${written}`);

  const summary = await db.all<{ metrics: number; first: string; last: string }>(
    `SELECT COUNT(DISTINCT metric) AS metrics, MIN(local_day) AS first, MAX(local_day) AS last FROM health_samples`,
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
