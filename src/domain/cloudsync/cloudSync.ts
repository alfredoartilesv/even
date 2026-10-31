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

/** The server, over HTTP on the phone (server/app.ts) or in-process in tests. */
export interface SyncTransport {
  push(rows: SyncRow[]): Promise<PushResult>;
  pull(after: number, limit: number): Promise<PullResult>;
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

export async function cloudSync(db: SqlDriver, server: SyncTransport, keys: SyncKeys, nowMs: number = Date.now()): Promise<CloudSyncReport> {
  const done = log.time("cloud sync", "info");
  const report: CloudSyncReport = { pushed: 0, accepted: 0, pulled: 0, skipped: 0, tooLarge: 0, rejected: 0 };
  for (const t of SYNC_TABLES) await pushTable(db, server, keys, t, report);
  await pullAll(db, server, keys, report, nowMs);
  if (report.tooLarge || report.rejected) log.warn("cloud sync left rows out", { tooLarge: report.tooLarge, rejected: report.rejected });
  done({ ...report });
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
  await db.run(
    `INSERT INTO cloud_sync_cursors (name, upto, updated_at) VALUES ('pull', ?, ?)
     ON CONFLICT (name) DO UPDATE SET upto = excluded.upto, updated_at = excluded.updated_at`,
    [upto, nowMs],
  );
}

async function pullCursor(db: SqlDriver): Promise<number> {
  const [row] = await db.all<{ upto: number }>("SELECT upto FROM cloud_sync_cursors WHERE name = 'pull'");
  return row ? Number(row.upto) : -1;
}

async function pullAll(db: SqlDriver, server: SyncTransport, keys: SyncKeys, report: CloudSyncReport, nowMs: number): Promise<void> {
  const byName = new Map(SYNC_TABLES.map((t) => [t.name, t]));
  let after = await pullCursor(db);
  for (;;) {
    const page = await server.pull(after, SYNC_PAGE);
    // Parents before children within a page (SYNC_TABLES is in restore order).
    const grouped = new Map<string, { columns: string[]; values: SqlValue[] }[]>();
    for (const r of page.rows) {
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
      after = page.next;
      await endPull(db, after, nowMs);
      await db.exec("COMMIT");
    } catch (err) {
      await db.exec("ROLLBACK");
      throw err;
    }
    if (!page.more) return;
  }
}
