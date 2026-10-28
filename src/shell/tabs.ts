import type { IconName } from "../ui/icons";

export type Tab = "dashboard" | "chat" | "mealprep" | "alcohol" | "settings";

/** The five sections, in order. Every target shows these; how it shows them is its own (Target.Frame). */
export const TABS: { id: Tab; label: string; icon: IconName }[] = [
  { id: "dashboard", label: "Dashboard", icon: "dashboard" },
  { id: "chat", label: "Chat", icon: "chat" },
  { id: "mealprep", label: "Meal prep", icon: "mealprep" },
  { id: "alcohol", label: "Alcohol", icon: "alcohol" },
  { id: "settings", label: "Settings", icon: "settings" },
];
