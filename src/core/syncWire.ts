import * as z from "zod/mini";

/**
 * The cloud sync wire format, shared by the phone (src/domain/cloudsync) and the server
 * (server/). The server only ever sees what is here: a table name, an opaque row key (an HMAC
 * the phone makes, so not the row's id or metric), the row's updated_at, and a sealed blob.
 * Everything else stays encrypted end to end (docs/architecture.md section 6).
 */

/** Rows per push or pull page. The server refuses bigger pushes. */
export const SYNC_PAGE = 500;
/** A sealed row is a few hundred bytes; a food photo (up to 1.5 MB, MAX_PHOTO_BYTES) seals to about 2.7 MB. */
export const MAX_BLOB_CHARS = 3_500_000;
/** Vercel refuses request bodies over 4.5 MB, so the phone splits a push page to stay under this. */
export const MAX_PUSH_BYTES = 4_000_000;

export const syncRow = z.object({
  tbl: z.string().check(z.regex(/^[a-z][a-z0-9_]{0,62}$/)),
  key: z.string().check(z.regex(/^[0-9a-f]{64}$/)),
  updatedAt: z.int().check(z.nonnegative()),
  blob: z.string().check(z.minLength(1), z.maxLength(MAX_BLOB_CHARS)),
});
export type SyncRow = z.infer<typeof syncRow>;

export const pushBody = z.object({ rows: z.array(syncRow).check(z.maxLength(SYNC_PAGE)) });
export type PushBody = z.infer<typeof pushBody>;

export interface PushResult {
  /** Rows the server took: new, or newer than the copy it had. */
  accepted: number;
  /** Rows the server already had in the same or a newer version. */
  ignored: number;
}

export interface PulledRow extends SyncRow {
  seq: number;
}

export interface PullResult {
  rows: PulledRow[];
  /** Pass as `after` next time. */
  next: number;
  more: boolean;
}

// ---- Accounts, devices, pairing (docs/users.md section 2) ----

const b64 = (max: number) => z.string().check(z.minLength(1), z.maxLength(max), z.regex(/^[A-Za-z0-9+/_=-]+$/));
const email = z.string().check(z.trim(), z.toLowerCase(), z.minLength(3), z.maxLength(254), z.regex(/^[^\s@]+@[^\s@]+$/));
const label = z.string().check(z.trim(), z.minLength(1), z.maxLength(60));
export const DEVICE_KINDS = ["phone", "web", "pc"] as const;
export type DeviceKind = (typeof DEVICE_KINDS)[number];
const device = z.object({ name: label, kind: z.enum(DEVICE_KINDS) });

/** The account's keys as the server keeps them: all sealed or public (src/domain/cloudsync/keys.ts). */
export const accountKeys = z.object({
  identityPublic: z.string().check(z.minLength(1), z.maxLength(2_000)),
  identityPrivate: b64(4_000),
  adkWrapped: b64(1_000),
  wrapSalt: b64(100),
  wrapIterations: z.int().check(z.gte(100_000), z.lte(10_000_000)),
  /** The passphrase's auth key (not the key that unwraps adkWrapped); the server stores its SHA-256. */
  recoveryVerifier: b64(200),
  keyCheck: b64(200),
});
export type AccountKeys = z.infer<typeof accountKeys>;

export const signupBody = z.object({
  inviteCode: z.string().check(z.trim(), z.minLength(6), z.maxLength(40)),
  email,
  displayName: label,
  device,
  keys: accountKeys,
});
export type SignupBody = z.infer<typeof signupBody>;

export const recoveryStartBody = z.object({ email });
export interface RecoveryStart {
  salt: string;
  iterations: number;
}
export const recoveryFinishBody = z.object({ email, verifier: b64(200), device });
export type RecoveryFinishBody = z.infer<typeof recoveryFinishBody>;

export const recoveryUpdateBody = z.object({
  adkWrapped: b64(1_000),
  wrapSalt: b64(100),
  wrapIterations: accountKeys.shape.wrapIterations,
  recoveryVerifier: b64(200),
});
export type RecoveryUpdateBody = z.infer<typeof recoveryUpdateBody>;

/** What a device gets when it joins: its token (shown once) and the account's sealed keys. */
export interface Joined {
  accountId: string;
  deviceId: string;
  token: string;
  keys: Pick<AccountKeys, "identityPublic" | "identityPrivate" | "adkWrapped" | "keyCheck">;
}

export const pairingStartBody = z.object({
  ephemeralPublic: z.string().check(z.minLength(1), z.maxLength(2_000)),
  tokenHash: z.string().check(z.regex(/^[0-9a-f]{64}$/)),
  device,
});
export const pairingApproveBody = z.object({ sealed: b64(20_000) });
export interface PairingStatus {
  status: "pending" | "approved" | "expired";
  accountId?: string;
  deviceId?: string;
  sealed?: string;
  keyCheck?: string;
}

export interface DeviceInfo {
  id: string;
  name: string;
  kind: string;
  addedBy: string;
  createdAt: number;
  lastSeenAt: number | null;
  current: boolean;
}

export interface Me {
  account: { id: string; email: string; displayName: string; googleLinked: boolean; createdAt: number; isAdmin: boolean };
  devices: DeviceInfo[];
  usage: { bytes: number; quotaBytes: number; rows: number };
}

export const profileBody = z.object({ displayName: label });
export const googleLinkBody = z.object({ idToken: z.string().check(z.minLength(20), z.maxLength(5_000)) });

// ---- Friends and shares (docs/users.md section 2.4) ----

/** What a friend can be shown, as daily summaries. Never notes, chats, photos or food names. */
export const SHARE_KINDS = ["activity", "sleep", "recovery", "weight", "nutrition", "alcohol"] as const;
export type ShareKind = (typeof SHARE_KINDS)[number];
/** How far back a friend sees (decided 28 Oct 2026). */
export const SHARE_DAYS = 90;

export const friendAcceptBody = z.object({ code: z.string().check(z.trim(), z.minLength(6), z.maxLength(40)) });
export interface Friend {
  accountId: string;
  displayName: string;
  identityPublic: string;
  since: number;
}

export const shareBody = z.object({ friendId: z.string().check(z.minLength(1), z.maxLength(64)), kind: z.enum(SHARE_KINDS), wrappedKey: b64(1_000) });
export interface Share {
  id: string;
  ownerId: string;
  friendId: string;
  kind: ShareKind;
  wrappedKey: string;
  createdAt: number;
}

export const shareRow = z.object({ day: z.string().check(z.regex(/^\d{4}-\d{2}-\d{2}$/)), updatedAt: z.int().check(z.nonnegative()), blob: b64(20_000) });
export type ShareRow = z.infer<typeof shareRow>;
export const shareRowsBody = z.object({ rows: z.array(shareRow).check(z.maxLength(SHARE_DAYS * 2)) });
export interface ShareRowsResult {
  rows: (ShareRow & { seq: number })[];
  next: number;
  more: boolean;
}

// ---- Admin (docs/users.md section 2.6): accounts, invites and devices; never a sealed row ----

/** Where an admin action came from: the app's Settings > Admin, Claude through the MCP server, or the CLI. */
export const ADMIN_VIA = ["app", "mcp", "cli"] as const;
export type AdminVia = (typeof ADMIN_VIA)[number];

export const INVITE_MAX_DAYS = 30;
export const adminInviteBody = z.object({ email, days: z.optional(z.int().check(z.gte(1), z.lte(INVITE_MAX_DAYS))) });
export type AdminInviteBody = z.infer<typeof adminInviteBody>;
/** Quotas between 10 MB and 2 GB (Neon's free plan holds 0.5 GB for everyone). */
export const QUOTA_MIN_BYTES = 10 * 1_048_576;
export const QUOTA_MAX_BYTES = 2_048 * 1_048_576;
export const quotaBody = z.object({ bytes: z.int().check(z.gte(QUOTA_MIN_BYTES), z.lte(QUOTA_MAX_BYTES)) });
export const suspendBody = z.object({ suspended: z.boolean() });

export interface AdminInvite {
  /** The code's hash: the code itself is shown once, when it is made. */
  id: string;
  email: string;
  createdAt: number;
  expiresAt: number;
  status: "open" | "used" | "expired" | "cancelled";
  usedAt: number | null;
}

export interface AdminAccount {
  id: string;
  email: string;
  displayName: string;
  createdAt: number;
  isAdmin: boolean;
  suspendedAt: number | null;
  devices: number;
  lastSeenAt: number | null;
  bytes: number;
  quotaBytes: number;
  friends: number;
}

export interface AdminDevice {
  id: string;
  name: string;
  kind: string;
  addedBy: string;
  createdAt: number;
  lastSeenAt: number | null;
  revokedAt: number | null;
}

export interface AuditEntry {
  id: string;
  at: number;
  actor: string;
  via: AdminVia;
  action: string;
  target: string | null;
  detail: string | null;
}

export interface ServiceHealth {
  /** The deployed commit on Vercel (VERCEL_GIT_COMMIT_SHA), else "local". */
  build: string;
  database: "ok";
  accounts: number;
  devices: number;
  bytes: number;
  openInvites: number;
}

/** Where the health connector is on the sync server (docs/users.md section 10). */
export const HEALTH_MCP_PATH = "/mcp/health";

/** One sign-in of Claude (or another MCP client), as an admin or to the health connector: an access token and its refresh token. */
export interface McpGrant {
  id: string;
  clientId: string;
  clientName: string;
  createdAt: number;
  lastUsedAt: number | null;
  accessExpiresAt: number;
}
