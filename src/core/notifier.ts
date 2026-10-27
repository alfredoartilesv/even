/**
 * Local notifications the logic can schedule. Implemented on the phone in
 * src/platform/notifications.ts; tests and the browser build use a fake or the no-op below.
 */
export interface LocalNotice {
  id: number;
  title: string;
  body: string;
  atMs: number;
}

export interface Notifier {
  /** Ask the OS for permission if it has not been decided yet. True when notifications may be shown. */
  ensurePermission(): Promise<boolean>;
  /** Schedule (or replace, same id) one notification. */
  schedule(n: LocalNotice): Promise<void>;
  cancel(id: number): Promise<void>;
}

/**
 * The options the Android plugin gets for one notice. `isExactNotification: false` matters: the
 * plugin defaults to an exact alarm, and on Android 14+ (where exact alarms are off by default) it
 * then opens the system "Alarms & reminders" screen on every schedule, that is after every sync.
 * A reminder a few minutes late is fine; allowWhileIdle still lets Doze deliver it.
 */
export function pluginNotification(n: LocalNotice) {
  return { id: n.id, title: n.title, body: n.body, schedule: { at: new Date(n.atMs), allowWhileIdle: true }, isExactNotification: false };
}

export const noopNotifier: Notifier = {
  ensurePermission: async () => false,
  schedule: async () => {},
  cancel: async () => {},
};
