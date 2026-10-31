import { timingSafeEqual } from "node:crypto";
import { uuidv7 } from "../src/core/uuidv7.js";
import type { DeviceInfo, DeviceKind, Joined, Me, PairingStatus, RecoveryStart, RecoveryUpdateBody, SignupBody } from "../src/core/syncWire.js";
import type { Pg } from "./pg.js";
import { sha256Hex } from "../src/core/hash.js";

/**
 * Accounts and devices (docs/users.md sections 2.1, 2.2, 2.5). The server never sees a passphrase
 * or the account data key: signup brings them sealed, recovery proves the passphrase with a key
 * derived from it, and pairing relays keys an existing device sealed for the new one.
 */

// A plain field, not a parameter property: Node's type stripping (the function test) rejects those.
export class AuthError extends Error {
  readonly status: 400 | 401 | 403 | 404 | 409 | 429;
  constructor(status: AuthError["status"], message: string) {
    super(message);
    this.name = "AuthError";
    this.status = status;
  }
}

const DAY = 86_400_000;
export const SUSPENDED = "This account is suspended. Ask the person who invited you.";
export const INVITE_DAYS = 14;
export const PAIRING_MS = 5 * 60_000;
export const RECOVERY_ITERATIONS = 600_000;

/** Codes people type: no 0/O or 1/I/L. */
const ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
export function newCode(length = 10): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return [...bytes].map((b) => ALPHABET[b % ALPHABET.length]).join("");
}
/** Codes are compared without dashes, spaces or case. */
export const normalizeCode = (code: string) => code.toUpperCase().replace(/[^0-9A-Z]/g, "");
const newToken = () => Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");

function sameHex(a: string, b: string): boolean {
  return a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

export function accountStore(pg: Pg, opts: { serverSecret: string; rateLimits?: boolean }) {
  /** Fails with 429 when `bucket` saw `max` events in the last `windowMs`, else records one. */
  async function limit(bucket: string, max: number, windowMs: number, nowMs: number): Promise<void> {
    if (opts.rateLimits === false) return;
    await pg.query("DELETE FROM rate_events WHERE at < $1", [nowMs - DAY]);
    const [row] = await pg.query<{ n: number }>("SELECT COUNT(*)::int AS n FROM rate_events WHERE bucket = $1 AND at > $2", [bucket, nowMs - windowMs]);
    if ((row?.n ?? 0) >= max) throw new AuthError(429, "Too many attempts. Try again later.");
    await pg.query("INSERT INTO rate_events (bucket, at) VALUES ($1, $2)", [bucket, nowMs]);
  }

  async function addDevice(
    q: Pick<Pg, "query">,
    accountId: string,
    d: { name: string; kind: DeviceKind },
    addedBy: string,
    nowMs: number,
    tokenHash?: string,
  ): Promise<{ id: string; token: string | null }> {
    const id = uuidv7(nowMs);
    const token = tokenHash ? null : newToken();
    await q.query("INSERT INTO devices (id, owner_id, name, kind, added_by, token_hash, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7)", [
      id,
      accountId,
      d.name,
      d.kind,
      addedBy,
      tokenHash ?? (await sha256Hex(token!)),
      nowMs,
    ]);
    return { id, token };
  }

  async function sealedKeys(accountId: string): Promise<Joined["keys"]> {
    const [k] = await pg.query<{ identity_public: string; identity_private: string; adk_wrapped: string; key_check: string }>(
      "SELECT identity_public, identity_private, adk_wrapped, key_check FROM account_keys WHERE account_id = $1",
      [accountId],
    );
    if (!k) throw new AuthError(404, "This account has no keys yet");
    return { identityPublic: k.identity_public, identityPrivate: k.identity_private, adkWrapped: k.adk_wrapped, keyCheck: k.key_check };
  }

  return {
    limit,

    /** For the operator (npm run sync:invite). Returns the code once; only its hash is kept. */
    async createInvite(email: string, nowMs = Date.now(), days = INVITE_DAYS): Promise<string> {
      const code = newCode(10);
      await pg.query("INSERT INTO invites (code_hash, email, created_at, expires_at) VALUES ($1, $2, $3, $4)", [
        await sha256Hex(code),
        email.trim().toLowerCase(),
        nowMs,
        nowMs + days * DAY,
      ]);
      return code;
    },

    async signup(body: SignupBody, ip: string, nowMs = Date.now()): Promise<Joined> {
      await limit(`signup:${ip}`, 10, 3_600_000, nowMs);
      const codeHash = await sha256Hex(normalizeCode(body.inviteCode));
      return pg.tx(async (q) => {
        const [invite] = await q.query<{ email: string; expires_at: number; used_at: number | null }>(
          "SELECT email, expires_at, used_at FROM invites WHERE code_hash = $1 FOR UPDATE",
          [codeHash],
        );
        // One message for every way an invite is wrong, so a guess learns nothing.
        if (!invite || invite.used_at !== null || invite.expires_at < nowMs || invite.email !== body.email) {
          throw new AuthError(403, "This invite code does not match this email, or it was used or has expired");
        }
        const [taken] = await q.query("SELECT 1 FROM accounts WHERE email = $1", [body.email]);
        if (taken) throw new AuthError(409, "There is already an account with this email. Sign in with your passphrase instead.");
        const accountId = uuidv7(nowMs);
        await q.query("INSERT INTO accounts (id, email, display_name, created_at) VALUES ($1, $2, $3, $4)", [accountId, body.email, body.displayName, nowMs]);
        const k = body.keys;
        await q.query(
          `INSERT INTO account_keys (account_id, identity_public, identity_private, adk_wrapped, wrap_salt, wrap_iterations, recovery_verifier, key_check, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [accountId, k.identityPublic, k.identityPrivate, k.adkWrapped, k.wrapSalt, k.wrapIterations, await sha256Hex(k.recoveryVerifier), k.keyCheck, nowMs],
        );
        await q.query("UPDATE invites SET used_at = $2, account_id = $3 WHERE code_hash = $1", [codeHash, nowMs, accountId]);
        const dev = await addDevice(q, accountId, body.device, "invite", nowMs);
        return {
          accountId,
          deviceId: dev.id,
          token: dev.token!,
          keys: { identityPublic: k.identityPublic, identityPrivate: k.identityPrivate, adkWrapped: k.adkWrapped, keyCheck: k.keyCheck },
        };
      });
    },

    /** The passphrase's salt. For an unknown email a made-up but stable one, so emails cannot be probed. */
    async recoveryStart(email: string, nowMs = Date.now()): Promise<RecoveryStart> {
      await limit(`recovery-start:${email}`, 30, 3_600_000, nowMs);
      const [k] = await pg.query<{ wrap_salt: string; wrap_iterations: number }>(
        "SELECT k.wrap_salt, k.wrap_iterations FROM account_keys k JOIN accounts a ON a.id = k.account_id WHERE a.email = $1",
        [email],
      );
      if (k) return { salt: k.wrap_salt, iterations: k.wrap_iterations };
      const fake = Buffer.from((await sha256Hex(`${opts.serverSecret}:salt:${email}`)).slice(0, 32), "hex").toString("base64");
      return { salt: fake, iterations: RECOVERY_ITERATIONS };
    },

    /**
     * The account whose passphrase proof this is, rate limited per email and per address: guessing a
     * passphrase online is slow; offline needs the database. Passphrase sign-in and the MCP login use it.
     */
    async verifyPassphrase(email: string, verifier: string, ip: string, nowMs = Date.now()): Promise<string> {
      await limit(`recovery:${email}`, 5, 3_600_000, nowMs);
      await limit(`recovery-ip:${ip}`, 20, 3_600_000, nowMs);
      const [row] = await pg.query<{ id: string; recovery_verifier: string; suspended_at: number | null }>(
        "SELECT a.id, k.recovery_verifier, a.suspended_at FROM accounts a JOIN account_keys k ON k.account_id = a.id WHERE a.email = $1",
        [email],
      );
      const given = await sha256Hex(verifier);
      if (!row || !sameHex(given, row.recovery_verifier)) throw new AuthError(401, "That email and passphrase do not match");
      // Only after the passphrase matched, so suspension tells a stranger nothing.
      if (row.suspended_at !== null) throw new AuthError(403, SUSPENDED);
      return row.id;
    },

    async recoveryFinish(email: string, verifier: string, device: { name: string; kind: DeviceKind }, ip: string, nowMs = Date.now()): Promise<Joined> {
      const accountId = await this.verifyPassphrase(email, verifier, ip, nowMs);
      const dev = await addDevice(pg, accountId, device, "passphrase", nowMs);
      return { accountId, deviceId: dev.id, token: dev.token!, keys: await sealedKeys(accountId) };
    },

    /** The account data key as its devices keep it, wrapped with the passphrase: for the health connector's sign-in page to open. */
    async wrappedAdk(accountId: string): Promise<string> {
      const [k] = await pg.query<{ adk_wrapped: string }>("SELECT adk_wrapped FROM account_keys WHERE account_id = $1", [accountId]);
      if (!k) throw new AuthError(404, "No keys for this account");
      return k.adk_wrapped;
    },

    async updateRecovery(accountId: string, b: RecoveryUpdateBody, nowMs = Date.now()): Promise<void> {
      await pg.query(
        "UPDATE account_keys SET adk_wrapped = $2, wrap_salt = $3, wrap_iterations = $4, recovery_verifier = $5, updated_at = $6 WHERE account_id = $1",
        [accountId, b.adkWrapped, b.wrapSalt, b.wrapIterations, await sha256Hex(b.recoveryVerifier), nowMs],
      );
    },

    // ---- Pairing: the new device starts, an existing one approves, the new one picks up ----

    async pairingStart(b: { ephemeralPublic: string; tokenHash: string; device: { name: string; kind: DeviceKind } }, ip: string, nowMs = Date.now()) {
      await limit(`pairing:${ip}`, 20, 3_600_000, nowMs);
      const id = newCode(6);
      await pg.query(
        `INSERT INTO pairings (id, token_hash, ephemeral_public, device_name, device_kind, created_at, expires_at) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [id, b.tokenHash, b.ephemeralPublic, b.device.name, b.device.kind, nowMs, nowMs + PAIRING_MS],
      );
      return { id, expiresAt: nowMs + PAIRING_MS };
    },

    /** For the approving device: what it is about to let in. */
    async pairingInfo(id: string, nowMs = Date.now()): Promise<{ ephemeralPublic: string; deviceName: string; deviceKind: string }> {
      const [p] = await pg.query<{ ephemeral_public: string; device_name: string; device_kind: string; expires_at: number; approved_at: number | null }>(
        "SELECT ephemeral_public, device_name, device_kind, expires_at, approved_at FROM pairings WHERE id = $1",
        [normalizeCode(id)],
      );
      if (!p || p.expires_at < nowMs || p.approved_at !== null)
        throw new AuthError(404, "That pairing code is not valid any more. Start again on the new device.");
      return { ephemeralPublic: p.ephemeral_public, deviceName: p.device_name, deviceKind: p.device_kind };
    },

    async pairingApprove(id: string, accountId: string, sealed: string, nowMs = Date.now()): Promise<{ deviceId: string }> {
      return pg.tx(async (q) => {
        const [p] = await q.query<{ token_hash: string; device_name: string; device_kind: DeviceKind; expires_at: number; approved_at: number | null }>(
          "SELECT token_hash, device_name, device_kind, expires_at, approved_at FROM pairings WHERE id = $1 FOR UPDATE",
          [normalizeCode(id)],
        );
        if (!p || p.expires_at < nowMs || p.approved_at !== null)
          throw new AuthError(404, "That pairing code is not valid any more. Start again on the new device.");
        const dev = await addDevice(q, accountId, { name: p.device_name, kind: p.device_kind }, "pairing", nowMs, p.token_hash);
        await q.query("UPDATE pairings SET account_id = $2, sealed = $3, approved_at = $4 WHERE id = $1", [normalizeCode(id), accountId, sealed, nowMs]);
        return { deviceId: dev.id };
      });
    },

    /** For the new device, proving it started the pairing with the token it made. */
    async pairingStatus(id: string, token: string, nowMs = Date.now()): Promise<PairingStatus> {
      const [p] = await pg.query<{ token_hash: string; account_id: string | null; sealed: string | null; expires_at: number; picked_up_at: number | null }>(
        "SELECT token_hash, account_id, sealed, expires_at, picked_up_at FROM pairings WHERE id = $1",
        [normalizeCode(id)],
      );
      if (!p || !sameHex(await sha256Hex(token), p.token_hash)) throw new AuthError(404, "Unknown pairing");
      if (!p.account_id || !p.sealed) return { status: p.expires_at < nowMs ? "expired" : "pending" };
      const [d] = await pg.query<{ id: string }>("SELECT id FROM devices WHERE token_hash = $1", [p.token_hash]);
      const { keyCheck } = await sealedKeys(p.account_id);
      // The sealed keys are relayed once, then forgotten.
      await pg.query("UPDATE pairings SET sealed = NULL, picked_up_at = $2 WHERE id = $1", [normalizeCode(id), nowMs]);
      return { status: "approved", accountId: p.account_id, deviceId: d?.id, sealed: p.sealed, keyCheck };
    },

    // ---- The signed-in account ----

    async me(accountId: string, deviceId: string): Promise<Me> {
      const [a] = await pg.query<{
        id: string;
        email: string;
        display_name: string;
        google_subject: string | null;
        created_at: number;
        quota_bytes: number;
        is_admin: boolean;
      }>("SELECT id, email, display_name, google_subject, created_at, quota_bytes, is_admin FROM accounts WHERE id = $1", [accountId]);
      if (!a) throw new AuthError(404, "No such account");
      const devices = await pg.query<{ id: string; name: string; kind: string; added_by: string; created_at: number; last_seen_at: number | null }>(
        "SELECT id, name, kind, added_by, created_at, last_seen_at FROM devices WHERE owner_id = $1 AND revoked_at IS NULL ORDER BY created_at",
        [accountId],
      );
      const [u] = await pg.query<{ bytes: number; rows: number }>(
        "SELECT COALESCE(SUM(length(blob)), 0)::bigint AS bytes, COUNT(*)::int AS rows FROM sync_rows WHERE owner_id = $1",
        [accountId],
      );
      return {
        account: {
          id: a.id,
          email: a.email,
          displayName: a.display_name,
          googleLinked: a.google_subject !== null,
          createdAt: a.created_at,
          isAdmin: a.is_admin,
        },
        devices: devices.map((d): DeviceInfo => ({
          id: d.id,
          name: d.name,
          kind: d.kind,
          addedBy: d.added_by,
          createdAt: d.created_at,
          lastSeenAt: d.last_seen_at,
          current: d.id === deviceId,
        })),
        usage: { bytes: u?.bytes ?? 0, rows: u?.rows ?? 0, quotaBytes: a.quota_bytes },
      };
    },

    async setDisplayName(accountId: string, name: string): Promise<void> {
      await pg.query("UPDATE accounts SET display_name = $2 WHERE id = $1", [accountId, name]);
    },

    async linkGoogle(accountId: string, subject: string): Promise<void> {
      const [other] = await pg.query<{ id: string }>("SELECT id FROM accounts WHERE google_subject = $1", [subject]);
      if (other && other.id !== accountId) throw new AuthError(409, "That Google account is linked to another Even account");
      await pg.query("UPDATE accounts SET google_subject = $2 WHERE id = $1", [accountId, subject]);
    },

    async revokeDevice(accountId: string, deviceId: string, nowMs = Date.now()): Promise<void> {
      const rows = await pg.query("UPDATE devices SET revoked_at = $3 WHERE id = $1 AND owner_id = $2 AND revoked_at IS NULL RETURNING 1", [
        deviceId,
        accountId,
        nowMs,
      ]);
      if (rows.length === 0) throw new AuthError(404, "No such device on this account");
    },

    async quotaLeft(accountId: string): Promise<number> {
      const [r] = await pg.query<{ left: number }>(
        "SELECT a.quota_bytes - COALESCE((SELECT SUM(length(blob)) FROM sync_rows WHERE owner_id = a.id), 0) AS left FROM accounts a WHERE a.id = $1",
        [accountId],
      );
      return Number(r?.left ?? 0);
    },

    /** Everything the server holds for an account, in one transaction (docs/users.md section 2.5). */
    async deleteAccount(accountId: string): Promise<void> {
      await pg.tx(async (q) => {
        await q.query("DELETE FROM share_rows WHERE share_id IN (SELECT id FROM shares WHERE owner_id = $1 OR friend_id = $1)", [accountId]);
        await q.query("DELETE FROM shares WHERE owner_id = $1 OR friend_id = $1", [accountId]);
        await q.query("DELETE FROM friendships WHERE a = $1 OR b = $1", [accountId]);
        await q.query("DELETE FROM friend_invites WHERE account_id = $1", [accountId]);
        await q.query("DELETE FROM sync_rows WHERE owner_id = $1", [accountId]);
        await q.query("DELETE FROM pairings WHERE account_id = $1", [accountId]);
        await q.query("DELETE FROM devices WHERE owner_id = $1", [accountId]);
        await q.query("DELETE FROM account_keys WHERE account_id = $1", [accountId]);
        await q.query("UPDATE invites SET account_id = NULL WHERE account_id = $1", [accountId]);
        await q.query("DELETE FROM accounts WHERE id = $1", [accountId]);
      });
    },
  };
}

export type AccountStore = ReturnType<typeof accountStore>;
