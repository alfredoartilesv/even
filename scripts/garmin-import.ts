/**
 * Import a Garmin account export (the ZIP Garmin emails after "Export Your Data") on this PC,
 * and write an encrypted backup file to restore in the app (Settings -> Restore).
 *
 *   npm run import:garmin                                   # the one ZIP in imports/garmin/
 *   npm run import:garmin -- --zip path/to/export.zip
 *   npm run import:garmin -- --db health.sqlite             # also/instead keep a local SQLite file
 *   npm run import:garmin -- --no-backup --db health.sqlite # only the local file
 *   npm run import:garmin -- --dry-run                      # read and report only, write nothing
 *   ... --tz Europe/Madrid                                  # zone for days without an offset (default: this PC's)
 *
 * The backup password: GARMIN_BACKUP_PASSWORD in the environment, or typed when asked (hidden).
 * The backup goes to imports/garmin/ (git-ignored). Prints counts and date ranges only, never
 * health values. Re-running is safe: samples are upserted, so nothing is duplicated.
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setLogLevel } from "../src/core/log";
import type { SqlDriver, SqlValue } from "../src/db/driver";
import { migrate, parseMigrations } from "../src/db/migrate";
import { exportBackup } from "../src/features/backup/backup";
import { importGarminZip } from "../src/features/import/garminImport";

setLogLevel((process.env.LOG_LEVEL as never) ?? "warn");

const ROOT = join(import.meta.dirname, "..");
const IMPORT_DIR = join(ROOT, "imports", "garmin");

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i > -1 ? process.argv[i + 1] : undefined;
}

function openDb(path: string): SqlDriver {
  const raw = new DatabaseSync(path);
  raw.exec("PRAGMA foreign_keys = ON");
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

function findZip(): string {
  const given = arg("--zip");
  if (given) return given;
  const zips = readdirSync(IMPORT_DIR, { withFileTypes: true }).filter((f) => f.isFile() && f.name.toLowerCase().endsWith(".zip"));
  if (zips.length === 0) throw new Error(`No ZIP in ${IMPORT_DIR}. Put the Garmin export there, or pass --zip.`);
  if (zips.length > 1) throw new Error(`Several ZIPs in ${IMPORT_DIR}: pass --zip to pick one.`);
  return join(IMPORT_DIR, zips[0].name);
}

/** Read a password without echoing it. */
async function askHidden(prompt: string): Promise<string> {
  if (!process.stdin.isTTY) throw new Error("Set GARMIN_BACKUP_PASSWORD (no terminal to ask in)");
  process.stdout.write(prompt);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  return new Promise((resolve, reject) => {
    let s = "";
    const onData = (buf: Buffer) => {
      for (const ch of buf.toString("utf8")) {
        if (ch === "\r" || ch === "\n") {
          process.stdin.setRawMode(false);
          process.stdin.pause();
          process.stdin.off("data", onData);
          process.stdout.write("\n");
          return resolve(s);
        }
        if (ch === "\u0003") {
          process.stdin.setRawMode(false);
          return reject(new Error("Cancelled"));
        }
        if (ch === "\u007f" || ch === "\b") s = s.slice(0, -1);
        else s += ch;
      }
    };
    process.stdin.on("data", onData);
  });
}

async function main() {
  const zipPath = findZip();
  const dbPath = arg("--db");
  const dryRun = process.argv.includes("--dry-run");
  const backup = !dryRun && !process.argv.includes("--no-backup");
  if (dryRun && dbPath) throw new Error("--dry-run writes nothing: drop --db");
  if (!dryRun && !backup && !dbPath) throw new Error("--no-backup needs --db (otherwise nothing would be kept)");
  const timeZone = arg("--tz") ?? Intl.DateTimeFormat().resolvedOptions().timeZone;

  let password = "";
  if (backup) {
    password = process.env.GARMIN_BACKUP_PASSWORD ?? (await askHidden("Backup password (you will need it on the phone): "));
    if (password.length < 8) throw new Error("Use a backup password of at least 8 characters");
  }

  const db = openDb(dbPath ?? ":memory:");
  const dir = join(ROOT, "src", "db", "migrations");
  const files: Record<string, string> = {};
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql"))) files[`./migrations/${f}`] = readFileSync(join(dir, f), "utf8");
  await migrate(db, parseMigrations(files));

  console.log(`Reading ${zipPath.replace(ROOT, ".")} (days without an offset use ${timeZone})...`);
  const { written, parsed } = await importGarminZip(db, new Uint8Array(readFileSync(zipPath)), { timeZone });

  const r = parsed.report;
  const line = (label: string, k: (typeof r)["daily"], unit: string) =>
    console.log(`  ${label.padEnd(12)} ${String(k.imported).padStart(5)} ${unit} imported, ${k.skipped} skipped, from ${k.files} file(s)${k.firstDay ? `, ${k.firstDay} to ${k.lastDay}` : ""}`);
  line("Daily", r.daily, "days");
  line("Sleep", r.sleep, "nights");
  line("Weight", r.biometrics, "weigh-ins");
  line("VO2 max", r.vo2max, "values");
  line("Activities", r.activities, "activities");
  if (r.weightProfileValuesSkipped) console.log(`  (${r.weightProfileValuesSkipped} weight entries were profile settings, not weigh-ins: skipped)`);
  console.log(`  ${written} samples in ${parsed.catalog.length} metrics${dbPath ? `, stored in ${dbPath}` : ""}.`);

  if (backup) {
    const stamp = new Date().toISOString().slice(0, 10);
    const out = arg("--out") ?? join(IMPORT_DIR, `garmin-import-${stamp}.json`);
    const { text } = await exportBackup(db, password);
    writeFileSync(out, text);
    console.log(`\nEncrypted backup written: ${out.replace(ROOT, ".")}`);
    console.log("Copy it to the phone and restore it in the app (Settings -> Restore) with the same password.");
    console.log("Restore merges: data already on the phone stays, nothing is duplicated.");
  }
}

main().catch((e) => {
  console.error(`FAILED: ${(e as Error).message}`);
  process.exit(1);
});
