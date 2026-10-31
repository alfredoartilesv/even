import { sha256Hex } from "../src/core/hash.js";
import type { PullResult, PushResult, SyncRow } from "../src/core/syncWire.js";
import type { Pg } from "./pg.js";

/** A removed device takes the health connector grant pushing as it along: tokens and sealed keys. */
export async function revokeDeviceGrants(pg: Pick<Pg, "query">, deviceId: string, nowMs: number): Promise<void> {
  await pg.query("UPDATE mcp_grants SET revoked_at = $2, keys_access = NULL, keys_refresh = NULL WHERE device_id = $1 AND revoked_at IS NULL", [
    deviceId,
    nowMs,
  ]);
}

export interface Device {
  id: string;
  ownerId: string;
  /** The account is suspended by an admin: the device is known, but may not act. */
  suspended?: boolean;
}

/** The sync server's storage: devices and their tokens, and the sealed rows. */
export function syncStore(pg: Pg) {
  return {
    async deviceFor(token: string, nowMs = Date.now()): Promise<Device | null> {
      const [row] = await pg.query<{ id: string; owner_id: string; suspended: boolean }>(
        `UPDATE devices d SET last_seen_at = $2 FROM accounts a
          WHERE d.token_hash = $1 AND d.revoked_at IS NULL AND a.id = d.owner_id
          RETURNING d.id, d.owner_id, (a.suspended_at IS NOT NULL) AS suspended`,
        [await sha256Hex(token), nowMs],
      );
      return row ? { id: row.id, ownerId: row.owner_id, suspended: row.suspended } : null;
    },

    /**
     * Last write wins per row: a row replaces the stored one only when its updated_at is newer.
     * Pushes for one owner take a lock for their transaction, so their sequence numbers commit in
     * order and a pull that read up to N can never miss a row numbered below N committed later.
     */
    async push(device: Device, rows: SyncRow[]): Promise<PushResult> {
      // One row per key (the newest), as one INSERT cannot update the same row twice.
      const newest = new Map<string, SyncRow>();
      for (const r of rows) {
        const k = `${r.tbl}\u0000${r.key}`;
        if ((newest.get(k)?.updatedAt ?? -1) < r.updatedAt) newest.set(k, r);
      }
      const list = [...newest.values()];
      if (list.length === 0) return { accepted: 0, ignored: rows.length };
      const taken = await pg.tx(async (q) => {
        await q.query("SELECT pg_advisory_xact_lock(hashtext($1))", [device.ownerId]);
        return q.query(
          `INSERT INTO sync_rows (owner_id, tbl, row_key, updated_at, blob, device_id, seq)
           SELECT $1, x.tbl, x.row_key, x.updated_at, x.blob, $2, nextval('sync_seq')
             FROM unnest($3::text[], $4::text[], $5::bigint[], $6::text[]) AS x (tbl, row_key, updated_at, blob)
           ON CONFLICT (owner_id, tbl, row_key) DO UPDATE
             SET updated_at = excluded.updated_at, blob = excluded.blob, device_id = excluded.device_id, seq = excluded.seq
             WHERE excluded.updated_at > sync_rows.updated_at
           RETURNING 1`,
          [device.ownerId, device.id, list.map((r) => r.tbl), list.map((r) => r.key), list.map((r) => r.updatedAt), list.map((r) => r.blob)],
        );
      });
      return { accepted: taken.length, ignored: rows.length - taken.length };
    },

    /** `skip`: tables left out (the health connector has no use for photos and chats). */
    async pull(ownerId: string, after: number, limit: number, skip: string[] = []): Promise<PullResult> {
      const rows = await pg.query<{ seq: number; tbl: string; row_key: string; updated_at: number; blob: string }>(
        "SELECT seq, tbl, row_key, updated_at, blob FROM sync_rows WHERE owner_id = $1 AND seq > $2 AND NOT (tbl = ANY($4::text[])) ORDER BY seq LIMIT $3",
        [ownerId, after, limit + 1, skip],
      );
      const more = rows.length > limit;
      const page = rows.slice(0, limit).map((r) => ({ seq: r.seq, tbl: r.tbl, key: r.row_key, updatedAt: r.updated_at, blob: r.blob }));
      return { rows: page, next: page.at(-1)?.seq ?? after, more };
    },
  };
}

export type SyncStore = ReturnType<typeof syncStore>;
