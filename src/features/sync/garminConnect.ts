import { createLogger } from "../../core/log";
import type { SqlDriver } from "../../db/driver";
import type { ConnectionStatus } from "../chat/connect";
import { clearGarminKey, loadGarminKey, normalizeGarminKey, saveGarminKey, type SecretStore } from "../settings/secrets";
import { GARMIN_SOURCE, GarminApi, KEY_REJECTED } from "./garmin";
import { lastSync } from "./runSync";

/**
 * Connecting the Garmin sync, the same way as Claude: paste the personal API key, the app checks
 * it with Garmin, and only a key Garmin accepts is saved (in the phone's secure storage). The
 * connection needs attention when a sync was refused because of the key (expired or revoked); a
 * network failure does not count, the key is still fine.
 */

const log = createLogger("sync.garmin.connect");

/** Throws a message safe to show when Garmin refuses the key or cannot be reached. */
export type VerifyGarminKey = (apiKey: string) => Promise<void>;

export const garminKeyVerifier =
  (doFetch?: typeof fetch): VerifyGarminKey =>
  (apiKey) =>
    new GarminApi({ apiKey, fetch: doFetch }).verify();

export interface GarminConnection {
  status: ConnectionStatus;
  /** "…AbCd": the last 4 characters, to recognise which key is in use. */
  keyHint: string | null;
  lastOkMs: number | null;
  /** The latest sync's error, when it failed. */
  lastError: string | null;
}

export async function garminConnection(db: SqlDriver, secrets: SecretStore): Promise<GarminConnection> {
  const key = await loadGarminKey(secrets);
  const sync = await lastSync(db, GARMIN_SOURCE);
  const lastError = sync?.status === "error" ? sync.error : null;
  if (!key) return { status: "not_connected", keyHint: null, lastOkMs: sync?.lastOkMs ?? null, lastError: null };
  return {
    status: lastError?.startsWith(KEY_REJECTED) ? "needs_attention" : "connected",
    keyHint: `…${key.slice(-4)}`,
    lastOkMs: sync?.lastOkMs ?? null,
    lastError,
  };
}

/** Check the key with Garmin, then store it. A key that fails the check is never saved. */
export async function connectGarmin(secrets: SecretStore, apiKey: string, verify: VerifyGarminKey): Promise<{ ok: true } | { ok: false; message: string }> {
  let key: string;
  try {
    key = normalizeGarminKey(apiKey);
    await verify(key);
  } catch (err) {
    log.warn("Garmin key not accepted", { status: (err as { status?: number }).status ?? null });
    return { ok: false, message: (err as Error).message };
  }
  await saveGarminKey(secrets, key);
  log.info("Garmin connected");
  return { ok: true };
}

/** Remove the key from the phone. Synced data stays. */
export async function disconnectGarmin(secrets: SecretStore): Promise<void> {
  await clearGarminKey(secrets);
  log.info("Garmin disconnected");
}
