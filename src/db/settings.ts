import { uuidv7 } from "../core/uuidv7";
import type { SqlDriver } from "./driver";

/**
 * Non-secret app settings in app_settings. Secrets (freddy URL and key, Claude key)
 * never go here: they live in the Keystore, see src/settings/secrets.ts.
 */
export async function getSetting(db: SqlDriver, key: string): Promise<string | null> {
  const rows = await db.all<{ value: string }>("SELECT value FROM app_settings WHERE key = ?", [key]);
  return rows[0]?.value ?? null;
}

export async function setSetting(db: SqlDriver, key: string, value: string, nowMs: number = Date.now()): Promise<void> {
  await db.run(
    `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    [key, value, nowMs],
  );
}

/** This install's id, for origin_device_id. Created on first use, never restored from a backup. */
export const DEVICE_ID_KEY = "device_id";

export async function deviceId(db: SqlDriver, nowMs: number = Date.now()): Promise<string> {
  const existing = await getSetting(db, DEVICE_ID_KEY);
  if (existing) return existing;
  const id = uuidv7(nowMs);
  await setSetting(db, DEVICE_ID_KEY, id, nowMs);
  return id;
}
