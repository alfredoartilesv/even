import { sha256Hex } from "../../core/hash";
import { createLogger } from "../../core/log";
import type { SecretStore } from "../../core/secretStore";
import type { AccountKeys, Joined } from "../../core/syncWire";
import { syncApi, type Device, type SyncApi } from "./api";
import {
  adkSealKey,
  checkPassphrase,
  fingerprint,
  fromHex,
  keyCheck,
  newAdk,
  newIdentity,
  openJson,
  openPairing,
  PASSPHRASE_ITERATIONS,
  passphraseKeys,
  randomBytes,
  sealForPairing,
  sealJson,
  toHex,
  aesOpen,
  aesSeal,
} from "./keys";
import { toB64 } from "./seal";

const log = createLogger("cloudsync.session");

/**
 * This device's connection to the sync server (docs/users.md section 2): who it is, its token and
 * the account's keys. Kept in the Keystore on the phone and in the browser's sealed store on the
 * web (src/platform/secureStore.ts), never in SQLite, so never in a backup or a sync.
 */
export interface SyncSession {
  serverUrl: string;
  accountId: string;
  deviceId: string;
  token: string;
  email: string;
  /** The account data key, hex. */
  adk: string;
  identityPublic: string;
  identityPrivate: JsonWebKey;
}

export const SESSION_KEY = "cloudsync.session";

export async function loadSession(store: SecretStore): Promise<SyncSession | null> {
  const raw = await store.get(SESSION_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as SyncSession;
  } catch {
    return null;
  }
}

const saveSession = (store: SecretStore, s: SyncSession) => store.set(SESSION_KEY, JSON.stringify(s));

export const sessionApi = (s: SyncSession, fetchFn?: typeof fetch): SyncApi => syncApi(s.serverUrl, fetchFn, s.token);

export class ConnectError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConnectError";
  }
}

/** Turns what the server sent a joining device into a session, after checking the ADK is the account's. */
async function joinedSession(
  serverUrl: string,
  email: string,
  j: Pick<Joined, "accountId" | "deviceId" | "token">,
  adk: Uint8Array,
  check: string,
  identity: { pub: string; priv: JsonWebKey },
): Promise<SyncSession> {
  if ((await keyCheck(adk)) !== check) throw new ConnectError("These keys do not belong to this account. Nothing was synced.");
  return {
    serverUrl,
    accountId: j.accountId,
    deviceId: j.deviceId,
    token: j.token,
    email,
    adk: toHex(adk),
    identityPublic: identity.pub,
    identityPrivate: identity.priv,
  };
}

export interface NewAccount {
  inviteCode: string;
  email: string;
  displayName: string;
  passphrase: string;
  device: Device;
}

/** The first device of a new account (section 2.1): makes the keys, wraps them, signs up with the invite. */
export async function createAccount(
  serverUrl: string,
  store: SecretStore,
  a: NewAccount,
  opts: { fetchFn?: typeof fetch; iterations?: number } = {},
): Promise<SyncSession> {
  const weak = checkPassphrase(a.passphrase);
  if (weak) throw new ConnectError(weak);
  const adk = newAdk();
  const identity = await newIdentity();
  const salt = toB64(randomBytes(16));
  const iterations = opts.iterations ?? PASSPHRASE_ITERATIONS;
  const pass = await passphraseKeys(a.passphrase, salt, iterations);
  const keys: AccountKeys = {
    identityPublic: identity.publicJwk,
    identityPrivate: await sealJson(await adkSealKey(adk), identity.privateJwk, "identity"),
    adkWrapped: await aesSeal(pass.wrap, adk, "adk"),
    wrapSalt: salt,
    wrapIterations: iterations,
    recoveryVerifier: pass.verifier,
    keyCheck: await keyCheck(adk),
  };
  const email = a.email.trim().toLowerCase();
  const joined = await syncApi(serverUrl, opts.fetchFn).signup({ inviteCode: a.inviteCode, email, displayName: a.displayName.trim(), device: a.device, keys });
  const s = await joinedSession(serverUrl, email, joined, adk, keys.keyCheck, { pub: identity.publicJwk, priv: identity.privateJwk });
  await saveSession(store, s);
  log.info("account created", { account: s.accountId, device: s.deviceId });
  return s;
}

/** Another device, or recovery after losing them all (section 2.2): email and passphrase. */
export async function signInWithPassphrase(
  serverUrl: string,
  store: SecretStore,
  a: { email: string; passphrase: string; device: Device },
  opts: { fetchFn?: typeof fetch } = {},
): Promise<SyncSession> {
  const api = syncApi(serverUrl, opts.fetchFn);
  const email = a.email.trim().toLowerCase();
  const { salt, iterations } = await api.recoveryStart(email);
  const pass = await passphraseKeys(a.passphrase, salt, iterations);
  const joined = await api.recoveryFinish(email, pass.verifier, a.device);
  let adk: Uint8Array;
  try {
    adk = await aesOpen(pass.wrap, joined.keys.adkWrapped, "adk");
  } catch {
    throw new ConnectError("The passphrase did not open this account's keys");
  }
  const priv = await openJson<JsonWebKey>(await adkSealKey(adk), joined.keys.identityPrivate, "identity");
  const s = await joinedSession(serverUrl, email, joined, adk, joined.keys.keyCheck, { pub: joined.keys.identityPublic, priv });
  await saveSession(store, s);
  log.info("device added by passphrase", { device: s.deviceId });
  return s;
}

export interface PairingRequest {
  /** What the owner types (or scans) on a device that is already connected. */
  code: string;
  expiresAt: number;
  /** Resolves when the other device approves; rejects when the code expires or `signal` aborts. */
  done: Promise<SyncSession>;
}

/** A new device asks to join (section 2.2): the code carries the pairing id and its key's fingerprint. */
export async function startPairing(
  serverUrl: string,
  store: SecretStore,
  device: Device,
  opts: { fetchFn?: typeof fetch; pollMs?: number; signal?: AbortSignal } = {},
): Promise<PairingRequest> {
  const api = syncApi(serverUrl, opts.fetchFn);
  const eph = await newIdentity();
  const token = toB64(randomBytes(32)).replace(/[+/=]/g, (c) => ({ "+": "-", "/": "_", "=": "" })[c] ?? "");
  const { id, expiresAt } = await api.pairingStart(eph.publicJwk, await sha256Hex(token), device);
  const code = `${id}-${await fingerprint(eph.publicJwk)}`;
  const done = (async () => {
    for (;;) {
      if (opts.signal?.aborted) throw new ConnectError("Pairing cancelled");
      const st = await api.pairingStatus(id, token);
      if (st.status === "expired") throw new ConnectError("The pairing code expired. Start again.");
      if (st.status === "approved" && st.sealed && st.accountId && st.deviceId && st.keyCheck) {
        const p = await openPairing(eph.privateJwk, st.sealed);
        const me = await syncApi(serverUrl, opts.fetchFn, token).me();
        const s = await joinedSession(serverUrl, me.account.email, { accountId: st.accountId, deviceId: st.deviceId, token }, fromHex(p.adk), st.keyCheck, {
          pub: p.identityPublic,
          priv: p.identityPrivate,
        });
        await saveSession(store, s);
        log.info("device added by pairing", { device: s.deviceId });
        return s;
      }
      await new Promise((r) => setTimeout(r, opts.pollMs ?? 2_000));
    }
  })();
  return { code, expiresAt, done };
}

/** On a connected device: let the device showing `code` in. Checks the fingerprint, so the server cannot swap keys. */
export async function approvePairing(s: SyncSession, code: string, opts: { fetchFn?: typeof fetch } = {}): Promise<{ deviceName: string }> {
  const m = /^([0-9A-Z]{6})-?([0-9A-Z]{6})$/.exec(code.toUpperCase().replace(/[^0-9A-Z-]/g, ""));
  if (!m) throw new ConnectError("A pairing code is 12 characters, like ABC234-XYZ567");
  const api = sessionApi(s, opts.fetchFn);
  const info = await api.pairingInfo(m[1]);
  if ((await fingerprint(info.ephemeralPublic)) !== m[2])
    throw new ConnectError("That code does not match the device asking. Do not approve it; start again on the new device.");
  await api.pairingApprove(
    m[1],
    await sealForPairing(info.ephemeralPublic, { adk: s.adk, identityPrivate: s.identityPrivate, identityPublic: s.identityPublic }),
  );
  log.info("pairing approved", { device: s.deviceId });
  return { deviceName: info.deviceName };
}

export async function changePassphrase(s: SyncSession, passphrase: string, opts: { fetchFn?: typeof fetch; iterations?: number } = {}): Promise<void> {
  const weak = checkPassphrase(passphrase);
  if (weak) throw new ConnectError(weak);
  const salt = toB64(randomBytes(16));
  const iterations = opts.iterations ?? PASSPHRASE_ITERATIONS;
  const pass = await passphraseKeys(passphrase, salt, iterations);
  await sessionApi(s, opts.fetchFn).updateRecovery({
    adkWrapped: await aesSeal(pass.wrap, fromHex(s.adk), "adk"),
    wrapSalt: salt,
    wrapIterations: iterations,
    recoveryVerifier: pass.verifier,
  });
}

/** This device leaves the account: its token is revoked and its keys forgotten. The data on it stays. */
export async function disconnect(store: SecretStore, s: SyncSession, opts: { fetchFn?: typeof fetch } = {}): Promise<void> {
  try {
    await sessionApi(s, opts.fetchFn).revokeDevice(s.deviceId);
  } catch (err) {
    log.warn("device not revoked on the server", { err });
  }
  await store.remove(SESSION_KEY);
}

/** Deletes the account and everything the server holds for it; this device forgets the session. */
export async function deleteAccount(store: SecretStore, s: SyncSession, opts: { fetchFn?: typeof fetch } = {}): Promise<void> {
  await sessionApi(s, opts.fetchFn).deleteAccount();
  await store.remove(SESSION_KEY);
}
