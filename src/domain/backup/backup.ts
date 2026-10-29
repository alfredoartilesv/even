import { z } from "zod";
import type { SqlDriver, SqlValue } from "../../db/driver";
import { DEVICE_ID_KEY, getSetting, setSetting } from "../../db/settings";
import { createLogger } from "../../core/log";
import { assertBackupOwner, getOwner } from "../account/account";

const log = createLogger("backup");

/**
 * Encrypted manual backup (docs/architecture.md: the phone holds the only copy of
 * user-authored data, and on the FREE plan also the only copy of samples older than 7 days).
 *
 * File = JSON envelope { format, version, kdf, cipher, data } where data is
 * base64(AES-256-GCM(gzip(JSON payload))). The key comes from the user's password via
 * PBKDF2-SHA256, and the envelope header is bound as GCM additional data, so editing
 * any part of the file makes decryption fail. Secrets are not in SQLite, so never in here.
 */

export interface BackupTable {
  name: string;
  /** Conflict target used on restore. */
  key: string[];
  /** Restore keeps whichever row has the newer updated_at. Otherwise existing rows win. */
  lastWriteWins: boolean;
  /** About this install only (cloud sync cursors): never exported, never restored. */
  deviceLocal?: true;
}

/** Every table, in restore order (parents before children). A test keeps this in step with the schema. */
export const BACKUP_TABLES: BackupTable[] = [
  { name: "app_settings", key: ["key"], lastWriteWins: true },
  { name: "account", key: ["id"], lastWriteWins: true },
  { name: "sync_state", key: ["source"], lastWriteWins: true },
  { name: "metric_catalog", key: ["source", "metric"], lastWriteWins: true },
  { name: "health_samples", key: ["source", "device", "metric", "external_id"], lastWriteWins: true },
  { name: "food_photos", key: ["id"], lastWriteWins: true },
  { name: "saved_meals", key: ["id"], lastWriteWins: true },
  { name: "food_entries", key: ["id"], lastWriteWins: true },
  { name: "drink_types", key: ["id"], lastWriteWins: true },
  { name: "drink_entries", key: ["id"], lastWriteWins: true },
  { name: "manual_measurements", key: ["id"], lastWriteWins: true },
  { name: "day_notes", key: ["id"], lastWriteWins: true },
  { name: "goals", key: ["id"], lastWriteWins: true },
  { name: "chat_conversations", key: ["id"], lastWriteWins: true },
  { name: "chat_messages", key: ["id"], lastWriteWins: true },
  { name: "ai_disclosures", key: ["id"], lastWriteWins: true },
  { name: "agent_actions", key: ["id"], lastWriteWins: true },
  { name: "consents", key: ["id"], lastWriteWins: true },
  { name: "meal_preps", key: ["id"], lastWriteWins: true },
  { name: "meal_prep_ingredients", key: ["id"], lastWriteWins: true },
  { name: "meal_prep_tags", key: ["id"], lastWriteWins: true },
  { name: "meal_prep_batches", key: ["id"], lastWriteWins: true },
  { name: "meal_prep_moves", key: ["id"], lastWriteWins: true },
  { name: "shopping_list_items", key: ["id"], lastWriteWins: true },
  { name: "shopping_trips", key: ["id"], lastWriteWins: true },
  { name: "sync_runs", key: ["id"], lastWriteWins: false },
  { name: "cloud_sync_cursors", key: ["name"], lastWriteWins: false, deviceLocal: true },
  { name: "cloud_sync_outbox", key: ["tbl", "row_id"], lastWriteWins: false, deviceLocal: true },
  { name: "cloud_sync_pulling", key: ["started_at"], lastWriteWins: false, deviceLocal: true },
];

const FORMAT = "even-backup";
const PAYLOAD_FORMAT = "even-data";
// Written before the app was renamed to Even; still restored.
const OLD_FORMAT = "health-app-backup";
const OLD_PAYLOAD_FORMAT = "health-app-data";
const DEFAULT_ITERATIONS = 600_000;
const PAGE = 2000;
const MAX_PARAMS = 900; // stay under SQLite's historic 999 bound-parameter limit

const sqlValue = z.union([z.string(), z.number(), z.null()]);
const envelopeSchema = z.object({
  format: z.union([z.literal(FORMAT), z.literal(OLD_FORMAT)]),
  version: z.literal(1),
  kdf: z.object({
    name: z.literal("PBKDF2"),
    hash: z.literal("SHA-256"),
    iterations: z.number().int().min(1).max(10_000_000),
    salt: z.string(),
  }),
  cipher: z.object({ name: z.literal("AES-GCM"), iv: z.string() }),
  data: z.string(),
});
const payloadSchema = z.object({
  format: z.union([z.literal(PAYLOAD_FORMAT), z.literal(OLD_PAYLOAD_FORMAT)]),
  schemaVersion: z.number().int().min(0),
  exportedAt: z.number(),
  /** The sync account this device was connected to when the backup was made: the backup's owner. */
  syncAccountId: z.string().max(64).optional(),
  tables: z.record(z.string(), z.object({ columns: z.array(z.string()), rows: z.array(z.array(sqlValue)) })),
});
type Payload = z.infer<typeof payloadSchema>;

export class BackupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BackupError";
  }
}

export async function exportBackup(
  db: SqlDriver,
  password: string,
  opts: { now?: number; iterations?: number; syncAccountId?: string | null } = {},
): Promise<{ text: string; rows: Record<string, number> }> {
  if (password.length < 8) throw new BackupError("Use a backup password of at least 8 characters");
  const done = log.time("backup exported", "info");
  const payload: Payload = {
    format: PAYLOAD_FORMAT,
    schemaVersion: await schemaVersion(db),
    exportedAt: opts.now ?? Date.now(),
    ...(opts.syncAccountId ? { syncAccountId: opts.syncAccountId } : {}),
    tables: {},
  };
  const counts: Record<string, number> = {};
  for (const t of BACKUP_TABLES) {
    if (t.deviceLocal) continue;
    const columns = await tableColumns(db, t.name);
    if (columns.length === 0) continue; // not in this schema version yet
    const rows: SqlValue[][] = [];
    for (let offset = 0; ; offset += PAGE) {
      const page = await db.all<Record<string, SqlValue>>(`SELECT * FROM ${t.name} ORDER BY rowid LIMIT ? OFFSET ?`, [PAGE, offset]);
      for (const r of page) rows.push(columns.map((c) => r[c] ?? null));
      if (page.length < PAGE) break;
    }
    payload.tables[t.name] = { columns, rows };
    counts[t.name] = rows.length;
  }

  const iterations = opts.iterations ?? DEFAULT_ITERATIONS;
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const header = {
    format: FORMAT,
    version: 1 as const,
    kdf: { name: "PBKDF2" as const, hash: "SHA-256" as const, iterations, salt: toB64(salt) },
    cipher: { name: "AES-GCM" as const, iv: toB64(iv) },
  };
  const key = await deriveKey(password, salt, iterations);
  const plain = await gzip(new TextEncoder().encode(JSON.stringify(payload)));
  const sealed = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad(header) }, key, plain);
  const text = JSON.stringify({ ...header, data: toB64(new Uint8Array(sealed)) });
  done({ tables: Object.keys(counts).length, rows: Object.values(counts).reduce((a, b) => a + b, 0), bytes: text.length, iterations });
  return { text, rows: counts };
}

export interface RestoreReport {
  schemaVersion: number;
  exportedAt: number;
  /** Rows read from the file per table (inserted, updated, or kept as they were). */
  rows: Record<string, number>;
}

/** The live owner row in a backup's account table, if the backup has one. */
function liveOwnerIn(payload: Payload): { subject: string; email: string | null } | null {
  const part = payload.tables.account;
  if (!part) return null;
  const col = (name: string) => part.columns.indexOf(name);
  const [id, subject, email, deleted] = ["id", "subject", "email", "deleted_at"].map(col);
  const row = part.rows.find((r) => r[id] === "owner" && (deleted < 0 || r[deleted] === null));
  return row && typeof row[subject] === "string" ? { subject: row[subject] as string, email: (row[email] as string | null) ?? null } : null;
}

/** Merge a backup into the database in one transaction: all of it, or nothing. */
export async function restoreBackup(db: SqlDriver, fileText: string, password: string, opts: { syncAccountId?: string | null } = {}): Promise<RestoreReport> {
  let envelope: z.infer<typeof envelopeSchema>;
  try {
    envelope = envelopeSchema.parse(JSON.parse(fileText));
  } catch {
    log.warn("restore refused: not a backup file");
    throw new BackupError("This is not an Even backup file");
  }
  const { data, ...header } = envelope;

  let payload: Payload;
  try {
    const key = await deriveKey(password, fromB64(header.kdf.salt), header.kdf.iterations);
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromB64(header.cipher.iv), additionalData: aad(header) }, key, fromB64(data));
    payload = payloadSchema.parse(JSON.parse(new TextDecoder().decode(await gunzip(new Uint8Array(plain)))));
  } catch {
    log.warn("restore refused: wrong password or damaged file");
    throw new BackupError("Wrong password, or the file is damaged");
  }

  const current = await schemaVersion(db);
  if (payload.schemaVersion > current) {
    log.warn("restore refused: backup from a newer schema", { backup: payload.schemaVersion, current });
    throw new BackupError(`This backup comes from a newer app (schema ${payload.schemaVersion}, this app has ${current}). Update the app first.`);
  }

  // Never merge another account's data into this device's: the sync account when both know it, else the Google owner.
  try {
    assertBackupOwner({
      syncAccountId: opts.syncAccountId ?? null,
      backupSyncAccountId: payload.syncAccountId ?? null,
      owner: await getOwner(db),
      backupOwner: liveOwnerIn(payload),
    });
  } catch (err) {
    log.warn("restore refused: backup belongs to another account");
    throw new BackupError((err as Error).message);
  }

  const counts: Record<string, number> = {};
  const done = log.time("backup restored", "info");
  await db.exec("BEGIN");
  try {
    for (const t of BACKUP_TABLES) {
      const part = payload.tables[t.name];
      if (!part || t.deviceLocal) continue;
      counts[t.name] = await mergeRows(db, t, part.columns, part.rows);
    }
    await db.exec("COMMIT");
  } catch (err) {
    await db.exec("ROLLBACK");
    log.error("restore failed, rolled back", { err });
    throw new BackupError(`Restore failed, nothing was changed: ${(err as Error).message}`);
  }
  done({ schemaVersion: payload.schemaVersion, tables: Object.keys(counts).length, rows: Object.values(counts).reduce((a, b) => a + b, 0) });
  return { schemaVersion: payload.schemaVersion, exportedAt: payload.exportedAt, rows: counts };
}

/**
 * Upserts rows given as (columns, values) into one table: newer updated_at wins on lastWriteWins
 * tables, existing rows win on the rest. Restore and cloud sync (src/domain/cloudsync) both use it.
 */
export async function mergeRows(db: SqlDriver, t: BackupTable, fileColumns: string[], rows: SqlValue[][]): Promise<number> {
  // Only columns this schema has: guards against SQL injection through column names, and lets
  // an older backup (fewer columns) restore into a newer schema.
  const known = new Set(await tableColumns(db, t.name));
  if (known.size === 0) throw new Error(`${t.name}: table missing from this database`);
  const keep = fileColumns.map((c, i) => [c, i] as const).filter(([c]) => known.has(c));
  const cols = keep.map(([c]) => c);
  for (const k of t.key) {
    if (!cols.includes(k)) throw new Error(`${t.name}: backup is missing key column ${k}`);
  }
  let selected = rows.map((r) => keep.map(([, i]) => r[i] ?? null));
  if (t.name === "app_settings") {
    const k = cols.indexOf("key");
    selected = selected.filter((r) => r[k] !== DEVICE_ID_KEY); // this install keeps its own id
  }
  if (selected.length === 0) return 0;

  const updatable = cols.filter((c) => !t.key.includes(c) && c !== "id");
  const lww = t.lastWriteWins && cols.includes("updated_at");
  const onConflict =
    lww && updatable.length > 0
      ? `ON CONFLICT (${t.key.join(", ")}) DO UPDATE SET ${updatable.map((c) => `${c} = excluded.${c}`).join(", ")}
         WHERE excluded.updated_at > ${t.name}.updated_at`
      : `ON CONFLICT (${t.key.join(", ")}) DO NOTHING`;

  const perBatch = Math.max(1, Math.floor(MAX_PARAMS / cols.length));
  const tuple = `(${cols.map(() => "?").join(", ")})`;
  for (let i = 0; i < selected.length; i += perBatch) {
    const batch = selected.slice(i, i + perBatch);
    await db.run(`INSERT INTO ${t.name} (${cols.join(", ")}) VALUES ${batch.map(() => tuple).join(", ")} ${onConflict}`, batch.flat());
  }
  return selected.length;
}

async function tableColumns(db: SqlDriver, table: string): Promise<string[]> {
  // `table` always comes from BACKUP_TABLES, never from the file.
  const rows = await db.all<{ name: string }>(`PRAGMA table_info(${table})`);
  return rows.map((r) => r.name);
}

async function schemaVersion(db: SqlDriver): Promise<number> {
  const rows = await db.all<{ user_version: number }>("PRAGMA user_version");
  return Number(rows[0]?.user_version ?? 0);
}

async function deriveKey(password: string, salt: Uint8Array, iterations: number): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "PBKDF2", hash: "SHA-256", salt: salt as BufferSource, iterations }, base, { name: "AES-GCM", length: 256 }, false, [
    "encrypt",
    "decrypt",
  ]);
}

function aad(header: object): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(JSON.stringify(header));
}

async function pipe(bytes: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array<ArrayBuffer>> {
  const out = new Blob([bytes as BlobPart]).stream().pipeThrough(stream);
  return new Uint8Array(await new Response(out).arrayBuffer());
}
const gzip = (b: Uint8Array) => pipe(b, new CompressionStream("gzip"));
const gunzip = (b: Uint8Array) => pipe(b, new DecompressionStream("gzip"));

function toB64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function fromB64(b64: string): Uint8Array<ArrayBuffer> {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

// ---- When the last backup was saved (shown on the privacy page) ----

export const LAST_BACKUP_KEY = "backup.last_saved_ms";

/** Record that a backup file was saved (call after the share sheet or download, not on export). */
export async function markBackupSaved(db: SqlDriver, nowMs: number = Date.now()): Promise<void> {
  await setSetting(db, LAST_BACKUP_KEY, String(nowMs), nowMs);
}

export async function lastBackupSaved(db: SqlDriver): Promise<number | null> {
  const v = Number(await getSetting(db, LAST_BACKUP_KEY));
  return Number.isFinite(v) && v > 0 ? v : null;
}
