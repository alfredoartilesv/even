import { createLogger } from "../../core/log";
import type { SqlDriver } from "../../db/driver";
import { getSetting, setSetting } from "../../db/settings";
import type { LastSync } from "../sync/runSync";
import { transportOf } from "./api";
import { cloudSync, type CloudSyncReport } from "./cloudSync";
import { pushShares } from "./friends";
import { fromHex } from "./keys";
import { syncKeys } from "./seal";
import { sessionApi, type SyncSession } from "./session";

const log = createLogger("cloudsync");

export const LAST_CLOUD_SYNC_KEY = "cloudsync.last_ms";
export const LAST_CLOUD_ERROR_KEY = "cloudsync.last_error";

export type CloudSyncResult = CloudSyncReport & { shared: number };

/**
 * One full sync: this device's rows up and everyone's down, then the friend summaries. A failed
 * share does not fail the sync (the rows are what matters); the error is kept for the Sync screen.
 */
export async function syncNow(db: SqlDriver, session: SyncSession, opts: { fetchFn?: typeof fetch; today: string; nowMs?: number }): Promise<CloudSyncResult> {
  const nowMs = opts.nowMs ?? Date.now();
  const api = sessionApi(session, opts.fetchFn);
  try {
    const report = await cloudSync(db, transportOf(api), await syncKeys(fromHex(session.adk)), nowMs);
    let shared = 0;
    try {
      shared = await pushShares(db, api, session, opts.today, nowMs);
    } catch (err) {
      log.warn("shares not sent", { err });
    }
    await setSetting(db, LAST_CLOUD_SYNC_KEY, String(nowMs), nowMs);
    await setSetting(db, LAST_CLOUD_ERROR_KEY, "", nowMs);
    return { ...report, shared };
  } catch (err) {
    await setSetting(db, LAST_CLOUD_ERROR_KEY, (err as Error).message, nowMs);
    throw err;
  }
}

export async function lastCloudSync(db: SqlDriver): Promise<{ at: number | null; error: string | null }> {
  const [at, error] = await Promise.all([getSetting(db, LAST_CLOUD_SYNC_KEY), getSetting(db, LAST_CLOUD_ERROR_KEY)]);
  return { at: at ? Number(at) : null, error: error || null };
}

/** The cloud sync in the shape of the other syncs, so the header button and banner can show it with them. */
export async function cloudSyncStatus(db: SqlDriver): Promise<LastSync | null> {
  const { at, error } = await lastCloudSync(db);
  if (at === null && error === null) return null;
  const ms = at ?? Date.now();
  return { status: error ? "error" : "ok", startedMs: ms, finishedMs: ms, samplesWritten: null, warnings: [], error, lastOkMs: at };
}
