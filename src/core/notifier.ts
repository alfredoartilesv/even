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

export const noopNotifier: Notifier = {
  ensurePermission: async () => false,
  schedule: async () => {},
  cancel: async () => {},
};
