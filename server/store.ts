import { uuidv7 } from "../src/core/uuidv7";
import type { PullResult, PushResult, SyncRow } from "../src/core/syncWire";
import type { Pg } from "./pg";

export interface Device {
  id: string;
  ownerId: string;
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The sync server's storage: devices and their tokens, and the sealed rows. */
export function syncStore(pg: Pg) {
  return {
    /** A new device for an owner. The token is returned once and only its hash is kept. */
    async addDevice(ownerId: string, name: string, nowMs = Date.now()): Promise<{ id: string; token: string }> {
      const id = uuidv7(nowMs);
      const token = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
      await pg.query("INSERT INTO devices (id, owner_id, name, token_hash, created_at) VALUES ($1, $2, $3, $4, $5)", [
        id,
        ownerId,
        name,
        await sha256Hex(token),
        nowMs,
      ]);
      return { id, token };
    },

    async revokeDevice(id: string, nowMs = Date.now()): Promise<void> {
      await pg.query("UPDATE devices SET revoked_at = $2 WHERE id = $1 AND revoked_at IS NULL", [id, nowMs]);
    },

    async deviceFor(token: string, nowMs = Date.now()): Promise<Device | null> {
      const [row] = await pg.query<{ id: string; owner_id: string }>(
        "UPDATE devices SET last_seen_at = $2 WHERE token_hash = $1 AND revoked_at IS NULL RETURNING id, owner_id",
        [await sha256Hex(token), nowMs],
      );
      return row ? { id: row.id, ownerId: row.owner_id } : null;
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

    async pull(ownerId: string, after: number, limit: number): Promise<PullResult> {
      const rows = await pg.query<{ seq: number; tbl: string; row_key: string; updated_at: number; blob: string }>(
        "SELECT seq, tbl, row_key, updated_at, blob FROM sync_rows WHERE owner_id = $1 AND seq > $2 ORDER BY seq LIMIT $3",
        [ownerId, after, limit + 1],
      );
      const more = rows.length > limit;
      const page = rows.slice(0, limit).map((r) => ({ seq: r.seq, tbl: r.tbl, key: r.row_key, updatedAt: r.updated_at, blob: r.blob }));
      return { rows: page, next: page.at(-1)?.seq ?? after, more };
    },
  };
}

export type SyncStore = ReturnType<typeof syncStore>;
