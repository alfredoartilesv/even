import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import type { AddActions, FrameProps } from "../../shell/target";
import { DISABLED_HINT, TABS, type Tab, type TabItem } from "../../shell/tabs";
import { Icon, type IconName } from "../../ui/icons";
import { SheetClose } from "../../ui/layout";

/**
 * The phone's sections (Today, Food, Prep, Coach: Activity, Journal and You open from Today and
 * You), fixed to the bottom within thumb reach, with the Add button in the middle. Each tab's icon
 * is in its area's colour, and the open one gets a soft pill of it (android.css).
 */
export function TabBar({ tab, onTab, tabs = TABS, onAdd }: { tab: Tab; onTab: (t: Tab) => void; tabs?: TabItem[]; onAdd?: () => void }) {
  const phone = tabs.filter((t) => t.phone);
  const button = (t: TabItem) => (
    <button
      key={t.id}
      type="button"
      data-area={t.id}
      className={tab === t.id ? "active" : ""}
      aria-current={tab === t.id ? "page" : undefined}
      disabled={t.disabled}
      title={t.disabled ? DISABLED_HINT : undefined}
      aria-description={t.disabled ? DISABLED_HINT : undefined}
      onClick={() => onTab(t.id)}
    >
      <Icon name={t.icon} />
      <span>{t.short}</span>
    </button>
  );
  return (
    <nav className="tabbar" aria-label="Sections">
      {phone.slice(0, 2).map(button)}
      {onAdd && (
        <button type="button" className="tabbar-add" aria-label="Add" aria-haspopup="dialog" onClick={onAdd}>
          <Icon name="plus" size={26} />
        </button>
      )}
      {phone.slice(2).map(button)}
    </nav>
  );
}

const ADD_TILES: { id: keyof AddActions["here"]; label: string; sub: string; icon: IconName; area: Tab }[] = [
  { id: "food", label: "Food", sub: "A meal, a snack, a saved meal", icon: "food", area: "food" },
  { id: "drink", label: "Drink", sub: "A favourite or a one-off", icon: "alcohol", area: "food" },
  { id: "checkIn", label: "Check-in", sub: "Mood, energy and a note", icon: "note", area: "journal" },
  { id: "weight", label: "Weight", sub: "Or another measurement", icon: "scale", area: "journal" },
];

/**
 * What the Add button opens: a sheet over the page, the quick add on top, then a tile per kind of
 * entry that opens its form in the sheet (a tap logs a usual food or drink; 9 Nov 2026). Escape or
 * the scrim closes it, and focus goes back to the Add button.
 */
export function AddSheet({ add, onClose }: { add: AddActions; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLElement>("input, button")?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      before?.focus();
    };
  }, [onClose]);
  const [open, setOpen] = useState<keyof AddActions["here"] | null>(null);
  return (
    <>
      <div className="sheet-scrim" onClick={onClose} />
      <div ref={ref} className="add-sheet" role="dialog" aria-modal="true" aria-labelledby="add-title">
        <div className="add-sheet-head">
          <h2 id="add-title">Add</h2>
          <button type="button" className="icon-button" aria-label="Close" onClick={onClose}>
            <Icon name="close" />
          </button>
        </div>
        <SheetClose value={onClose}>
          <Suspense>{add.quick}</Suspense>
        </SheetClose>
        <h3 className="add-more">Or pick from</h3>
        <div className="add-tiles">
          {ADD_TILES.map((t) => (
            <div key={t.id} className={open === t.id ? "add-tile-group open" : "add-tile-group"} data-area={t.area}>
              <button type="button" className="add-tile" aria-expanded={open === t.id} onClick={() => setOpen(open === t.id ? null : t.id)}>
                <span className="add-tile-icon" aria-hidden>
                  <Icon name={t.icon} />
                </span>
                <span className="add-tile-text grow">
                  <strong>{t.label}</strong>
                  <span className="muted small">{t.sub}</span>
                </span>
                <span className="add-tile-chevron" aria-hidden>
                  <Icon name="chevron" size={18} />
                </span>
              </button>
              {open === t.id && (
                <div className="add-tile-body">
                  <SheetClose value={onClose}>
                    <Suspense>{add.here[t.id]}</Suspense>
                  </SheetClose>
                </div>
              )}
            </div>
          ))}
          <button
            type="button"
            className="add-tile"
            data-area="coach"
            disabled={!add.coach}
            title={add.coach ? undefined : DISABLED_HINT}
            onClick={() => {
              onClose();
              add.coach?.();
            }}
          >
            <span className="add-tile-icon" aria-hidden>
              <Icon name="sparkle" />
            </span>
            <span className="add-tile-text">
              <strong>Tell Coach</strong>
              <span className="muted small">{add.coach ? "Describe it or send a photo, Coach logs it once you confirm" : "Needs a Claude API key, in You > Connections"}</span>
            </span>
          </button>
        </div>
      </div>
    </>
  );
}

/** Android's frame: the page, with the tab bar under it and the Add sheet over it when open. */
export function TabBarFrame({ tab, onTab, tabs, add, children }: FrameProps) {
  const [adding, setAdding] = useState(false);
  const close = useCallback(() => setAdding(false), []);
  return (
    <>
      {children}
      <TabBar tab={tab} onTab={onTab} tabs={tabs} onAdd={() => setAdding(true)} />
      {adding && <AddSheet add={add} onClose={close} />}
    </>
  );
}
