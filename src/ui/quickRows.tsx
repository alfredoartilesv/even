import type { ReactNode } from "react";
import { Icon } from "./icons";

/**
 * One row of a one-tap list (Eat again, From your meal prep): a picture, the name and a line or
 * two, an optional pencil, and a round + that turns into a check which undoes the tap.
 */
export function QuickRow({
  picture,
  title,
  children,
  done,
  label,
  onTap,
  onEdit,
  editing,
}: {
  picture: ReactNode;
  title: ReactNode;
  children?: ReactNode;
  done: boolean;
  /** What the + does, for screen readers: "Log Chicken rice bowl". */
  label: string;
  onTap: () => void;
  onEdit?: () => void;
  /** The edit form, under the row while it is open. */
  editing?: ReactNode;
}) {
  return (
    <li className="tap-row">
      <div className="tap-row-main">
        {picture}
        <span className="tap-row-text">
          <span className="tap-row-name">{title}</span>
          {children}
        </span>
        {onEdit && (
          <button
            type="button"
            className="tap-row-edit secondary"
            aria-label={`Edit ${label.replace(/^\S+ /, "")}`}
            aria-expanded={Boolean(editing)}
            onClick={onEdit}
          >
            <Icon name="pencil" size={18} />
          </button>
        )}
        <button type="button" className={done ? "tap-row-add done" : "tap-row-add"} aria-label={done ? `Undo: ${label}` : label} onClick={onTap}>
          <Icon name={done ? "check" : "plus"} size={22} />
        </button>
      </div>
      {editing}
    </li>
  );
}

/** The confirmation under a one-tap list, with Undo, so the tap shows where it was made. */
export function DoneBar({ text, onUndo }: { text: string; onUndo: () => void }) {
  return (
    <div className="tap-done" role="status">
      <span>{text}</span>
      <button type="button" className="link accent" onClick={onUndo}>
        Undo
      </button>
    </div>
  );
}
