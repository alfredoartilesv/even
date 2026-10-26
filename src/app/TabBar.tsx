import { Icon, type IconName } from "../ui/icons";

export type Tab = "dashboard" | "chat" | "mealprep" | "alcohol" | "settings";

export const TABS: { id: Tab; label: string; icon: IconName }[] = [
  { id: "dashboard", label: "Dashboard", icon: "dashboard" },
  { id: "chat", label: "Chat", icon: "chat" },
  { id: "mealprep", label: "Meal prep", icon: "mealprep" },
  { id: "alcohol", label: "Alcohol", icon: "alcohol" },
  { id: "settings", label: "Settings", icon: "settings" },
];

/** The five tabs, fixed to the bottom of the screen within thumb reach. */
export function TabBar({ tab, onTab }: { tab: Tab; onTab: (t: Tab) => void }) {
  return (
    <nav className="tabbar" aria-label="Sections">
      {TABS.map((t) => (
        <button key={t.id} type="button" className={tab === t.id ? "active" : ""} aria-current={tab === t.id ? "page" : undefined} onClick={() => onTab(t.id)}>
          <Icon name={t.icon} />
          <span>{t.label}</span>
        </button>
      ))}
    </nav>
  );
}
