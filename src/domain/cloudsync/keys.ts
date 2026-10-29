import { fromB64, SYNC_SECRET_BYTES, toB64 } from "./seal";

/**
 * The account's keys (docs/users.md section 2): the account data key (ADK, the sync secret every
 * device of an account holds), the identity key pair (ECDH P-256: friends' share keys are wrapped
 * with it), the passphrase's two keys (one unwraps the ADK, the other proves the passphrase to
 * the server), and the pairing seal (keys handed to a new device through the server, unreadable there).
 * WebCrypto only, so the same code runs on the phone, in the browser and in Node.
 */

export const PASSPHRASE_ITERATIONS = 600_000;
export const MIN_PASSPHRASE = 12;

const enc = new TextEncoder();
const dec = new TextDecoder();
const ECDH = { name: "ECDH", namedCurve: "P-256" } as const;

export const randomBytes = (n: number) => crypto.getRandomValues(new Uint8Array(n));
export const toHex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
export const fromHex = (h: string) => Uint8Array.from(h.match(/../g) ?? [], (x) => parseInt(x, 16));

async function hkdf(secret: Uint8Array, info: string, usage: "aes" | "hmac"): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey("raw", secret as BufferSource, "HKDF", false, ["deriveKey"]);
  const params = { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: enc.encode(info) };
  return usage === "aes"
    ? crypto.subtle.deriveKey(params, base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"])
    : crypto.subtle.deriveKey(params, base, { name: "HMAC", hash: "SHA-256", length: 256 }, false, ["sign"]);
}

/** AES-GCM, out = base64(iv || ciphertext). `aad` binds the blob to what it is for. */
export async function aesSeal(key: CryptoKey, plain: Uint8Array, aad = ""): Promise<string> {
  const iv = randomBytes(12);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: enc.encode(aad) }, key, plain as BufferSource));
  const out = new Uint8Array(12 + ct.length);
  out.set(iv);
  out.set(ct, 12);
  return toB64(out);
}

export async function aesOpen(key: CryptoKey, sealed: string, aad = ""): Promise<Uint8Array> {
  const b = fromB64(sealed);
  return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: b.subarray(0, 12), additionalData: enc.encode(aad) }, key, b.subarray(12)));
}

export const sealJson = async (key: CryptoKey, value: unknown, aad = "") => aesSeal(key, enc.encode(JSON.stringify(value)), aad);
export const openJson = async <T>(key: CryptoKey, sealed: string, aad = ""): Promise<T> => JSON.parse(dec.decode(await aesOpen(key, sealed, aad))) as T;

// ---- Account data key ----

export const newAdk = () => randomBytes(SYNC_SECRET_BYTES);

/** Proof a device holds the right ADK, kept on the server; a device checks it before its first push. */
export async function keyCheck(adk: Uint8Array): Promise<string> {
  const mac = await crypto.subtle.sign("HMAC", await hkdf(adk, "even-key-check-v1", "hmac"), enc.encode("even"));
  return toB64(new Uint8Array(mac));
}

/** The identity private key travels sealed with the ADK, so every device of the account has it. */
export const adkSealKey = (adk: Uint8Array) => hkdf(adk, "even-identity-v1", "aes");

// ---- Passphrase ----

/**
 * PBKDF2-SHA256 (as backups) to 64 bytes: the first half unwraps the ADK and never leaves the
 * device, the second half is sent to prove the passphrase (the server keeps its SHA-256).
 */
export async function passphraseKeys(passphrase: string, saltB64: string, iterations: number): Promise<{ wrap: CryptoKey; verifier: string }> {
  const base = await crypto.subtle.importKey("raw", enc.encode(passphrase.normalize("NFKC")), "PBKDF2", false, ["deriveBits"]);
  const bits = new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: fromB64(saltB64), iterations }, base, 512));
  const wrap = await crypto.subtle.importKey("raw", bits.slice(0, 32), "AES-GCM", false, ["encrypt", "decrypt"]);
  return { wrap, verifier: toB64(bits.slice(32)) };
}

export function checkPassphrase(passphrase: string): string | null {
  if (passphrase.trim().length < MIN_PASSPHRASE) return `Use at least ${MIN_PASSPHRASE} characters: four random words are easy to remember and hard to guess.`;
  return null;
}

// ---- Identity and ECDH ----

export interface Identity {
  publicJwk: string;
  privateJwk: JsonWebKey;
}

export async function newIdentity(): Promise<Identity> {
  const pair = await crypto.subtle.generateKey(ECDH, true, ["deriveBits"]);
  return { publicJwk: JSON.stringify(await crypto.subtle.exportKey("jwk", pair.publicKey)), privateJwk: await crypto.subtle.exportKey("jwk", pair.privateKey) };
}

/** The AES key two parties share: my private key with their public key, the same from both sides. */
export async function sharedKey(myPrivate: JsonWebKey, theirPublic: string, info: string): Promise<CryptoKey> {
  const priv = await crypto.subtle.importKey("jwk", myPrivate, ECDH, false, ["deriveBits"]);
  const pub = await crypto.subtle.importKey("jwk", JSON.parse(theirPublic) as JsonWebKey, ECDH, false, []);
  const bits = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: pub }, priv, 256));
  return hkdf(bits, info, "aes");
}

/** Six characters from a public key, shown in a pairing code so the server cannot swap the key. */
export async function fingerprint(publicJwk: string): Promise<string> {
  const jwk = JSON.parse(publicJwk) as JsonWebKey;
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(`${jwk.x}.${jwk.y}`)));
  const alphabet = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
  return [...digest.subarray(0, 6)].map((b) => alphabet[b % alphabet.length]).join("");
}

// ---- Pairing: seal the account keys to the new device's one-time key ----

export interface PairingPayload {
  adk: string;
  identityPrivate: JsonWebKey;
  identityPublic: string;
}

export async function sealForPairing(newDevicePublic: string, payload: PairingPayload): Promise<string> {
  const mine = await newIdentity();
  const key = await sharedKey(mine.privateJwk, newDevicePublic, "even-pairing-v1");
  return toB64(enc.encode(JSON.stringify({ from: mine.publicJwk, data: await sealJson(key, payload, "pairing") })));
}

export async function openPairing(ephemeralPrivate: JsonWebKey, sealed: string): Promise<PairingPayload> {
  const { from, data } = JSON.parse(dec.decode(fromB64(sealed))) as { from: string; data: string };
  return openJson<PairingPayload>(await sharedKey(ephemeralPrivate, from, "even-pairing-v1"), data, "pairing");
}
