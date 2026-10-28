import type { FrameProps } from "../../shell/target";
import { TABS, type Tab } from "../../shell/tabs";
import { Icon } from "../../ui/icons";

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

/** Android's frame: the page, with the tab bar under it. */
export function TabBarFrame({ tab, onTab, children }: FrameProps) {
  return (
    <>
      {children}
      <TabBar tab={tab} onTab={onTab} />
    </>
  );
}
