import { upsertCatalog } from "../metrics/catalog";
import type { SqlDriver } from "../../db/driver";
import { loadCursor, saveSyncState, upsertSamples } from "../metrics/samples";
import { uuidv7 } from "../../core/uuidv7";
import type { Source } from "./types";
import { createLogger } from "../../core/log";

const log = createLogger("sync");

export interface SyncOutcome {
  status: "ok" | "error";
  samplesWritten: number;
  warnings: string[];
  error?: string;
  cursorBefore: string | null;
  cursorAfter: string | null;
}

const inFlight = new Map<string, Promise<SyncOutcome>>();

/**
 * One sync of one source: fetch since the stored cursor, store samples and catalog,
 * move the cursor, and log the attempt in sync_runs. Never throws: failures come back
 * as status "error" (and the cursor stays put). Concurrent calls for the same source
 * share one run, so "sync on open" and the button cannot race.
 */
export function runSync(db: SqlDriver, source: Source, now: () => number = Date.now): Promise<SyncOutcome> {
  const running = inFlight.get(source.id);
  if (running) {
    log.debug("joining the sync already running", { source: source.id });
    return running;
  }
  const p = doSync(db, source, now).finally(() => inFlight.delete(source.id));
  inFlight.set(source.id, p);
  return p;
}

async function doSync(db: SqlDriver, source: Source, now: () => number): Promise<SyncOutcome> {
  const runId = uuidv7(now());
  const cursorBefore = await loadCursor(db, source.id);
  const started = now();
  log.info("sync started", { source: source.id, cursorBefore });
  await db.run("INSERT INTO sync_runs (id, source, started_ms, status, cursor_before) VALUES (?, ?, ?, 'running', ?)", [runId, source.id, now(), cursorBefore]);

  try {
    const res = await source.fetchSince(cursorBefore);
    const t = now();
    const written = await upsertSamples(db, res.samples, t);
    if (res.catalog) await upsertCatalog(db, source.id, res.catalog, t);
    await saveSyncState(db, source.id, res.nextCursor, t);
    const warnings = res.warnings ?? [];
    await finish(db, runId, now(), "ok", { cursorAfter: res.nextCursor, written, warnings });
    log.info("sync finished", {
      source: source.id,
      samples: written,
      catalog: res.catalog?.length ?? 0,
      warnings: warnings.length,
      cursorAfter: res.nextCursor,
      ms: now() - started,
    });
    for (const w of warnings) log.warn("sync warning", { source: source.id, warning: w });
    return { status: "ok", samplesWritten: written, warnings, cursorBefore, cursorAfter: res.nextCursor };
  } catch (err) {
    const message = (err as Error).message || String(err);
    log.error("sync failed, cursor kept", { source: source.id, err, ms: now() - started });
    await saveSyncState(db, source.id, cursorBefore, now(), message);
    await finish(db, runId, now(), "error", { cursorAfter: cursorBefore, written: 0, warnings: [], error: message });
    return { status: "error", samplesWritten: 0, warnings: [], error: message, cursorBefore, cursorAfter: cursorBefore };
  }
}

async function finish(
  db: SqlDriver,
  runId: string,
  at: number,
  status: "ok" | "error",
  r: { cursorAfter: string | null; written: number; warnings: string[]; error?: string },
) {
  await db.run(
    `UPDATE sync_runs SET finished_ms = ?, status = ?, cursor_after = ?, samples_written = ?, warnings_json = ?, error = ?
     WHERE id = ?`,
    [at, status, r.cursorAfter, r.written, r.warnings.length ? JSON.stringify(r.warnings) : null, r.error ?? null, runId],
  );
}

export interface LastSync {
  status: "running" | "ok" | "error";
  startedMs: number;
  finishedMs: number | null;
  samplesWritten: number | null;
  warnings: string[];
  error: string | null;
  /** Last time any sync of this source succeeded, even if the latest attempt failed. */
  lastOkMs: number | null;
}

export async function lastSync(db: SqlDriver, source: string): Promise<LastSync | null> {
  const rows = await db.all<{
    status: LastSync["status"];
    started_ms: number;
    finished_ms: number | null;
    samples_written: number | null;
    warnings_json: string | null;
    error: string | null;
  }>(
    `SELECT status, started_ms, finished_ms, samples_written, warnings_json, error
     FROM sync_runs WHERE source = ? ORDER BY started_ms DESC, rowid DESC LIMIT 1`,
    [source],
  );
  const r = rows[0];
  if (!r) return null;
  const ok = await db.all<{ t: number | null }>("SELECT MAX(finished_ms) AS t FROM sync_runs WHERE source = ? AND status = 'ok'", [source]);
  return {
    status: r.status,
    startedMs: r.started_ms,
    finishedMs: r.finished_ms,
    samplesWritten: r.samples_written,
    warnings: r.warnings_json ? (JSON.parse(r.warnings_json) as string[]) : [],
    error: r.error,
    lastOkMs: ok[0]?.t ?? null,
  };
}

/**
 * One status for the header from every connected source: failing if any latest run failed, and
 * "synced" as of the source that is furthest behind, so a stuck source is never hidden by a
 * working one.
 */
export function combineSyncs(syncs: (LastSync | null)[]): LastSync | null {
  const s = syncs.filter((x): x is LastSync => x !== null);
  if (s.length <= 1) return s[0] ?? null;
  const failed = s.find((x) => x.status === "error");
  const oks = s.map((x) => x.lastOkMs);
  return {
    status: failed ? "error" : s.some((x) => x.status === "running") ? "running" : "ok",
    startedMs: Math.max(...s.map((x) => x.startedMs)),
    finishedMs: s.some((x) => x.finishedMs === null) ? null : Math.max(...s.map((x) => x.finishedMs!)),
    samplesWritten: s.reduce((t, x) => t + (x.samplesWritten ?? 0), 0),
    warnings: s.flatMap((x) => x.warnings),
    error: failed?.error ?? null,
    lastOkMs: oks.some((t) => t === null) ? null : Math.min(...(oks as number[])),
  };
}
