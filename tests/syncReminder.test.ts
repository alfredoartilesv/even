import test from "node:test";
import assert from "node:assert/strict";
import { pluginNotification, type LocalNotice, type Notifier } from "../src/core/notifier";
import {
  ago,
  freshness,
  nextReminderAt,
  refreshSyncReminder,
  reminderEnabled,
  reminderText,
  setReminderEnabled,
  STALE_AFTER_MS,
  SYNC_REMINDER_ID,
} from "../src/domain/sync/reminder";
import { migratedDb } from "./helpers";

const H = 3_600_000;
const D = 24 * H;
const NOW = Date.UTC(2026, 9, 26, 9, 0, 0);

function fakeNotifier(allowed = true) {
  const scheduled: LocalNotice[] = [];
  const cancelled: number[] = [];
  let asked = 0;
  const n: Notifier = {
    ensurePermission: async () => (asked++, allowed),
    schedule: async (x) => void scheduled.push(x),
    cancel: async (id) => void cancelled.push(id),
  };
  return { n, scheduled, cancelled, asked: () => asked };
}

async function withRun(db: Awaited<ReturnType<typeof migratedDb>>["db"], finishedMs: number, status: "ok" | "error" = "ok") {
  await db.run("INSERT INTO sync_runs (id, source, started_ms, finished_ms, status) VALUES (?, 'garmin', ?, ?, ?)", [
    `r${finishedMs}${status}`,
    finishedMs - 1000,
    finishedMs,
    status,
  ]);
}

test("freshness: fresh under 3 days, stale from 3 days, never without a success", () => {
  assert.deepEqual(freshness(null, NOW), { state: "never" });
  assert.equal(freshness(NOW - STALE_AFTER_MS + 1, NOW).state, "fresh");
  assert.equal(freshness(NOW - STALE_AFTER_MS, NOW).state, "stale");
  assert.equal(freshness(NOW + 5000, NOW).state, "fresh", "a clock skew is not negative age");
});

test("next reminder: 3 days after the last success, else tomorrow; text counts the days and points at the key", () => {
  assert.equal(nextReminderAt(NOW - D, NOW), NOW + 2 * D);
  assert.equal(nextReminderAt(NOW - 5 * D, NOW), NOW + D);
  assert.equal(nextReminderAt(null, NOW), NOW + 3 * D);
  assert.deepEqual(reminderText(NOW - 3 * D, NOW), {
    title: "No Garmin sync for 3 days",
    body: "Open the app to sync. If it keeps failing, the Garmin key may have expired: make a new one in Garmin Connect.",
  });
  assert.equal(reminderText(null, NOW).title, "Garmin has not synced yet");
  assert.deepEqual([0, 5 * 60_000, 3 * H, D, 4 * D].map(ago), ["just now", "5 min ago", "3 h ago", "1 day ago", "4 days ago"]);
});

test("refresh schedules one reminder 3 days after the last success, and moves it after each sync", async () => {
  const { db } = await migratedDb();
  const f = fakeNotifier();
  await withRun(db, NOW - 10 * H);
  await withRun(db, NOW - H, "error"); // a failed attempt does not count
  assert.equal(await refreshSyncReminder(db, f.n, { configured: true, nowMs: NOW }), "scheduled");
  assert.deepEqual(f.scheduled[0], { id: SYNC_REMINDER_ID, atMs: NOW - 10 * H + 3 * D, ...reminderText(NOW - 10 * H, NOW - 10 * H + 3 * D) });

  await withRun(db, NOW);
  await refreshSyncReminder(db, f.n, { configured: true, nowMs: NOW });
  assert.equal(f.scheduled[1].atMs, NOW + 3 * D, "same id, pushed back");
  assert.equal(f.scheduled[1].id, SYNC_REMINDER_ID);
});

test("refresh: overdue repeats tomorrow; cancelled when not set up, switched off, or not allowed; never throws", async () => {
  const { db } = await migratedDb();
  await withRun(db, NOW - 4 * D);
  const f = fakeNotifier();
  await refreshSyncReminder(db, f.n, { configured: true, nowMs: NOW });
  assert.equal(f.scheduled[0].atMs, NOW + D);
  assert.equal(f.scheduled[0].title, "No Garmin sync for 5 days");

  assert.equal(await refreshSyncReminder(db, f.n, { configured: false, nowMs: NOW }), "cancelled");
  assert.deepEqual(f.cancelled, [SYNC_REMINDER_ID]);

  assert.equal(await reminderEnabled(db), true);
  await setReminderEnabled(db, false, NOW);
  assert.equal(await refreshSyncReminder(db, f.n, { configured: true, nowMs: NOW }), "cancelled");
  assert.equal(f.cancelled.length, 2);
  assert.equal(f.asked(), 1, "no permission prompt while switched off");

  await setReminderEnabled(db, true, NOW);
  const denied = fakeNotifier(false);
  assert.equal(await refreshSyncReminder(db, denied.n, { configured: true, nowMs: NOW }), "cancelled");
  assert.deepEqual(denied.scheduled, []);

  const broken: Notifier = { ensurePermission: async () => true, schedule: async () => Promise.reject(new Error("plugin missing")), cancel: async () => {} };
  assert.equal(await refreshSyncReminder(db, broken, { configured: true, nowMs: NOW }), "cancelled");
});

test("the reminder asks Android for an inexact alarm, so scheduling never opens the Alarms & reminders screen", () => {
  const at = Date.UTC(2026, 9, 29, 9, 0);
  assert.deepEqual(pluginNotification({ id: SYNC_REMINDER_ID, title: "t", body: "b", atMs: at }), {
    id: SYNC_REMINDER_ID,
    title: "t",
    body: "b",
    schedule: { at: new Date(at), allowWhileIdle: true },
    isExactNotification: false,
  });
});
