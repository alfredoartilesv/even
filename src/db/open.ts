import { Capacitor } from "@capacitor/core";
import { CapacitorSQLite, SQLiteConnection } from "@capacitor-community/sqlite";
import { capacitorDriver } from "./capacitorDriver";
import type { SqlDriver } from "./driver";
import { migrate } from "./migrate";
import { migrations } from "./migrations";

export const DB_NAME = "health";

const sqlite = new SQLiteConnection(CapacitorSQLite);

/** 32 random bytes as hex. Generated once per install; never leaves the device. */
function newPassphrase(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Open the encrypted (SQLCipher) database and bring the schema up to date.
 * The passphrase lives in the plugin's secure store (Android Keystore-backed
 * EncryptedSharedPreferences / iOS Keychain), created on first launch.
 * Native only: the web build has no jeep-sqlite and should not hold health data.
 * Shared promise: StrictMode runs effects twice, and two concurrent createConnection
 * calls for the same name fail. A failed open is not cached, so it can be retried.
 */
let opening: Promise<{ db: SqlDriver; applied: number[] }> | null = null;

export function openDatabase(): Promise<{ db: SqlDriver; applied: number[] }> {
  opening ??= doOpen().catch((err) => {
    opening = null;
    throw err;
  });
  return opening;
}

async function doOpen(): Promise<{ db: SqlDriver; applied: number[] }> {
  if (!Capacitor.isNativePlatform()) {
    throw new Error("Local database is only available in the Android/iOS app");
  }
  if (!(await sqlite.isSecretStored()).result) {
    await sqlite.setEncryptionSecret(newPassphrase());
  }

  // After a WebView reload the native side can still hold the connection.
  const consistent = (await sqlite.checkConnectionsConsistency()).result;
  const exists = (await sqlite.isConnection(DB_NAME, false)).result;
  // Version 1 + no addUpgradeStatement: the plugin never touches user_version, migrate() owns it.
  const conn =
    consistent && exists
      ? await sqlite.retrieveConnection(DB_NAME, false)
      : await sqlite.createConnection(DB_NAME, true, "secret", 1, false);
  if (!(await conn.isDBOpen()).result) await conn.open();

  const db = capacitorDriver(conn);
  const applied = await migrate(db, migrations);
  return { db, applied };
}
