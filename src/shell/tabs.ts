import type { IconName } from "../ui/icons";

export type Tab = "dashboard" | "chat" | "mealprep" | "alcohol" | "settings";

export interface TabItem {
  id: Tab;
  label: string;
  icon: IconName;
}

/** The five sections, in order. Every target shows these; how it shows them is its own (Target.Frame). */
export const TABS: TabItem[] = [
  { id: "dashboard", label: "Dashboard", icon: "dashboard" },
  { id: "chat", label: "Chat", icon: "chat" },
  { id: "mealprep", label: "Meal prep", icon: "mealprep" },
  { id: "alcohol", label: "Alcohol", icon: "alcohol" },
  { id: "settings", label: "Settings", icon: "settings" },
];

/** The sections to show: Chat only when it can answer, on this device's own API key (domain/chat/mode.ts). */
export const visibleTabs = (chat: boolean): TabItem[] => (chat ? TABS : TABS.filter((t) => t.id !== "chat"));
