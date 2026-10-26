import type { ReactNode } from "react";

/**
 * The frame every screen shares: the title row at the top of a tab, sub-tabs between the views
 * of a tab, and the segmented control for one choice among a few. Screens use these instead of
 * their own markup, so every tab looks and behaves the same.
 */

export interface Choice<T extends string> {
  id: T;
  label: string;
}

/**
 * Title row: an optional back button ("‹ Dashboard") or leading element (the profile picture),
 * the title, and actions on the right (sync, History, New).
 */
export function PageHeader({ title, leading, actions, onBack, backLabel = "Back" }: { title: string; leading?: ReactNode; actions?: ReactNode; onBack?: () => void; backLabel?: string }) {
  return (
    <header className="topbar">
      {onBack && (
        <button type="button" className="secondary small-button" onClick={onBack} aria-label={`Back to ${backLabel}`}>
          ‹ {backLabel}
        </button>
      )}
      {leading}
      <h1 className="grow">{title}</h1>
      {actions}
    </header>
  );
}

/** The views of one tab, as a row that scrolls sideways when it does not fit. The open view is aria-current. */
export function SubTabs<T extends string>({ items, value, onChange, label }: { items: Choice<T>[]; value: T; onChange: (id: T) => void; label: string }) {
  return (
    <nav className="tabs sub" aria-label={label}>
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
