import { createLogger } from "../../core/log";
import type { SqlDriver } from "../../db/driver";
import { getSetting, setSetting } from "../../db/settings";
import type { LastSync } from "../sync/runSync";
import { transportOf } from "./api";
import { cloudPull, cloudSync, cloudSyncSettings, type CloudSyncReport, type SyncOptions } from "./cloudSync";
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
export async function syncNow(
  db: SqlDriver,
  session: SyncSession,
  opts: SyncOptions & { fetchFn?: typeof fetch; today: string; nowMs?: number },
): Promise<CloudSyncResult> {
  const nowMs = opts.nowMs ?? Date.now();
  const api = sessionApi(session, opts.fetchFn);
  try {
    const report = await cloudSync(db, transportOf(api), await syncKeys(fromHex(session.adk)), nowMs, opts);
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

/**
 * The first steps of a sync, before Garmin: the settings both ways, then what the other devices
 * wrote, newest first. `onProgress` after each, so the screens fill in as the rows arrive. A
 * failure here is left to the full sync after it, which records it for the Sync screen.
 */
export async function pullFirst(db: SqlDriver, session: SyncSession, opts: SyncOptions & { fetchFn?: typeof fetch; nowMs?: number }): Promise<void> {
  const transport = transportOf(sessionApi(session, opts.fetchFn));
  const keys = await syncKeys(fromHex(session.adk));
  if ((await cloudSyncSettings(db, transport, keys, opts.nowMs)).pulled > 0) opts.onProgress?.();
  await cloudPull(db, transport, keys, opts.nowMs, opts);
}

/** A profile or photo change, sent at once instead of with the next sync. */
export async function pushSettingsNow(db: SqlDriver, session: SyncSession, opts: { fetchFn?: typeof fetch; nowMs?: number } = {}): Promise<void> {
  await cloudSyncSettings(db, transportOf(sessionApi(session, opts.fetchFn)), await syncKeys(fromHex(session.adk)), opts.nowMs, { pull: false });
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
