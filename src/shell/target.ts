import type { ReactNode } from "react";
import type { SyncSession } from "../domain/cloudsync/session";

/** What the shared shell knows about this device's sync connection, for a target's gate. */
export interface GateState {
  /** undefined while it loads, null when this device is not connected. */
  session: SyncSession | null | undefined;
  /** Adopt a new session (or none): the shell keeps it and syncs. */
  connect: (session: SyncSession | null) => void;
}

/**
 * What a target (src/apps/<target>/main.tsx) adds to the shared shell. The shell stays the same for
 * every target; anything only one of them needs comes in through here (docs/phases.md).
 */
export interface Target {
  /**
   * Shown instead of the app once the database is open, while it returns something: the web app
   * starts by connecting, because its data is a copy of the account's. Null lets the app through.
   */
  gate?: (state: GateState) => ReactNode | null;
}
