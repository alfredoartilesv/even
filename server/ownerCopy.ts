import { createDecipheriv } from "node:crypto";
import type { PullResult } from "../src/core/syncWire.js";
import type { SqlDriver, SqlValue } from "../src/db/driver.js";
import { mergeRows } from "../src/domain/backup/backup.js";
import { endPull, SYNC_TABLES } from "../src/domain/cloudsync/cloudSync.js";
import type { PlainRow } from "../src/domain/cloudsync/seal.js";

/**
 * The health connector's first load of an owner's rows into a fresh copy (server/healthMcp.ts).
 * cloudSync would do the same one row at a time (async WebCrypto, a savepoint per row), which for
 * years of Garmin history takes minutes; here the rows are opened with node:crypto and merged in
 * batches of the same table and columns. A batch that does not merge falls back to one row at a
 * time, so one bad row is set aside as cloudSync does. Afterwards the pull cursor is where cloudSync
 * expects it, and later requests sync the usual way.
 */

const PAGE = 5_000;

/** seal.ts open(), synchronous: base64(iv || ciphertext || tag), the table and key as additional data. */
export function openSync(enc: Buffer, tbl: string, key: string, blob: string): PlainRow {
  const b = Buffer.from(blob, "base64");
  const d = createDecipheriv("aes-256-gcm", enc, b.subarray(0, 12));
  d.setAAD(Buffer.from(`${tbl}:${key}`));
  d.setAuthTag(b.subarray(b.length - 16));
  return JSON.parse(Buffer.concat([d.update(b.subarray(12, b.length - 16)), d.final()]).toString("utf8")) as PlainRow;
}

export async function firstLoad(
  db: SqlDriver,
  pull: (after: number, limit: number) => Promise<PullResult>,
  encKey: Buffer,
  nowMs: number,
): Promise<{ pulled: number; rejected: number; skipped: number }> {
  const byName = new Map(SYNC_TABLES.map((t) => [t.name, t]));
  // Per table, per column list (rows from different app versions can differ), in pull order.
  const groups = new Map<string, Map<string, SqlValue[][]>>();
  const report = { pulled: 0, rejected: 0, skipped: 0 };
  let after = -1;
  for (;;) {
    const page = await pull(after, PAGE);
    for (const r of page.rows) {
      if (!byName.has(r.tbl)) {
        report.skipped++;
        continue;
      }
      let plain: PlainRow;
      try {
        plain = openSync(encKey, r.tbl, r.key, r.blob);
      } catch {
        report.rejected++;
        continue;
      }
      const byCols = groups.get(r.tbl) ?? new Map<string, SqlValue[][]>();
      groups.set(r.tbl, byCols);
      const cols = JSON.stringify(plain.c);
      const list = byCols.get(cols);
      if (list) list.push(plain.v);
      else byCols.set(cols, [plain.v]);
    }
    after = page.next;
    if (!page.more) break;
  }

  await db.exec("BEGIN");
  try {
    // While this row exists the triggers do not queue the merged rows to be pushed back.
    await db.run("INSERT OR REPLACE INTO cloud_sync_pulling (started_at) VALUES (?)", [nowMs]);
    for (const t of SYNC_TABLES) {
      for (const [cols, rows] of groups.get(t.name) ?? []) {
        const columns = JSON.parse(cols) as string[];
        if (await merged(db, () => mergeRows(db, t, columns, rows))) {
          report.pulled += rows.length;
          continue;
        }
        for (const row of rows) {
          if (await merged(db, () => mergeRows(db, t, columns, [row]))) report.pulled++;
          else report.rejected++;
        }
      }
    }
    await endPull(db, after, nowMs);
    await db.exec("COMMIT");
  } catch (err) {
    await db.exec("ROLLBACK");
    throw err;
  }
  return report;
}

async function merged(db: SqlDriver, fn: () => Promise<unknown>): Promise<boolean> {
  await db.exec("SAVEPOINT first_load");
  try {
    await fn();
    await db.exec("RELEASE first_load");
    return true;
  } catch {
    await db.exec("ROLLBACK TO first_load");
    await db.exec("RELEASE first_load");
    return false;
  }
}
