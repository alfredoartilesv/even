import type { SqlValue } from "../../db/driver.js";

/**
 * End-to-end encryption for cloud sync. One 32-byte sync secret (kept in the Keystore, shared by
 * the owner's devices) gives two keys through HKDF: an HMAC key that turns a row's natural key
 * into the opaque key the server indexes, and an AES-256-GCM key that seals the row. The table and
 * opaque key are bound as additional data, so the server cannot move a blob to another row.
 */
export interface SyncKeys {
  mac: CryptoKey;
  enc: CryptoKey;
}

export const SYNC_SECRET_BYTES = 32;

export async function syncKeys(secret: Uint8Array): Promise<SyncKeys> {
  if (secret.length !== SYNC_SECRET_BYTES) throw new Error(`The sync secret must be ${SYNC_SECRET_BYTES} bytes`);
  const base = await crypto.subtle.importKey("raw", secret as BufferSource, "HKDF", false, ["deriveKey"]);
  const derive = (info: string, alg: HmacImportParams | AesKeyGenParams, usages: KeyUsage[]) =>
    crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: new TextEncoder().encode(info) }, base, alg, false, usages);
  return {
    mac: await derive("even-sync-key-v1", { name: "HMAC", hash: "SHA-256", length: 256 }, ["sign"]),
    enc: await derive("even-sync-row-v1", { name: "AES-GCM", length: 256 }, ["encrypt", "decrypt"]),
  };
}

/**
 * The two keys' raw bits (the same HKDF outputs syncKeys derives), for the health connector: the
 * owner's browser derives them on its sign-in page (server/oauth.ts) and hands the server only
 * these, never the secret, which also opens the identity key and so friends' shares.
 */
export async function syncKeyBits(secret: Uint8Array): Promise<{ mac: Uint8Array; enc: Uint8Array }> {
  const base = await crypto.subtle.importKey("raw", secret as BufferSource, "HKDF", false, ["deriveBits"]);
  const bits = async (info: string) =>
    new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: new TextEncoder().encode(info) }, base, 256));
  return { mac: await bits("even-sync-key-v1"), enc: await bits("even-sync-row-v1") };
}

export async function syncKeysFromBits(bits: { mac: Uint8Array; enc: Uint8Array }): Promise<SyncKeys> {
  if (bits.mac.length !== 32 || bits.enc.length !== 32) throw new Error("Sync keys are 32 bytes each");
  return {
    mac: await crypto.subtle.importKey("raw", bits.mac as BufferSource, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]),
    enc: await crypto.subtle.importKey("raw", bits.enc as BufferSource, "AES-GCM", false, ["encrypt", "decrypt"]),
  };
}

/** The server's key for a row: HMAC(table, natural key), hex. Same row, same key, on every device. */
export async function rowKey(keys: SyncKeys, tbl: string, natural: SqlValue[]): Promise<string> {
  const mac = await crypto.subtle.sign("HMAC", keys.mac, new TextEncoder().encode(JSON.stringify([tbl, ...natural])));
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** A row as it travels: its columns and values, so a device with a newer schema can read an older row. */
export interface PlainRow {
  c: string[];
  v: SqlValue[];
}

const aad = (tbl: string, key: string) => new TextEncoder().encode(`${tbl}:${key}`);

export async function seal(keys: SyncKeys, tbl: string, key: string, row: PlainRow): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad(tbl, key) }, keys.enc, new TextEncoder().encode(JSON.stringify(row))),
  );
  const out = new Uint8Array(iv.length + sealed.length);
  out.set(iv);
  out.set(sealed, iv.length);
  return toB64(out);
}

/** Throws when the blob was not sealed for this table and key with this secret. */
export async function open(keys: SyncKeys, tbl: string, key: string, blob: string): Promise<PlainRow> {
  const bytes = fromB64(blob);
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes.subarray(0, 12), additionalData: aad(tbl, key) }, keys.enc, bytes.subarray(12));
  return JSON.parse(new TextDecoder().decode(plain)) as PlainRow;
}

export function toB64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function fromB64(s: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}
