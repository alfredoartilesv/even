import type { ComponentType, ReactNode } from "react";
import type { SyncSession } from "../domain/cloudsync/session";
import type { Tab, TabItem } from "./tabs";

/** What the shared shell knows about this device's sync connection, for a target's gate. */
export interface GateState {
  /** undefined while it loads, null when this device is not connected. */
  session: SyncSession | null | undefined;
  /** Adopt a new session (or none): the shell keeps it and syncs. */
  connect: (session: SyncSession | null) => void;
}

/** The account this device is connected to, for a target's navigation to show and leave. */
export interface FrameAccount {
  email: string;
  /** Disconnects this device; on the web its copy of the data goes too (and the page reloads). */
  signOut: () => Promise<void>;
}

/** What a quick Add offers (the phone's Add button): each opens the place to log it. */
export interface AddActions {
  food: () => void;
  drink: () => void;
  checkIn: () => void;
  weight: () => void;
  /** Only while Coach is on. */
  coach?: () => void;
  /** The quick add (type what you ate, drank or weighed) at the top of the sheet; its Done closes it (ui/layout SheetClose). */
  quick: ReactNode;
}

/** What the shell gives a target's navigation: the open section, a way to change it, and the page. */
export interface FrameProps {
  tab: Tab;
  onTab: (tab: Tab) => void;
  /** The sections to offer, in order (visibleTabs): Coach is left out while it is off. */
  tabs: TabItem[];
  /** The phone's Add button; a wide screen logs from each section instead. */
  add: AddActions;
  /** Null when this device is not connected to an account. */
  account: FrameAccount | null;
  /** The page (<main className="shell">), placed by the frame beside or above its navigation. */
  children: ReactNode;
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
  /**
   * The navigation between the sections, around the page: Android has a tab bar at the bottom
   * (thumb reach on the phone) with an Add button, the web app a dark side menu that docks on a wide screen.
   */
  Frame: ComponentType<FrameProps>;
  /**
   * The navigation lists every section, Activity and Journal included (the web's side menu), so
   * You does not repeat them. Android's tab bar has no room for them and You keeps them.
   */
  navListsAll?: boolean;
}
