import type { SqlDriver, SqlValue } from "../../db/driver";
import { createLogger } from "../../core/log";
import { MAX_PUSH_BYTES, SYNC_PAGE, type PullResult, type PushResult, type SyncRow } from "../../core/syncWire";
import { BACKUP_TABLES, mergeRows, type BackupTable } from "../backup/backup";
import { open, rowKey, seal, type SyncKeys } from "./seal";

const log = createLogger("cloudsync");

/**
 * Phase 2 cloud sync (docs/architecture.md section 6): push this install's changed rows, then
 * pull everyone else's, last write wins per row on updated_at. Not wired into the app yet.
 *
 * Synced: every backed-up table except the ones about this install (Garmin cursors, sync runs,
 * settings that hold the device id and backup dates, and the cloud cursors themselves).
 */
const NOT_SYNCED = new Set(["app_settings", "sync_state", "sync_runs"]);
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
}

export async function cloudSync(db: SqlDriver, server: SyncTransport, keys: SyncKeys, nowMs: number = Date.now()): Promise<CloudSyncReport> {
  const done = log.time("cloud sync", "info");
  const report: CloudSyncReport = { pushed: 0, accepted: 0, pulled: 0, skipped: 0 };
  for (const t of SYNC_TABLES) await pushTable(db, server, keys, t, report, nowMs);
  await pullAll(db, server, keys, report, nowMs);
  done({ ...report });
  return report;
}

interface Cursor {
  upto: number;
  upto_rowid: number;
}

async function cursor(db: SqlDriver, name: string): Promise<Cursor> {
  const [row] = await db.all<Cursor>("SELECT upto, upto_rowid FROM cloud_sync_cursors WHERE name = ?", [name]);
  return row ?? { upto: -1, upto_rowid: 0 };
}

async function setCursor(db: SqlDriver, name: string, c: Cursor, nowMs: number): Promise<void> {
  await db.run(
    `INSERT INTO cloud_sync_cursors (name, upto, upto_rowid, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (name) DO UPDATE SET upto = excluded.upto, upto_rowid = excluded.upto_rowid, updated_at = excluded.updated_at`,
    [name, c.upto, c.upto_rowid, nowMs],
  );
}

async function pushTable(db: SqlDriver, server: SyncTransport, keys: SyncKeys, t: BackupTable, report: CloudSyncReport, nowMs: number): Promise<void> {
  let at = await cursor(db, t.name);
  for (;;) {
    // (updated_at, rowid) order, so rows sharing a timestamp across a page boundary are not skipped.
    // `t.name` always comes from SYNC_TABLES.
    const page = await db.all<Record<string, SqlValue> & { _rowid: number }>(
      `SELECT rowid AS _rowid, * FROM ${t.name} WHERE updated_at > ? OR (updated_at = ? AND rowid > ?) ORDER BY updated_at, rowid LIMIT ?`,
      [at.upto, at.upto, at.upto_rowid, SYNC_PAGE],
    );
    if (page.length === 0) return;
    const rows: SyncRow[] = [];
    for (const { _rowid, ...r } of page) {
      const c = Object.keys(r);
      const key = await rowKey(
        keys,
        t.name,
        t.key.map((k) => r[k] ?? null),
      );
      rows.push({ tbl: t.name, key, updatedAt: Number(r.updated_at), blob: await seal(keys, t.name, key, { c, v: c.map((k) => r[k] ?? null) }) });
    }
    for (const part of bySize(rows)) {
      const res = await server.push(part);
      report.pushed += part.length;
      report.accepted += res.accepted;
    }
    const last = page[page.length - 1];
    at = { upto: Number(last.updated_at), upto_rowid: last._rowid };
    await setCursor(db, t.name, at, nowMs);
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

async function pullAll(db: SqlDriver, server: SyncTransport, keys: SyncKeys, report: CloudSyncReport, nowMs: number): Promise<void> {
  const byName = new Map(SYNC_TABLES.map((t) => [t.name, t]));
  let after = (await cursor(db, "pull")).upto;
  for (;;) {
    const page = await server.pull(after, SYNC_PAGE);
    // Parents before children within a page (SYNC_TABLES is in restore order).
    const grouped = new Map<string, { columns: string[]; values: SqlValue[] }[]>();
    for (const r of page.rows) {
      if (!byName.has(r.tbl)) {
        report.skipped++;
        continue;
      }
      const plain = await open(keys, r.tbl, r.key, r.blob);
      grouped.set(r.tbl, [...(grouped.get(r.tbl) ?? []), { columns: plain.c, values: plain.v }]);
    }
    await db.exec("BEGIN");
    try {
      for (const t of SYNC_TABLES) {
        // One call per column set: rows written by different app versions can differ.
        for (const r of grouped.get(t.name) ?? []) report.pulled += await mergeRows(db, t, r.columns, [r.values]);
      }
      after = page.next;
      await setCursor(db, "pull", { upto: after, upto_rowid: 0 }, nowMs);
      await db.exec("COMMIT");
    } catch (err) {
      await db.exec("ROLLBACK");
      throw err;
    }
    if (!page.more) return;
  }
}
