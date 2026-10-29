import { createLogger } from "../../core/log";
import type { SqlDriver } from "../../db/driver";

/**
 * The Google account that owns this phone's data (migration 0007). One owner per install:
 * the first sign-in binds the account and adopts everything already stored; a different
 * account is told whose data this is and nothing changes. Signing in is optional: the app
 * works without it, and the data on the phone is protected by SQLCipher either way, not by
 * the sign-in (it is identity, not a lock).
 *
 * What is kept: Google's stable account id (sub), email, whether Google verified it, name,
 * and times. No token is stored. Logs never contain the email or the id.
 */

const log = createLogger("account");

export interface GoogleIdentity {
  /** The `sub` claim: Google's stable id for the account. */
  subject: string;
  email: string | null;
  emailVerified: boolean;
  name: string | null;
}

export interface Owner extends GoogleIdentity {
  provider: "google";
  boundAtMs: number;
  lastSignInMs: number | null;
  signedIn: boolean;
}

const ISSUERS = new Set(["accounts.google.com", "https://accounts.google.com"]);
/** Clock skew allowed when checking expiry. */
const SKEW_MS = 5 * 60_000;

function base64UrlJson(part: string): Record<string, unknown> {
  const b64 = part
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(part.length / 4) * 4, "=");
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
}

/**
 * Read the identity out of a Google ID token and check its claims: issuer, audience (our Web
 * client id), expiry and subject. The signature is not checked here: the token comes straight
 * from Android's Credential Manager over the native bridge, and it is only used to label who
 * owns this phone's data. A server that trusts it (phase 2 sync) must verify the signature.
 * Throws a message safe to show.
 */
export function parseGoogleIdToken(idToken: string, opts: { webClientId: string; now?: number }): GoogleIdentity {
  const parts = idToken.split(".");
  if (parts.length !== 3) throw new Error("Google sign-in returned an unreadable token");
  let claims: Record<string, unknown>;
  try {
    claims = base64UrlJson(parts[1]);
  } catch {
    throw new Error("Google sign-in returned an unreadable token");
  }
  const now = opts.now ?? Date.now();
  if (!ISSUERS.has(String(claims.iss))) throw new Error("The sign-in token was not issued by Google");
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(opts.webClientId)) throw new Error("The sign-in token is for a different app (check the Google Web client id)");
  if (typeof claims.exp !== "number" || claims.exp * 1000 < now - SKEW_MS) throw new Error("The sign-in token has expired; sign in again");
  if (typeof claims.sub !== "string" || !claims.sub) throw new Error("The sign-in token has no account id");
  return {
    subject: claims.sub,
    email: typeof claims.email === "string" ? claims.email : null,
    emailVerified: claims.email_verified === true || claims.email_verified === "true",
    name: typeof claims.name === "string" ? claims.name : null,
  };
}

export async function getOwner(db: SqlDriver): Promise<Owner | null> {
  const [r] = await db.all<{
    subject: string;
    email: string | null;
    email_verified: number;
    name: string | null;
    bound_at_ms: number;
    last_sign_in_ms: number | null;
    signed_in: number;
  }>(
    `SELECT subject, email, email_verified, name, bound_at_ms, last_sign_in_ms, signed_in
     FROM account WHERE id = 'owner' AND deleted_at IS NULL`,
  );
  if (!r) return null;
  return {
    provider: "google",
    subject: r.subject,
    email: r.email,
    emailVerified: r.email_verified === 1,
    name: r.name,
    boundAtMs: r.bound_at_ms,
    lastSignInMs: r.last_sign_in_ms,
    signedIn: r.signed_in === 1,
  };
}

export type SignInOutcome =
  /** First sign-in on this phone: the account now owns the data already here. */
  | { status: "bound"; owner: Owner }
  /** The owner signed in again. Email and name are refreshed. */
  | { status: "signed_in"; owner: Owner }
  /** Another account owns this phone's data. Nothing changed. */
  | { status: "other_owner"; ownerEmail: string | null };

export async function applySignIn(db: SqlDriver, id: GoogleIdentity, deviceId: string, now: number = Date.now()): Promise<SignInOutcome> {
  const owner = await getOwner(db);
  if (owner && owner.subject !== id.subject) {
    log.warn("sign-in with an account that does not own this data");
    return { status: "other_owner", ownerEmail: owner.email };
  }
  if (!owner) {
    // A released (soft-deleted) row may still be there; the new owner replaces it.
    await db.run(
      `INSERT INTO account (id, provider, subject, email, email_verified, name, bound_at_ms, last_sign_in_ms, signed_in,
                            created_at, updated_at, deleted_at, origin_device_id)
       VALUES ('owner', 'google', ?, ?, ?, ?, ?, ?, 1, ?, ?, NULL, ?)
       ON CONFLICT (id) DO UPDATE SET provider = excluded.provider, subject = excluded.subject, email = excluded.email,
         email_verified = excluded.email_verified, name = excluded.name, bound_at_ms = excluded.bound_at_ms,
         last_sign_in_ms = excluded.last_sign_in_ms, signed_in = 1, updated_at = excluded.updated_at, deleted_at = NULL,
         origin_device_id = excluded.origin_device_id`,
      [id.subject, id.email, id.emailVerified ? 1 : 0, id.name, now, now, now, now, deviceId],
    );
    log.info("account bound to this phone's data");
    return { status: "bound", owner: (await getOwner(db))! };
  }
  await db.run(
    `UPDATE account SET email = ?, email_verified = ?, name = ?, last_sign_in_ms = ?, signed_in = 1, updated_at = ?
     WHERE id = 'owner'`,
    [id.email, id.emailVerified ? 1 : 0, id.name, now, now],
  );
  log.info("owner signed in");
  return { status: "signed_in", owner: (await getOwner(db))! };
}

/** End the local session. The data stays bound to the owner. */
export async function signOut(db: SqlDriver, now: number = Date.now()): Promise<void> {
  await db.run("UPDATE account SET signed_in = 0, updated_at = ? WHERE id = 'owner' AND deleted_at IS NULL", [now]);
  log.info("owner signed out");
}

/**
 * Unbind the owner (for example when moving to another Google account). The data stays on the
 * phone and the next account that signs in becomes its owner. The UI must confirm this first.
 */
export async function releaseOwnership(db: SqlDriver, now: number = Date.now()): Promise<void> {
  await db.run("UPDATE account SET signed_in = 0, deleted_at = ?, updated_at = ? WHERE id = 'owner' AND deleted_at IS NULL", [now, now]);
  log.info("ownership released");
}

/**
 * Restore guard with one identity (docs/users.md, decided 28 Oct 2026): the sync account is the
 * user. When this device is connected and the backup names the sync account it was made on, those
 * two must match. Otherwise (a phone that never connected, or a backup from before) the Google
 * owner check below decides. Throws a message safe to show.
 */
export function assertBackupOwner(o: {
  syncAccountId: string | null;
  backupSyncAccountId: string | null;
  owner: Owner | null;
  backupOwner: { subject: string; email: string | null } | null;
}): void {
  if (o.syncAccountId && o.backupSyncAccountId) {
    if (o.syncAccountId !== o.backupSyncAccountId)
      throw new Error("This backup belongs to another Even account. Restore it on a device connected to that account, or on one that is not connected.");
    return;
  }
  assertSameOwner(o.owner, o.backupOwner?.subject ?? null, o.backupOwner?.email ?? null);
}

/**
 * Restore guard: a backup whose data belongs to another Google account must not be merged in.
 * `backupSubject` is the live owner in the backup file, if any. Throws a message safe to show.
 */
export function assertSameOwner(current: Owner | null, backupSubject: string | null, backupEmail: string | null): void {
  if (current && backupSubject && current.subject !== backupSubject) {
    throw new Error(
      `This backup belongs to another Google account${backupEmail ? ` (${backupEmail})` : ""}. Restore it on a phone owned by that account, or release ownership here first.`,
    );
  }
}
