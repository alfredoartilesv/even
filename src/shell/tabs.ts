import type { IconName } from "../ui/icons";

/**
 * The app's sections (docs/LLD.md, navigation). Each is also a colour area: the shell sets
 * data-area on the page and the palette gives every area its own accent (ui/palette.css).
 */
export type Tab = "today" | "food" | "prep" | "activity" | "journal" | "coach" | "you";

export interface TabItem {
  id: Tab;
  label: string;
  /** The label under the icon in the phone's tab bar, where there is less room. */
  short: string;
  icon: IconName;
  /** In the phone's tab bar. The others open from Today and You there; a wide screen lists them all. */
  phone: boolean;
  /** Shown greyed out and not clickable: Coach while it is off, so the owner still sees where it lives. */
  disabled?: boolean;
}

/** Every section, in the side menu's order. You sits apart, at the menu's foot (apps/web/SideNav.tsx). */
export const TABS: TabItem[] = [
  { id: "today", label: "Today", short: "Today", icon: "dashboard", phone: true },
  { id: "food", label: "Food and drinks", short: "Food", icon: "food", phone: true },
  { id: "prep", label: "Meal prep", short: "Prep", icon: "mealprep", phone: true },
  { id: "activity", label: "Activity", short: "Activity", icon: "pulse", phone: false },
  { id: "journal", label: "Journal", short: "Journal", icon: "book", phone: false },
  { id: "coach", label: "Coach", short: "Coach", icon: "sparkle", phone: true },
  { id: "you", label: "You", short: "You", icon: "user", phone: false },
];

/**
 * The sections to show. Coach stays in place while it is off (domain/chat/mode.ts), greyed out and
 * not clickable, rather than disappearing (the owner's ask, 9 Nov 2026).
 */
export const visibleTabs = (coach: boolean): TabItem[] => (coach ? TABS : TABS.map((t) => (t.id === "coach" ? { ...t, disabled: true } : t)));

/** Why a greyed-out section cannot be opened, for its tooltip and screen readers. */
export const DISABLED_HINT = "Coach needs a Claude API key: add one in You > Connections";
