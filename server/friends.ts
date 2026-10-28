import { uuidv7 } from "../src/core/uuidv7";
import type { Friend, Share, ShareKind, ShareRow, ShareRowsResult } from "../src/core/syncWire";
import { AuthError, newCode, normalizeCode } from "./accounts";
import type { Pg } from "./pg";
import { sha256Hex } from "../src/core/hash";

/**
 * Friends and what each one is shown (docs/users.md section 2.4). The server knows who is friends
 * with whom and which kinds are shared; the summaries themselves are sealed with share keys only
 * the two accounts' devices can open.
 */
const DAY = 86_400_000;
export const FRIEND_INVITE_DAYS = 7;

const pair = (x: string, y: string): [string, string] => (x < y ? [x, y] : [y, x]);

export function friendStore(pg: Pg) {
  async function areFriends(x: string, y: string): Promise<boolean> {
    const [a, b] = pair(x, y);
    return (await pg.query("SELECT 1 FROM friendships WHERE a = $1 AND b = $2", [a, b])).length > 0;
  }

  /** The share, if this account owns it or is the friend it is for. */
  async function shareFor(id: string, accountId: string): Promise<{ owner_id: string; friend_id: string }> {
    const [s] = await pg.query<{ owner_id: string; friend_id: string }>("SELECT owner_id, friend_id FROM shares WHERE id = $1", [id]);
    if (!s || (s.owner_id !== accountId && s.friend_id !== accountId)) throw new AuthError(404, "No such share");
    return s;
  }

  return {
    async createInvite(accountId: string, nowMs = Date.now()): Promise<{ code: string; expiresAt: number }> {
      const code = newCode(8);
      const expiresAt = nowMs + FRIEND_INVITE_DAYS * DAY;
      await pg.query("INSERT INTO friend_invites (code_hash, account_id, created_at, expires_at) VALUES ($1, $2, $3, $4)", [
        await sha256Hex(code),
        accountId,
        nowMs,
        expiresAt,
      ]);
      return { code, expiresAt };
    },

    async accept(accountId: string, code: string, nowMs = Date.now()): Promise<Friend> {
      const hash = await sha256Hex(normalizeCode(code));
      const friendId = await pg.tx(async (q) => {
        const [inv] = await q.query<{ account_id: string; expires_at: number; used_at: number | null }>(
          "SELECT account_id, expires_at, used_at FROM friend_invites WHERE code_hash = $1 FOR UPDATE",
          [hash],
        );
        if (!inv || inv.used_at !== null || inv.expires_at < nowMs) throw new AuthError(404, "That friend code is not valid. Ask for a new one.");
        if (inv.account_id === accountId) throw new AuthError(400, "That is your own friend code");
        await q.query("UPDATE friend_invites SET used_at = $2, used_by = $3 WHERE code_hash = $1", [hash, nowMs, accountId]);
        const [a, b] = pair(accountId, inv.account_id);
        await q.query("INSERT INTO friendships (a, b, created_at) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING", [a, b, nowMs]);
        return inv.account_id;
      });
      const friend = (await this.list(accountId)).find((f) => f.accountId === friendId);
      if (!friend) throw new AuthError(404, "That account is gone");
      return friend;
    },

    async list(accountId: string): Promise<Friend[]> {
      const rows = await pg.query<{ id: string; display_name: string; identity_public: string; since: number }>(
        `SELECT acc.id, acc.display_name, k.identity_public, f.created_at AS since
           FROM friendships f
           JOIN accounts acc ON acc.id = CASE WHEN f.a = $1 THEN f.b ELSE f.a END
           JOIN account_keys k ON k.account_id = acc.id
          WHERE f.a = $1 OR f.b = $1
          ORDER BY acc.display_name`,
        [accountId],
      );
      return rows.map((r) => ({ accountId: r.id, displayName: r.display_name, identityPublic: r.identity_public, since: r.since }));
    },

    /** Unfriending ends every share both ways, at once. */
    async remove(accountId: string, friendId: string): Promise<void> {
      const [a, b] = pair(accountId, friendId);
      await pg.tx(async (q) => {
        const cond = "(owner_id = $1 AND friend_id = $2) OR (owner_id = $2 AND friend_id = $1)";
        await q.query(`DELETE FROM share_rows WHERE share_id IN (SELECT id FROM shares WHERE ${cond})`, [accountId, friendId]);
        await q.query(`DELETE FROM shares WHERE ${cond}`, [accountId, friendId]);
        await q.query("DELETE FROM friendships WHERE a = $1 AND b = $2", [a, b]);
      });
    },

    async shares(accountId: string): Promise<{ outgoing: Share[]; incoming: Share[] }> {
      const rows = await pg.query<{ id: string; owner_id: string; friend_id: string; kind: ShareKind; wrapped_key: string; created_at: number }>(
        "SELECT id, owner_id, friend_id, kind, wrapped_key, created_at FROM shares WHERE owner_id = $1 OR friend_id = $1 ORDER BY created_at",
        [accountId],
      );
      const all = rows.map((r) => ({ id: r.id, ownerId: r.owner_id, friendId: r.friend_id, kind: r.kind, wrappedKey: r.wrapped_key, createdAt: r.created_at }));
      return { outgoing: all.filter((s) => s.ownerId === accountId), incoming: all.filter((s) => s.friendId === accountId) };
    },

    /** Starts sharing a kind (or gives it a new key: the old summaries go, the devices send new ones). */
    async share(accountId: string, friendId: string, kind: ShareKind, wrappedKey: string, nowMs = Date.now()): Promise<Share> {
      if (!(await areFriends(accountId, friendId))) throw new AuthError(403, "You can only share with a friend");
      return pg.tx(async (q) => {
        const [old] = await q.query<{ id: string }>("SELECT id FROM shares WHERE owner_id = $1 AND friend_id = $2 AND kind = $3", [accountId, friendId, kind]);
        const id = old?.id ?? uuidv7(nowMs);
        if (old) {
          await q.query("DELETE FROM share_rows WHERE share_id = $1", [id]);
          await q.query("UPDATE shares SET wrapped_key = $2 WHERE id = $1", [id, wrappedKey]);
        } else {
          await q.query("INSERT INTO shares (id, owner_id, friend_id, kind, wrapped_key, created_at) VALUES ($1, $2, $3, $4, $5, $6)", [
            id,
            accountId,
            friendId,
            kind,
            wrappedKey,
            nowMs,
          ]);
        }
        return { id, ownerId: accountId, friendId, kind, wrappedKey, createdAt: nowMs };
      });
    },

    async unshare(accountId: string, shareId: string): Promise<void> {
      const s = await shareFor(shareId, accountId);
      if (s.owner_id !== accountId) throw new AuthError(403, "Only the owner can stop a share");
      await pg.tx(async (q) => {
        await q.query("DELETE FROM share_rows WHERE share_id = $1", [shareId]);
        await q.query("DELETE FROM shares WHERE id = $1", [shareId]);
      });
    },

    /** Last write wins per day, as for sync rows. Days older than the share window are dropped. */
    async pushRows(accountId: string, shareId: string, rows: ShareRow[], oldestDay: string): Promise<number> {
      const s = await shareFor(shareId, accountId);
      if (s.owner_id !== accountId) throw new AuthError(403, "Only the owner can write a share");
      return pg.tx(async (q) => {
        await q.query("SELECT pg_advisory_xact_lock(hashtext($1))", [shareId]);
        let taken = 0;
        for (const r of rows) {
          const res = await q.query(
            `INSERT INTO share_rows (share_id, day, updated_at, seq, blob) VALUES ($1, $2, $3, nextval('sync_seq'), $4)
             ON CONFLICT (share_id, day) DO UPDATE SET updated_at = excluded.updated_at, seq = excluded.seq, blob = excluded.blob
               WHERE excluded.updated_at > share_rows.updated_at
             RETURNING 1`,
            [shareId, r.day, r.updatedAt, r.blob],
          );
          taken += res.length;
        }
        await q.query("DELETE FROM share_rows WHERE share_id = $1 AND day < $2", [shareId, oldestDay]);
        return taken;
      });
    },

    async pullRows(accountId: string, shareId: string, after: number, limit: number): Promise<ShareRowsResult> {
      await shareFor(shareId, accountId);
      const rows = await pg.query<{ day: string; updated_at: number; seq: number; blob: string }>(
        "SELECT day, updated_at, seq, blob FROM share_rows WHERE share_id = $1 AND seq > $2 ORDER BY seq LIMIT $3",
        [shareId, after, limit + 1],
      );
      const page = rows.slice(0, limit).map((r) => ({ day: r.day, updatedAt: r.updated_at, seq: r.seq, blob: r.blob }));
      return { rows: page, next: page.at(-1)?.seq ?? after, more: rows.length > limit };
    },
  };
}

export type FriendStore = ReturnType<typeof friendStore>;
