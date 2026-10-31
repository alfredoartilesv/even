import type { FrameProps } from "../../shell/target";
import { TABS, type Tab, type TabItem } from "../../shell/tabs";
import { Icon } from "../../ui/icons";

/** The tabs (five, or four without Chat), fixed to the bottom of the screen within thumb reach. */
export function TabBar({ tab, onTab, tabs = TABS }: { tab: Tab; onTab: (t: Tab) => void; tabs?: TabItem[] }) {
  return (
    <nav className="tabbar" aria-label="Sections">
      {tabs.map((t) => (
        <button key={t.id} type="button" className={tab === t.id ? "active" : ""} aria-current={tab === t.id ? "page" : undefined} onClick={() => onTab(t.id)}>
          <Icon name={t.icon} />
          <span>{t.label}</span>
        </button>
      ))}
    </nav>
  );
}

/** Android's frame: the page, with the tab bar under it. */
export function TabBarFrame({ tab, onTab, tabs, children }: FrameProps) {
  return (
    <>
      {children}
      <TabBar tab={tab} onTab={onTab} tabs={tabs} />
    </>
  );
}
