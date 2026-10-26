import { createLogger } from "../../core/log";
import type { Notifier } from "../../core/notifier";
import type { SqlDriver } from "../../db/driver";
import { getSetting, setSetting } from "../../db/settings";
import { lastSync } from "./runSync";

/**
 * "Garmin has not synced for 3 days" reminders. Garmin keeps the history, so nothing is lost, but
 * three days without a sync usually means the personal API key expired or was revoked.
 */

const log = createLogger("sync.reminder");

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export const STALE_AFTER_MS = 3 * DAY;
/** Once overdue, remind again this often until a sync succeeds. */
export const REMIND_AGAIN_MS = DAY;
/** When the app comes back to the front, sync again if the last success is older than this. */
export const RESYNC_ON_RESUME_MS = HOUR;

export const SYNC_REMINDER_ID = 1001;
export const REMINDER_KEY = "sync.reminder";

export type SyncFreshness = { state: "never" } | { state: "fresh" | "stale"; lastOkMs: number; ageMs: number };

export function freshness(lastOkMs: number | null, nowMs: number): SyncFreshness {
  if (lastOkMs === null) return { state: "never" };
  const ageMs = Math.max(0, nowMs - lastOkMs);
  return { state: ageMs >= STALE_AFTER_MS ? "stale" : "fresh", lastOkMs, ageMs };
}

/** When the next reminder should fire: 3 days after the last success, or a day from now once overdue. */
export function nextReminderAt(lastOkMs: number | null, nowMs: number): number {
  const due = (lastOkMs ?? nowMs) + STALE_AFTER_MS;
  return due > nowMs ? due : nowMs + REMIND_AGAIN_MS;
}

const days = (ms: number) => Math.floor(ms / DAY);

/** Notification text for a reminder firing at atMs. */
export function reminderText(lastOkMs: number | null, atMs: number): { title: string; body: string } {
  if (lastOkMs === null) {
    return { title: "Garmin has not synced yet", body: "Open the app to bring in your Garmin data." };
  }
  return {
    title: `No Garmin sync for ${days(atMs - lastOkMs)} days`,
    body: "Open the app to sync. If it keeps failing, the Garmin key may have expired: make a new one in Garmin Connect.",
  };
}

/** "just now", "5 min ago", "3 h ago", "2 days ago". */
export function ago(ms: number): string {
  if (ms < 60_000) return "just now";
  if (ms < HOUR) return `${Math.floor(ms / 60_000)} min ago`;
  if (ms < DAY) return `${Math.floor(ms / HOUR)} h ago`;
  const d = days(ms);
  return `${d} day${d === 1 ? "" : "s"} ago`;
}

export async function reminderEnabled(db: SqlDriver): Promise<boolean> {
  return (await getSetting(db, REMINDER_KEY)) !== "off";
}

export async function setReminderEnabled(db: SqlDriver, on: boolean, nowMs: number = Date.now()): Promise<void> {
  await setSetting(db, REMINDER_KEY, on ? "on" : "off", nowMs);
  log.info("sync reminder setting changed", { on });
}

/**
 * Bring the scheduled reminder in line with the sync state: one pending notification, due 3 days
 * after the last success (or tomorrow when already overdue). Cancelled when Garmin is not set up,
 * the owner turned reminders off, or notifications are not allowed. Call after every sync attempt,
 * at start and when the setting changes. Never throws.
 */
export async function refreshSyncReminder(
  db: SqlDriver,
  notifier: Notifier,
  opts: { configured: boolean; nowMs?: number; source?: string },
): Promise<"scheduled" | "cancelled"> {
  const now = opts.nowMs ?? Date.now();
  try {
    if (!opts.configured || !(await reminderEnabled(db))) {
      await notifier.cancel(SYNC_REMINDER_ID);
      log.debug("reminder cancelled", { configured: opts.configured });
      return "cancelled";
    }
    if (!(await notifier.ensurePermission())) {
      log.info("reminder not scheduled: notifications not allowed");
      return "cancelled";
    }
    const last = await lastSync(db, opts.source ?? "garmin");
    const lastOk = last?.lastOkMs ?? null;
    const at = nextReminderAt(lastOk, now);
    await notifier.schedule({ id: SYNC_REMINDER_ID, atMs: at, ...reminderText(lastOk, at) });
    log.info("reminder scheduled", { inHours: Math.round((at - now) / HOUR), overdue: freshness(lastOk, now).state === "stale" });
    return "scheduled";
  } catch (err) {
    log.warn("reminder update failed", { err });
    return "cancelled";
  }
}
