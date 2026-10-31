import * as z from "zod";
import { aesOpen, aesSeal } from "../src/domain/cloudsync/keys.js";
import { fromB64, syncKeysFromBits, type SyncKeys } from "../src/domain/cloudsync/seal.js";

/**
 * What the health connector holds for one grant (docs/users.md section 10): the two sync keys
 * (base64 of 32 bytes each, from seal.ts syncKeyBits) and the owner's time zone, from the browser
 * that signed in, since "today" on the server is UTC.
 *
 * Kept only sealed, with a key derived from the code or token it belongs to and SERVER_SECRET.
 * The server stores the SHA-256 of codes and tokens, never the values, so the sealed keys open
 * only for a request that brings a live token: Claude's.
 */
const raw32 = z.string().regex(/^[A-Za-z0-9+/]{43}=$/, "32 bytes, base64");
export const connectorKeys = z.object({ mac: raw32, enc: raw32, timeZone: z.string().min(1).max(64) });
export type ConnectorKeys = z.infer<typeof connectorKeys>;

/** What a sealed copy is for: it opens only as that kind of secret. */
export type KeyHolder = "code" | "access" | "refresh";

async function holderKey(secret: string, serverSecret: string, holder: KeyHolder): Promise<CryptoKey> {
  const enc = new TextEncoder();
  const base = await crypto.subtle.importKey("raw", enc.encode(secret), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: enc.encode(serverSecret), info: enc.encode(`even-connector-${holder}-v1`) },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function sealConnectorKeys(keys: ConnectorKeys, secret: string, serverSecret: string, holder: KeyHolder): Promise<string> {
  return aesSeal(await holderKey(secret, serverSecret, holder), new TextEncoder().encode(JSON.stringify(keys)), holder);
}

/** Throws when the secret is not the one the keys were sealed with. */
export async function openConnectorKeys(sealed: string, secret: string, serverSecret: string, holder: KeyHolder): Promise<ConnectorKeys> {
  const plain = await aesOpen(await holderKey(secret, serverSecret, holder), sealed, holder);
  return connectorKeys.parse(JSON.parse(new TextDecoder().decode(plain)));
}

export const syncKeysOf = (k: ConnectorKeys): Promise<SyncKeys> => syncKeysFromBits({ mac: fromB64(k.mac), enc: fromB64(k.enc) });
