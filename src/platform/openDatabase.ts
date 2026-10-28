import { Capacitor } from "@capacitor/core";
import { CapacitorSQLite, SQLiteConnection } from "@capacitor-community/sqlite";
import { capacitorDriver } from "./sqlite";
import type { SqlDriver } from "../db/driver";
import { migrate } from "../db/migrate";
import { migrations } from "../db/migrations";
import { createLogger } from "../core/log";

const log = createLogger("db.open");

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
 * In the browser (the web app, docs/users.md) the database is sql.js saved to IndexedDB
 * (webDatabase.ts), loaded only there, so the phone's bundle does not carry it.
 * Shared promise: StrictMode runs effects twice, and two concurrent createConnection
 * calls for the same name fail. A failed open is not cached, so it can be retried.
 */
let opening: Promise<{ db: SqlDriver; applied: number[] }> | null = null;

export function openDatabase(): Promise<{ db: SqlDriver; applied: number[] }> {
  opening ??= doOpen().catch((err) => {
    opening = null;
    log.error("database open failed", { err });
    throw err;
  });
  return opening;
}

async function doOpen(): Promise<{ db: SqlDriver; applied: number[] }> {
  const done = log.time("database open", "info");
  if (!Capacitor.isNativePlatform()) {
    const web = await (await import("./webDatabase")).openWebDatabase();
    const applied = await migrate(web, migrations);
    done({ migrationsApplied: applied, web: true });
    return { db: web, applied };
  }
  performance.mark("even:db-start");
  if (!(await sqlite.isSecretStored()).result) {
    await sqlite.setEncryptionSecret(newPassphrase());
    log.info("first launch: encryption secret created");
  }

  performance.mark("even:db-secret");
  // After a WebView reload the native side can still hold the connection.
  const consistent = (await sqlite.checkConnectionsConsistency()).result;
  const exists = (await sqlite.isConnection(DB_NAME, false)).result;
  // Version 1 + no addUpgradeStatement: the plugin never touches user_version, migrate() owns it.
  const conn = consistent && exists ? await sqlite.retrieveConnection(DB_NAME, false) : await sqlite.createConnection(DB_NAME, true, "secret", 1, false);
  log.debug(consistent && exists ? "reusing native connection" : "new native connection");
  performance.mark("even:db-connection");
  if (!(await conn.isDBOpen()).result) await conn.open();
  performance.mark("even:db-opened");

  const db = capacitorDriver(conn);
  const applied = await migrate(db, migrations);
  done({ migrationsApplied: applied });
  return { db, applied };
}
