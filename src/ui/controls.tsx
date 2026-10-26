import type { ReactNode } from "react";

/**
 * Small controls shared by screens: chip groups, the date-range picker that sits above the charts it
 * scopes, a number stepper, and status badges.
 */

export interface RangeOption {
  days: number;
  label: string;
}

export const RANGES: RangeOption[] = [
  { days: 7, label: "7 days" },
  { days: 30, label: "30 days" },
  { days: 90, label: "90 days" },
  { days: 365, label: "1 year" },
];

/** One choice among chips (a period, a filter), as a radio group. */
export function ChipGroup<T extends string | number>({ options, value, onChange, label }: { options: { id: T; label: string }[]; value: T; onChange: (id: T) => void; label: string }) {
  return (
    <div className="chips" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button key={o.id} type="button" role="radio" aria-checked={o.id === value} className={o.id === value ? "chip active" : "chip"} onClick={() => onChange(o.id)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** One row of presets, above every chart it scopes (never inside a chart card). */
export function RangePicker({ value, onChange, options = RANGES, label = "Range" }: { value: number; onChange: (days: number) => void; options?: RangeOption[]; label?: string }) {
  return <ChipGroup options={options.map((o) => ({ id: o.days, label: o.label }))} value={value} onChange={onChange} label={label} />;
}

/** − n + for small counts (portions). Buttons are 44px targets; the number is announced on change. */
export function Stepper({ value, onChange, min = 0, max = 99, label }: { value: number; onChange: (n: number) => void; min?: number; max?: number; label: string }) {
  return (
    <div className="stepper" role="group" aria-label={label}>
      <button type="button" className="secondary" aria-label={`Fewer: ${label}`} disabled={value <= min} onClick={() => onChange(Math.max(min, value - 1))}>
        −
      </button>
      <output aria-live="polite">{value}</output>
      <button type="button" className="secondary" aria-label={`More: ${label}`} disabled={value >= max} onClick={() => onChange(Math.min(max, value + 1))}>
        +
      </button>
    </div>
  );
}

export type Status = "good" | "info" | "warning" | "critical";

const ICON: Record<Status, string> = { good: "✓", info: "●", warning: "!", critical: "✕" };

/** A state as icon plus words: the color is never the only signal. */
export function StatusBadge({ status, children }: { status: Status; children: ReactNode }) {
  return (
    <span className={`status ${status}`}>
      <span aria-hidden>{ICON[status]}</span>
      {children}
    </span>
  );
}
