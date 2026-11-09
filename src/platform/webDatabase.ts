import initSqlJs, { type Database } from "sql.js";
import wasmUrl from "sql.js/dist/sql-wasm.wasm?url";
import type { SqlDriver, SqlValue } from "../db/driver";
import { createLogger } from "../core/log";
import { idbDelete, idbGet, idbPut, openBytes, sealBytes } from "./idb";
import { consumeTakeOver, holdTabLock } from "./tabLock";

const log = createLogger("db.web");

/**
 * The web app's database (docs/users.md section 2.2): SQLite (sql.js, WebAssembly) in memory, saved
 * to IndexedDB sealed with this browser's own key a moment after each write and when the page is
 * hidden. It is a copy: the account's data lives on the phone and, sealed, on the sync server, so
 * losing it costs a fresh pull, not data. One tab at a time, as two would overwrite each other.
 */
const FILE_KEY = "db";
const SAVE_DELAY_MS = 1_500;

export class OtherTabError extends Error {
  constructor() {
    super("Even is already open in another tab of this browser, maybe one in the background. Use it here, and that tab stops.");
    this.name = "OtherTabError";
  }
}

export async function openWebDatabase(): Promise<SqlDriver> {
  // Set once the lock is taken over by another tab: from then on this tab never saves, so it
  // cannot overwrite the copy the new owner is using. It reloads, and asks again there.
  let lost = false;
  const lock = await holdTabLock({
    takeOver: consumeTakeOver(),
    onLost: () => {
      lost = true;
      log.info("database taken over by another tab");
      location.reload();
    },
  });
  if (!lock.held) throw new OtherTabError();
  void navigator.storage?.persist?.().then((ok) => log.info("persistent storage", { granted: ok }));
  const SQL = await initSqlJs({ locateFile: () => wasmUrl });
  let raw: Database;
  const saved = await idbGet<{ iv: Uint8Array; data: ArrayBuffer }>(FILE_KEY);
  try {
    raw = saved ? new SQL.Database(await openBytes(saved)) : new SQL.Database();
  } catch (err) {
    // The browser's key changed (site data partly cleared): start empty, the next sync fills it.
    log.warn("saved database could not be opened, starting empty", { err });
    raw = new SQL.Database();
  }
  raw.exec("PRAGMA foreign_keys = ON");

  let timer: ReturnType<typeof setTimeout> | null = null;
  let saving: Promise<void> = Promise.resolve();
  // sql.js export() closes and reopens the database: never inside a transaction, and pragmas again after.
  let inTransaction = false;
  const save = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    if (lost) return saving;
    if (inTransaction) {
      timer = setTimeout(() => void save(), SAVE_DELAY_MS);
      return saving;
    }
    const bytes = raw.export();
    raw.exec("PRAGMA foreign_keys = ON");
    saving = saving.then(async () => {
      const done = log.time("database saved", "debug");
      await idbPut(FILE_KEY, await sealBytes(bytes));
      done({ bytes: bytes.length });
    });
    return saving;
  };
  const changed = () => {
    if (!timer) timer = setTimeout(() => void save(), SAVE_DELAY_MS);
  };
  addEventListener("pagehide", () => void save());
  document.addEventListener("visibilitychange", () => document.visibilityState === "hidden" && timer && void save());

  return {
    async exec(sql) {
      const head = sql.trimStart().slice(0, 12).toUpperCase();
      if (head.startsWith("BEGIN")) inTransaction = true;
      raw.exec(sql);
      if (head.startsWith("COMMIT") || head.startsWith("END") || (head.startsWith("ROLLBACK") && !/^ROLLBACK\s+TO/i.test(sql.trimStart())))
        inTransaction = false;
      changed();
    },
    async run(sql, params: SqlValue[] = []) {
      raw.run(sql, params as never);
      changed();
    },
    async all<T>(sql: string, params: SqlValue[] = []) {
      const st = raw.prepare(sql);
      try {
        st.bind(params as never);
        const out: T[] = [];
        while (st.step()) out.push(st.getAsObject() as T);
        return out;
      } finally {
        st.free();
      }
    },
  };
}

/**
 * Forgets this browser's copy (after Disconnect or Delete account on the web): the next account
 * to sign in here must not find, and push, the last one's rows. The phone keeps its data; it is
 * the source. Reloads the page, as the open database is gone.
 */
export async function forgetWebData(): Promise<void> {
  await idbDelete(FILE_KEY);
  location.reload();
}
