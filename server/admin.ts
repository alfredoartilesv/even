import { sha256Hex } from "../src/core/hash.js";
import { uuidv7 } from "../src/core/uuidv7.js";
import type { AdminAccount, AdminDevice, AdminInvite, AdminVia, AuditEntry, ServiceHealth } from "../src/core/syncWire.js";
import { AuthError, INVITE_DAYS, newCode } from "./accounts.js";
import type { Pg } from "./pg.js";

/**
 * What an admin can do (docs/users.md section 2.6): invites, accounts, quotas, devices, suspension.
 * The same functions serve Settings > Admin (/v1/admin), the MCP server and the CLI, so there is
 * one implementation and one audit log. Nothing here reads a sealed row, a key or a share: an
 * admin sees who and when, never data, and cannot see who is friends with whom.
 */

/** Who acts: an admin's account id (or "cli"), and through what. */
export interface Actor {
  id: string;
  via: AdminVia;
}

const DAY = 86_400_000;

export function adminStore(pg: Pg, opts: { build?: string } = {}) {
  async function audit(actor: Actor, action: string, target: string | null, detail: Record<string, string | number | boolean> | null, nowMs: number) {
    await pg.query("INSERT INTO admin_audit (id, at, actor, via, action, target, detail) VALUES ($1, $2, $3, $4, $5, $6, $7)", [
      uuidv7(nowMs),
      nowMs,
      actor.id,
      actor.via,
      action,
      target,
      detail ? JSON.stringify(detail) : null,
    ]);
  }

  async function existingAccount(accountId: string): Promise<void> {
    const [a] = await pg.query("SELECT 1 FROM accounts WHERE id = $1", [accountId]);
    if (!a) throw new AuthError(404, "No such account");
  }

  return {
    /** An audit entry for an action taken elsewhere (connecting Claude, revoking its access). */
    record: (actor: Actor, action: string, target: string | null, detail: Record<string, string | number | boolean> | null, nowMs = Date.now()) =>
      audit(actor, action, target, detail, nowMs),

    /** Whether this account may use the admin endpoints: an admin, not suspended. */
    async isAdmin(accountId: string): Promise<boolean> {
      const [a] = await pg.query<{ ok: boolean }>("SELECT (is_admin AND suspended_at IS NULL) AS ok FROM accounts WHERE id = $1", [accountId]);
      return a?.ok === true;
    },

    /** Only the CLI grants or takes away admin (npm run sync:admin): no endpoint can. */
    async setAdmin(email: string, admin: boolean, nowMs = Date.now()): Promise<string> {
      const rows = await pg.query<{ id: string }>("UPDATE accounts SET is_admin = $2 WHERE email = $1 RETURNING id", [email.trim().toLowerCase(), admin]);
      if (!rows[0]) throw new AuthError(404, "No account with that email");
      await audit({ id: "cli", via: "cli" }, admin ? "grant-admin" : "revoke-admin", rows[0].id, null, nowMs);
      return rows[0].id;
    },

    /** An invite for one email. The code is returned once; only its hash is kept. */
    async createInvite(actor: Actor, email: string, days = INVITE_DAYS, nowMs = Date.now()): Promise<{ code: string; invite: AdminInvite }> {
      const code = newCode(10);
      const id = await sha256Hex(code);
      const normalized = email.trim().toLowerCase();
      await pg.query("INSERT INTO invites (code_hash, email, created_at, expires_at, created_by) VALUES ($1, $2, $3, $4, $5)", [
        id,
        normalized,
        nowMs,
        nowMs + days * DAY,
        actor.id === "cli" ? null : actor.id,
      ]);
      await audit(actor, "create-invite", id, { days }, nowMs);
      return { code, invite: { id, email: normalized, createdAt: nowMs, expiresAt: nowMs + days * DAY, status: "open", usedAt: null } };
    },

    async listInvites(nowMs = Date.now()): Promise<AdminInvite[]> {
      const rows = await pg.query<{
        code_hash: string;
        email: string;
        created_at: number;
        expires_at: number;
        used_at: number | null;
        cancelled_at: number | null;
      }>("SELECT code_hash, email, created_at, expires_at, used_at, cancelled_at FROM invites ORDER BY created_at DESC LIMIT 200");
      return rows.map((r) => ({
        id: r.code_hash,
        email: r.email,
        createdAt: r.created_at,
        expiresAt: r.expires_at,
        usedAt: r.used_at,
        status: r.used_at !== null ? "used" : r.cancelled_at !== null ? "cancelled" : r.expires_at < nowMs ? "expired" : "open",
      }));
    },

    /** An unused invite stops working at once (signup already refuses expired ones). */
    async cancelInvite(actor: Actor, id: string, nowMs = Date.now()): Promise<void> {
      const rows = await pg.query(
        "UPDATE invites SET cancelled_at = $2, expires_at = LEAST(expires_at, $2) WHERE code_hash = $1 AND used_at IS NULL RETURNING 1",
        [id, nowMs],
      );
      if (rows.length === 0) throw new AuthError(404, "No unused invite with that id");
      await audit(actor, "cancel-invite", id, null, nowMs);
    },

    async listAccounts(): Promise<AdminAccount[]> {
      const rows = await pg.query<{
        id: string;
        email: string;
        display_name: string;
        created_at: number;
        is_admin: boolean;
        suspended_at: number | null;
        quota_bytes: number;
        devices: number;
        last_seen_at: number | null;
        bytes: number;
        friends: number;
      }>(
        `SELECT a.id, a.email, a.display_name, a.created_at, a.is_admin, a.suspended_at, a.quota_bytes,
                (SELECT COUNT(*)::int FROM devices d WHERE d.owner_id = a.id AND d.revoked_at IS NULL) AS devices,
                (SELECT MAX(d.last_seen_at) FROM devices d WHERE d.owner_id = a.id) AS last_seen_at,
                (SELECT COALESCE(SUM(length(r.blob)), 0)::bigint FROM sync_rows r WHERE r.owner_id = a.id) AS bytes,
                (SELECT COUNT(*)::int FROM friendships f WHERE f.a = a.id OR f.b = a.id) AS friends
           FROM accounts a ORDER BY a.created_at`,
      );
      return rows.map((r) => ({
        id: r.id,
        email: r.email,
        displayName: r.display_name,
        createdAt: r.created_at,
        isAdmin: r.is_admin,
        suspendedAt: r.suspended_at,
        devices: r.devices,
        lastSeenAt: r.last_seen_at,
        bytes: Number(r.bytes),
        quotaBytes: r.quota_bytes,
        friends: r.friends,
      }));
    },

    async setQuota(actor: Actor, accountId: string, bytes: number, nowMs = Date.now()): Promise<void> {
      await existingAccount(accountId);
      await pg.query("UPDATE accounts SET quota_bytes = $2 WHERE id = $1", [accountId, bytes]);
      await audit(actor, "set-quota", accountId, { bytes }, nowMs);
    },

    async listDevices(accountId: string): Promise<AdminDevice[]> {
      await existingAccount(accountId);
      const rows = await pg.query<{
        id: string;
        name: string;
        kind: string;
        added_by: string;
        created_at: number;
        last_seen_at: number | null;
        revoked_at: number | null;
      }>("SELECT id, name, kind, added_by, created_at, last_seen_at, revoked_at FROM devices WHERE owner_id = $1 ORDER BY created_at", [accountId]);
      return rows.map((d) => ({
        id: d.id,
        name: d.name,
        kind: d.kind,
        addedBy: d.added_by,
        createdAt: d.created_at,
        lastSeenAt: d.last_seen_at,
        revokedAt: d.revoked_at,
      }));
    },

    async revokeDevice(actor: Actor, accountId: string, deviceId: string, nowMs = Date.now()): Promise<void> {
      const rows = await pg.query("UPDATE devices SET revoked_at = $3 WHERE id = $1 AND owner_id = $2 AND revoked_at IS NULL RETURNING 1", [
        deviceId,
        accountId,
        nowMs,
      ]);
      if (rows.length === 0) throw new AuthError(404, "No such device on this account");
      await audit(actor, "revoke-device", accountId, { device: deviceId }, nowMs);
    },

    /** Sign-in, pairing and sync stop; nothing is deleted. An admin cannot suspend themselves. */
    async setSuspended(actor: Actor, accountId: string, suspended: boolean, nowMs = Date.now()): Promise<void> {
      if (actor.id === accountId) throw new AuthError(409, "You cannot suspend your own account");
      await existingAccount(accountId);
      await pg.query("UPDATE accounts SET suspended_at = $2 WHERE id = $1", [accountId, suspended ? nowMs : null]);
      await audit(actor, suspended ? "suspend" : "reactivate", accountId, null, nowMs);
    },

    async auditLog(limit = 100): Promise<AuditEntry[]> {
      const rows = await pg.query<{ id: string; at: number; actor: string; via: AdminVia; action: string; target: string | null; detail: string | null }>(
        "SELECT id, at, actor, via, action, target, detail FROM admin_audit ORDER BY at DESC, id DESC LIMIT $1",
        [Math.min(Math.max(limit, 1), 500)],
      );
      return rows;
    },

    async health(nowMs = Date.now()): Promise<ServiceHealth> {
      const [r] = await pg.query<{ accounts: number; devices: number; bytes: number; invites: number }>(
        `SELECT (SELECT COUNT(*)::int FROM accounts) AS accounts,
                (SELECT COUNT(*)::int FROM devices WHERE revoked_at IS NULL) AS devices,
                (SELECT COALESCE(SUM(length(blob)), 0)::bigint FROM sync_rows) AS bytes,
                (SELECT COUNT(*)::int FROM invites WHERE used_at IS NULL AND cancelled_at IS NULL AND expires_at > $1) AS invites`,
        [nowMs],
      );
      return {
        build: opts.build ?? "local",
        database: "ok",
        accounts: r?.accounts ?? 0,
        devices: r?.devices ?? 0,
        bytes: Number(r?.bytes ?? 0),
        openInvites: r?.invites ?? 0,
      };
    },
  };
}

export type AdminStore = ReturnType<typeof adminStore>;
