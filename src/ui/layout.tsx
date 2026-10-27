import { useEffect, useRef, type ReactNode } from "react";
import { Icon, type IconName } from "./icons";

/**
 * The frame every screen shares: the title row at the top of a tab, section headings, sub-tabs
 * between the views of a tab, the segmented control, quick actions and menu lists. Screens use
 * these instead of their own markup, so every tab looks and behaves the same.
 */

export interface Choice<T extends string> {
  id: T;
  label: string;
}

/**
 * Title row: an optional back button ("‹ Dashboard") or leading element (the profile picture),
 * the title with an optional line under it, and actions on the right (sync, History, New).
 */
export function PageHeader({ title, subtitle, leading, actions, onBack, backLabel = "Back" }: { title: string; subtitle?: string; leading?: ReactNode; actions?: ReactNode; onBack?: () => void; backLabel?: string }) {
  return (
    <header className="topbar">
      {onBack && (
        <button type="button" className="back-button" onClick={onBack} aria-label={`Back to ${backLabel}`}>
          <Icon name="back" size={20} />
          <span>{backLabel}</span>
        </button>
      )}
      {leading}
      <div className="grow topbar-title">
        <h1>{title}</h1>
        {subtitle && <div className="muted small">{subtitle}</div>}
      </div>
      {actions}
    </header>
  );
}

/** A section's heading, with an optional link on the right ("Open meal prep ›"). */
export function SectionHeader({ title, action, onAction }: { title: string; action?: string; onAction?: () => void }) {
  return (
    <div className="section-head">
      <h2>{title}</h2>
      {action && onAction && (
        <button type="button" className="link accent small" onClick={onAction}>
          {action} ›
        </button>
      )}
    </div>
  );
}

/** The views of one tab, as a row that scrolls sideways when it does not fit. The open view is aria-current. */
export function SubTabs<T extends string>({ items, value, onChange, label }: { items: Choice<T>[]; value: T; onChange: (id: T) => void; label: string }) {
  // On a narrow phone the row scrolls: keep the open view in sight, not cut off at the edge.
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    const nav = ref.current;
    const on = nav?.querySelector<HTMLElement>("button.active");
    if (!nav || !on) return;
    const n = nav.getBoundingClientRect();
    const b = on.getBoundingClientRect();
    if (b.left < n.left) nav.scrollLeft -= n.left - b.left + 8;
    else if (b.right > n.right) nav.scrollLeft += b.right - n.right + 8;
  }, [value]);
  return (
    <nav ref={ref} className="tabs sub" aria-label={label}>
      {items.map((it) => (
        <button key={it.id} type="button" className={value === it.id ? "active" : ""} aria-current={value === it.id ? "page" : undefined} onClick={() => onChange(it.id)}>
          {it.label}
        </button>
      ))}
    </nav>
  );
}

/** One of a few equal options (Day / Week / Month), as a radio group in one bar. */
export function Segmented<T extends string>({ items, value, onChange, label }: { items: Choice<T>[]; value: T; onChange: (id: T) => void; label: string }) {
  return (
    <div className="segmented" role="radiogroup" aria-label={label}>
      {items.map((it) => (
        <button key={it.id} type="button" role="radio" aria-checked={value === it.id} className={value === it.id ? "active" : ""} onClick={() => onChange(it.id)}>
          {it.label}
        </button>
      ))}
    </div>
  );
}

export interface QuickAction {
  id: string;
  label: string;
  icon: IconName;
  onClick: () => void;
}

/** The few things done most often, as big icon buttons in one row (Log food, Log a drink, Ask Claude). */
export function QuickActions({ actions, label = "Quick actions" }: { actions: QuickAction[]; label?: string }) {
  return (
    <div className="quick-actions" role="group" aria-label={label}>
      {actions.map((a) => (
        <button key={a.id} type="button" className="quick-action" onClick={a.onClick}>
          <span className="quick-icon">
            <Icon name={a.icon} size={22} />
          </span>
          <span>{a.label}</span>
        </button>
      ))}
    </div>
  );
}

export interface MenuItem<T extends string> {
  id: T;
  label: string;
  description?: string;
  icon: IconName;
}

/** Rows that open a page: icon, title, a line on what is inside, and a chevron. Groups get a small heading. */
export function MenuList<T extends string>({ groups, onOpen }: { groups: { title?: string; items: MenuItem<T>[] }[]; onOpen: (id: T) => void }) {
  return (
    <div className="menu">
      {groups.map((g, i) => (
        <section key={g.title ?? i} className="menu-group">
          {g.title && <h2 className="menu-title">{g.title}</h2>}
          <ul>
            {g.items.map((it) => (
              <li key={it.id}>
                <button type="button" className="menu-row" onClick={() => onOpen(it.id)}>
                  <span className="menu-icon">
                    <Icon name={it.icon} size={20} />
                  </span>
                  <span className="grow">
                    <span className="menu-label">{it.label}</span>
                    {it.description && <span className="menu-desc muted small">{it.description}</span>}
                  </span>
                  <Icon name="chevron" size={18} />
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
