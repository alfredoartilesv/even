import { addLogSink, type Fields, type Level, type LogRecord } from "../../core/log";
import type { SqlDriver, SqlValue } from "../../db/driver";
import { inTransaction } from "../../db/tx";

/**
 * Log records in the local database (log_records, migration 0017), so a crash or a closed app
 * loses nothing: every record is written as it is logged, not when the app closes. Records are
 * already sanitized by core/log. This install only: never synced, never in a backup.
 */

/** How many records are kept; older ones are pruned as new ones arrive. */
export const KEEP_RECORDS = 5000;
/** Rows per INSERT, well under SQLite's oldest limit of 999 parameters. */
const BATCH = 150;
/** Prune once every this many records written, not on every write. */
const PRUNE_EVERY = 200;
/** Records waiting while the database refuses writes; the oldest go first past this. */
const MAX_PENDING = 1000;

interface Options {
  /** Records logged before the database opened (recentLogs), written first. */
  earlier?: LogRecord[];
  /** Wait before trying again while a transaction is open or a write failed. */
  retryMs?: number;
}

export interface PersistedLogs {
  stop: () => void;
  /** Writes what is waiting now; resolves when written, or when a transaction or error makes it wait. */
  flush: () => Promise<void>;
}

const attached = new WeakMap<SqlDriver, PersistedLogs>();

/**
 * Starts writing every log record to the database. A burst is written in one statement on the
 * next tick. While a withTransaction is open the write waits: joining it would lose the records
 * (often the very error) when it rolls back. Once per database: StrictMode runs the effect that
 * calls it twice, and two sinks would store every record twice.
 */
export function persistLogs(db: SqlDriver, opts: Options = {}): PersistedLogs {
  const existing = attached.get(db);
  if (existing) return existing;
  const retryMs = opts.retryMs ?? 250;
  const pending: LogRecord[] = (opts.earlier ?? []).filter(kept);
  let timer: ReturnType<typeof setTimeout> | null = null;
  let writing: Promise<void> = Promise.resolve();
  let sincePrune = 0;
  let stopped = false;

  const later = (ms: number) => {
    if (!timer && !stopped) timer = setTimeout(() => void flush(), ms);
  };

  async function writeAll(): Promise<void> {
    while (pending.length) {
      if (inTransaction(db)) return later(retryMs);
      const batch = pending.slice(0, BATCH);
      try {
        await insert(db, batch);
      } catch {
        // Not logged: that record would come straight back here. Kept for the next try.
        return later(retryMs);
      }
      pending.splice(0, batch.length);
      sincePrune += batch.length;
      if (sincePrune >= PRUNE_EVERY) {
        sincePrune = 0;
        await prune(db).catch(() => {});
      }
    }
  }

  function flush(): Promise<void> {
    if (timer) clearTimeout(timer);
    timer = null;
    writing = writing.then(writeAll);
    return writing;
  }

  const remove = addLogSink((r) => {
    if (stopped || !kept(r)) return;
    pending.push(r);
    if (pending.length > MAX_PENDING) pending.splice(0, pending.length - MAX_PENDING);
    later(0);
  });
  if (pending.length) later(0);

  const handle: PersistedLogs = {
    stop: () => {
      stopped = true;
      remove();
      attached.delete(db);
      if (timer) clearTimeout(timer);
      timer = null;
    },
    flush,
  };
  attached.set(db, handle);
  return handle;
}

/**
 * Every record but the web database's own "database saved": each saved record changes the
 * database, which is saved again and logs again, a write every few seconds for ever.
 */
const kept = (r: LogRecord): boolean => !(r.level === "debug" && r.scope === "db.web");

async function insert(db: SqlDriver, records: LogRecord[]): Promise<void> {
  const params: SqlValue[] = records.flatMap((r) => [r.ts, r.level, r.scope, r.msg, r.fields ? JSON.stringify(r.fields) : null]);
  await db.run(`INSERT INTO log_records (ts, level, scope, msg, fields) VALUES ${records.map(() => "(?, ?, ?, ?, ?)").join(", ")}`, params);
}

async function prune(db: SqlDriver): Promise<void> {
  await db.run("DELETE FROM log_records WHERE id <= (SELECT MAX(id) FROM log_records) - ?", [KEEP_RECORDS]);
}

/** The stored records, oldest first: this run and the runs before it. */
export async function loadLogs(db: SqlDriver, limit: number = KEEP_RECORDS): Promise<LogRecord[]> {
  const rows = await db.all<{ ts: number; level: Level; scope: string; msg: string; fields: string | null }>(
    "SELECT ts, level, scope, msg, fields FROM log_records ORDER BY id DESC LIMIT ?",
    [limit],
  );
  return rows.reverse().map((r) => ({ ts: r.ts, level: r.level, scope: r.scope, msg: r.msg, ...(r.fields ? { fields: parseFields(r.fields) } : {}) }));
}

function parseFields(s: string): Fields {
  try {
    return JSON.parse(s) as Fields;
  } catch {
    return { fields: "[unreadable]" };
  }
}

/** Deletes every stored record; returns how many there were. */
export async function clearLogs(db: SqlDriver): Promise<number> {
  const [{ n }] = await db.all<{ n: number }>("SELECT COUNT(*) AS n FROM log_records");
  await db.run("DELETE FROM log_records");
  return n;
}
