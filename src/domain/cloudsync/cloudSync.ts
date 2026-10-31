import type { SqlDriver, SqlValue } from "../../db/driver.js";
import { createLogger } from "../../core/log.js";
import { MAX_BLOB_CHARS, MAX_PUSH_BYTES, SYNC_PAGE, type PullResult, type PushResult, type SyncRow } from "../../core/syncWire.js";
import { BACKUP_TABLES, mergeRows, type BackupTable } from "../backup/backup.js";
import { PHOTO_KEY, PROFILE_KEY } from "../settings/profile.js";
import { open, rowKey, seal, type SyncKeys } from "./seal.js";

const log = createLogger("cloudsync");

/**
 * Phase 2 cloud sync (docs/architecture.md section 6, docs/users.md): push the rows this install
 * changed (the outbox the triggers of migration 0016 fill), then pull everyone else's, last write
 * wins per row on updated_at.
 *
 * Synced: every backed-up table except the ones about this install (Garmin cursors, sync runs and
 * the cloud sync bookkeeping itself). A table added here needs its two triggers in a migration;
 * tests/cloudSync.test.ts checks.
 */
const NOT_SYNCED = new Set(["sync_state", "sync_runs"]);
/**
 * Of app_settings, only the owner's profile and picture (migration 0018 queues just these): the
 * other keys hold this install's device id, backup dates and log level. A pulled row with any
 * other key is skipped, whatever the device that pushed it.
 */
export const SYNCED_SETTINGS: ReadonlySet<string> = new Set([PROFILE_KEY, PHOTO_KEY]);
export const SYNC_TABLES: BackupTable[] = BACKUP_TABLES.filter((t) => !t.deviceLocal && t.lastWriteWins && !NOT_SYNCED.has(t.name));
const SETTINGS_TABLE = SYNC_TABLES.find((t) => t.name === "app_settings")!;

/** The server, over HTTP on the phone (server/app.ts) or in-process in tests. */
export interface SyncTransport {
  push(rows: SyncRow[]): Promise<PushResult>;
  pull(after: number, limit: number): Promise<PullResult>;
  /**
   * Rows above `after` and below `before`, highest sequence number first: the rows pushed last,
   * which are the latest days, come first. `tbl` asks for one table only. A transport without it
   * (the health connector's, an older server) pulls oldest first.
   */
  pullNewest?(after: number, before: number | null, limit: number, tbl?: string): Promise<PullResult>;
}

export interface SyncOptions {
  /** Called after each pulled page is stored, so the screens can show it before the sync ends. */
  onProgress?: () => void;
}

export interface CloudSyncReport {
  pushed: number;
  accepted: number;
  pulled: number;
  /** Rows for tables this app version does not have; a newer app on another device wrote them. */
  skipped: number;
  /** Rows too big for one request (a long PDF in a chat): kept on this install only, for now. */
  tooLarge: number;
  /** Pulled rows that would not open (sealed with another secret) or merge (another schema). */
  rejected: number;
}

const emptyReport = (): CloudSyncReport => ({ pushed: 0, accepted: 0, pulled: 0, skipped: 0, tooLarge: 0, rejected: 0 });

export async function cloudSync(
  db: SqlDriver,
  server: SyncTransport,
  keys: SyncKeys,
  nowMs: number = Date.now(),
  opts: SyncOptions = {},
): Promise<CloudSyncReport> {
  const done = log.time("cloud sync", "info");
  const report = emptyReport();
  for (const t of SYNC_TABLES) await pushTable(db, server, keys, t, report);
  await pullAll(db, server, keys, report, nowMs, opts);
  if (report.tooLarge || report.rejected) log.warn("cloud sync left rows out", { tooLarge: report.tooLarge, rejected: report.rejected });
  done({ ...report });
  return report;
}

/**
 * Only the pull, newest first: what other devices wrote shows up before this device spends time
 * on Garmin or on pushing. The full cloudSync after it then finds little or nothing left to pull.
 */
export async function cloudPull(
  db: SqlDriver,
  server: SyncTransport,
  keys: SyncKeys,
  nowMs: number = Date.now(),
  opts: SyncOptions = {},
): Promise<CloudSyncReport> {
  const done = log.time("cloud pull", "info");
  const report = emptyReport();
  await pullAll(db, server, keys, report, nowMs, opts);
  done({ ...report });
  return report;
}

/**
 * The synced settings (profile and photo) both ways, on their own: a few rows, so a change made
 * on one device goes up at once, and a device opening gets them before the rest of its pull.
 * The pull cursor does not move: the full pull still reads these rows, and merges them as no change.
 * `pull: false` only sends (a change just made here).
 */
export async function cloudSyncSettings(
  db: SqlDriver,
  server: SyncTransport,
  keys: SyncKeys,
  nowMs: number = Date.now(),
  opts: { pull?: boolean } = {},
): Promise<CloudSyncReport> {
  const report = emptyReport();
  await pushTable(db, server, keys, SETTINGS_TABLE, report);
  if (opts.pull === false || !server.pullNewest) return report;
  const after = await pullCursor(db);
  let before: number | null = null;
  for (;;) {
    const page = await server.pullNewest(after, before, SYNC_PAGE, SETTINGS_TABLE.name);
    await mergePage(db, keys, page.rows, report, nowMs, async () => undefined);
    if (!page.more || page.rows.length === 0) break;
    before = page.next;
  }
  log.info("settings synced", { pushed: report.pushed, pulled: report.pulled });
  return report;
}

/** Rows waiting to be pushed, for the Sync screen. */
export async function pendingPush(db: SqlDriver): Promise<number> {
  const [row] = await db.all<{ n: number }>("SELECT COUNT(*) AS n FROM cloud_sync_outbox");
  return Number(row?.n ?? 0);
}

async function pushTable(db: SqlDriver, server: SyncTransport, keys: SyncKeys, t: BackupTable, report: CloudSyncReport): Promise<void> {
  // `t.name` always comes from SYNC_TABLES. Entries for rows deleted since (hard deletes) go.
  await db.run(`DELETE FROM cloud_sync_outbox WHERE tbl = ? AND row_id NOT IN (SELECT rowid FROM ${t.name})`, [t.name]);
  for (;;) {
    const page = await db.all<Record<string, SqlValue> & { _row: number; _stamp: number }>(
      `SELECT o.row_id AS _row, o.stamp AS _stamp, t.* FROM cloud_sync_outbox o JOIN ${t.name} t ON t.rowid = o.row_id
        WHERE o.tbl = ? ORDER BY o.stamp LIMIT ?`,
      [t.name, SYNC_PAGE],
    );
    if (page.length === 0) return;
    const rows: SyncRow[] = [];
    for (const { _row, _stamp, ...r } of page) {
      const c = Object.keys(r);
      const key = await rowKey(
        keys,
        t.name,
        t.key.map((k) => r[k] ?? null),
      );
      const blob = await seal(keys, t.name, key, { c, v: c.map((k) => r[k] ?? null) });
      if (blob.length > MAX_BLOB_CHARS) report.tooLarge++;
      else rows.push({ tbl: t.name, key, updatedAt: Number(r.updated_at), blob });
    }
    for (const part of bySize(rows)) {
      const res = await server.push(part);
      report.pushed += part.length;
      report.accepted += res.accepted;
    }
    // Cleared only at the stamp that was pushed: an edit made meanwhile has a newer stamp and stays queued.
    await db.exec("BEGIN");
    try {
      for (const r of page) await db.run("DELETE FROM cloud_sync_outbox WHERE tbl = ? AND row_id = ? AND stamp = ?", [t.name, r._row, r._stamp]);
      await db.exec("COMMIT");
    } catch (err) {
      await db.exec("ROLLBACK");
      throw err;
    }
    if (page.length < SYNC_PAGE) return;
  }
}

/** Splits a page into pushes under MAX_PUSH_BYTES (a few photos can fill one). */
export function bySize(rows: SyncRow[], max = MAX_PUSH_BYTES): SyncRow[][] {
  const parts: SyncRow[][] = [];
  let part: SyncRow[] = [];
  let size = 0;
  for (const r of rows) {
    const n = r.blob.length + r.key.length + r.tbl.length + 64;
    if (part.length > 0 && size + n > max) {
      parts.push(part);
      part = [];
      size = 0;
    }
    part.push(r);
    size += n;
  }
  if (part.length > 0) parts.push(part);
  return parts;
}

/** Inside a pull's transaction: triggers queue changes again, and the next pull starts after `upto`. Also the health connector's first load (server/ownerCopy.ts). */
export async function endPull(db: SqlDriver, upto: number, nowMs: number): Promise<void> {
  await db.run("DELETE FROM cloud_sync_pulling");
  await saveCursor(db, "pull", upto, nowMs);
}

async function saveCursor(db: SqlDriver, name: string, upto: number, nowMs: number): Promise<void> {
  await db.run(
    `INSERT INTO cloud_sync_cursors (name, upto, updated_at) VALUES (?, ?, ?)
     ON CONFLICT (name) DO UPDATE SET upto = excluded.upto, updated_at = excluded.updated_at`,
    [name, upto, nowMs],
  );
}

async function cursorAt(db: SqlDriver, name: string): Promise<number | null> {
  const [row] = await db.all<{ upto: number }>("SELECT upto FROM cloud_sync_cursors WHERE name = ?", [name]);
  return row ? Number(row.upto) : null;
}

async function pullCursor(db: SqlDriver): Promise<number> {
  return (await cursorAt(db, "pull")) ?? -1;
}

/** The HTTP status of a SyncHttpError (api.ts, which the Vercel function cannot load), else undefined. */
const statusOf = (err: unknown): number | undefined => (err as { status?: unknown } | null)?.status as number | undefined;

async function pullAll(db: SqlDriver, server: SyncTransport, keys: SyncKeys, report: CloudSyncReport, nowMs: number, opts: SyncOptions): Promise<void> {
  if (server.pullNewest) {
    try {
      return await pullNewestFirst(db, server.pullNewest, keys, report, nowMs, opts);
    } catch (err) {
      // A server from before /v1/pull/newest: the oldest-first pull still works there.
      if (statusOf(err) !== 404) throw err;
      log.info("server has no newest-first pull, pulling oldest first");
    }
  }
  await pullOldestFirst(db, server, keys, report, nowMs, opts);
}

async function pullOldestFirst(db: SqlDriver, server: SyncTransport, keys: SyncKeys, report: CloudSyncReport, nowMs: number, opts: SyncOptions): Promise<void> {
  let after = await pullCursor(db);
  for (;;) {
    const page = await server.pull(after, SYNC_PAGE);
    after = page.next;
    await mergePage(db, keys, page.rows, report, nowMs, () => saveCursor(db, "pull", after, nowMs));
    if (page.rows.length > 0) opts.onProgress?.();
    if (!page.more) return;
  }
}

/**
 * Newest first, so the days the owner looks at are there first, however much history a new
 * device has to catch up on. A catch-up reads down from the head (the highest sequence number
 * when it began) to the cursor; 'pull.head' and 'pull.low' keep its place, so one cut short
 * goes on where it stopped. Only once it reaches the cursor does the cursor move to the head.
 */
async function pullNewestFirst(
  db: SqlDriver,
  pullNewest: NonNullable<SyncTransport["pullNewest"]>,
  keys: SyncKeys,
  report: CloudSyncReport,
  nowMs: number,
  opts: SyncOptions,
): Promise<void> {
  for (;;) {
    const upto = await pullCursor(db);
    let head = await cursorAt(db, "pull.head");
    let low = await cursorAt(db, "pull.low");
    // Left from a catch-up the oldest-first pull finished since.
    if (head === null || low === null || head <= upto) head = low = null;
    const resumed = head !== null;
    let pages = 0;
    for (;;) {
      const page = await pullNewest(upto, low, SYNC_PAGE);
      if (head === null) {
        if (page.rows.length === 0) return;
        head = page.rows[0].seq;
      }
      pages++;
      const done = !page.more || page.rows.length === 0;
      const h = head;
      const next = page.next;
      await mergePage(db, keys, page.rows, report, nowMs, async () => {
        if (!done) {
          await saveCursor(db, "pull.head", h, nowMs);
          return saveCursor(db, "pull.low", next, nowMs);
        }
        await saveCursor(db, "pull", h, nowMs);
        await db.run("DELETE FROM cloud_sync_cursors WHERE name IN ('pull.head', 'pull.low')");
      });
      if (page.rows.length > 0) opts.onProgress?.();
      if (done) break;
      low = next;
    }
    // Rows pushed while a long catch-up ran are above its head: one more round for them.
    if (!resumed && pages <= 1) return;
  }
}

/**
 * Opens and stores one pulled page in one transaction, with `moveCursor` in the same
 * transaction, so a sync cut short never skips rows or stores half a page.
 *
 * Foreign keys are off while it runs: a newest-first pull brings a food entry before the photo
 * it points to, and a parent edited later is numbered after its children. Every pulled row met
 * the constraints on the device that wrote it, so the parent is on its way; refusing the child
 * meanwhile lost it for good, as the cursor moved past it.
 */
async function mergePage(db: SqlDriver, keys: SyncKeys, rows: PullResult["rows"], report: CloudSyncReport, nowMs: number, moveCursor: () => Promise<void>) {
  const byName = new Map(SYNC_TABLES.map((t) => [t.name, t]));
  // Parents before children within a page (SYNC_TABLES is in restore order).
  const grouped = new Map<string, { columns: string[]; values: SqlValue[] }[]>();
  for (const r of rows) {
    if (!byName.has(r.tbl)) {
      report.skipped++;
      continue;
    }
    try {
      const plain = await open(keys, r.tbl, r.key, r.blob);
      if (r.tbl === "app_settings" && !SYNCED_SETTINGS.has(String(plain.v[plain.c.indexOf("key")]))) {
        report.skipped++;
        continue;
      }
      grouped.set(r.tbl, [...(grouped.get(r.tbl) ?? []), { columns: plain.c, values: plain.v }]);
    } catch {
      // One bad row (a device with the wrong secret) must not stop every device from syncing.
      report.rejected++;
    }
  }
  // Only outside a transaction does SQLite take this pragma.
  const [fk] = await db.all<{ foreign_keys: number }>("PRAGMA foreign_keys");
  const checked = Number(fk?.foreign_keys) === 1;
  if (checked) await db.exec("PRAGMA foreign_keys = OFF");
  try {
    await db.exec("BEGIN");
    try {
      // While this row exists the triggers do not queue the merged rows to be pushed back.
      await db.run("INSERT OR REPLACE INTO cloud_sync_pulling (started_at) VALUES (?)", [nowMs]);
      for (const t of SYNC_TABLES) {
        // One call per row: rows written by different app versions can have different columns,
        // and a row that does not fit this schema is set aside, not allowed to stop the rest.
        for (const r of grouped.get(t.name) ?? []) {
          await db.exec("SAVEPOINT pulled_row");
          try {
            report.pulled += await mergeRows(db, t, r.columns, [r.values]);
            await db.exec("RELEASE pulled_row");
          } catch {
            await db.exec("ROLLBACK TO pulled_row");
            await db.exec("RELEASE pulled_row");
            report.rejected++;
          }
        }
      }
      await db.run("DELETE FROM cloud_sync_pulling");
      await moveCursor();
      await db.exec("COMMIT");
    } catch (err) {
      await db.exec("ROLLBACK");
      throw err;
    }
  } finally {
    if (checked) await db.exec("PRAGMA foreign_keys = ON");
  }
}
