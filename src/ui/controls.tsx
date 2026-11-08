import { useRef, useState, type InputHTMLAttributes, type ReactNode } from "react";
import { Icon } from "./icons";

/**
 * Small controls shared by screens: chip groups, the date-range picker that sits above the charts it
 * scopes, a number stepper, status badges, on/off switches, and password / key fields.
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
export function ChipGroup<T extends string | number>({
  options,
  value,
  onChange,
  label,
}: {
  options: { id: T; label: string }[];
  value: T;
  onChange: (id: T) => void;
  label: string;
}) {
  return (
    <div className="chips" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          role="radio"
          aria-checked={o.id === value}
          className={o.id === value ? "chip active" : "chip"}
          onClick={() => onChange(o.id)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** One row of presets, above every chart it scopes (never inside a chart card). */
export function RangePicker({
  value,
  onChange,
  options = RANGES,
  label = "Range",
}: {
  value: number;
  onChange: (days: number) => void;
  options?: RangeOption[];
  label?: string;
}) {
  return <ChipGroup options={options.map((o) => ({ id: o.days, label: o.label }))} value={value} onChange={onChange} label={label} />;
}

/**
 * − n + for counts (portions) and, with a step and a format, for amounts (height, weight, a
 * daily target). Buttons are 44px targets; the value is announced on change.
 */
export function Stepper({
  value,
  onChange,
  min = 0,
  max = 99,
  step = 1,
  format = String,
  label,
}: {
  value: number;
  onChange: (n: number) => void;
  min?: number;
  max?: number;
  step?: number;
  format?: (n: number) => string;
  label: string;
}) {
  // Rounded to the step's decimals, so 0.1 steps never show 82.30000000000001.
  const round = (n: number) => Number(n.toFixed(6));
  return (
    <div className="stepper" role="group" aria-label={label}>
      <button
        type="button"
        className="secondary"
        aria-label={`Fewer: ${label}`}
        disabled={value <= min}
        onClick={() => onChange(round(Math.max(min, value - step)))}
      >
        −
      </button>
      <output aria-live="polite">{format(value)}</output>
      <button
        type="button"
        className="secondary"
        aria-label={`More: ${label}`}
        disabled={value >= max}
        onClick={() => onChange(round(Math.min(max, value + step)))}
      >
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

/**
 * An on/off setting as a row: the label (and a line saying what it does) on the left, the switch on
 * the right. A real checkbox with role="switch", so it reads as "on" or "off" and the whole row is
 * the tap target.
 */
export function Switch({
  checked,
  onChange,
  label,
  description,
  note,
  disabled,
}: {
  checked: boolean;
  onChange: (on: boolean) => void;
  label: string;
  description?: ReactNode;
  note?: ReactNode;
  disabled?: boolean;
}) {
  return (
    <label className="switch-row">
      <span className="grow">
        <span className="switch-label">
          {label}
          {note && <span className="muted small"> {note}</span>}
        </span>
        {description && <span className="muted small switch-desc">{description}</span>}
      </span>
      <input type="checkbox" role="switch" className="switch" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
    </label>
  );
}

/**
 * A 1-5 rating (mood, energy): five round steps, the chosen word under them. Tapping the chosen
 * step again clears it. Each step is a radio named with its word, so it is never a bare number.
 */
export function ScaleRating({
  value,
  onChange,
  label,
  words,
}: {
  value: number | null;
  onChange: (v: number | null) => void;
  label: string;
  words: readonly string[];
}) {
  return (
    <div className="scale">
      <div className="scale-head">
        <span>{label}</span>
        <span className="muted small">{value === null ? "not set" : words[value - 1]}</span>
      </div>
      <div className="scale-steps" role="radiogroup" aria-label={label}>
        {words.map((w, i) => (
          <button
            key={w}
            type="button"
            role="radio"
            aria-checked={value === i + 1}
            aria-label={`${i + 1}: ${w}`}
            className={value !== null && i + 1 <= value ? "on" : ""}
            onClick={() => onChange(value === i + 1 ? null : i + 1)}
          >
            {i + 1}
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * A password or API key field with Clear and Show / Hide buttons inside it, so a long key can be
 * checked before saving and a wrong paste removed in one tap. Shown as text, it still asks the
 * keyboard not to learn or correct it.
 */
export function SecretInput({
  value,
  onChange,
  noun = "password",
  ...rest
}: { value: string; onChange: (v: string) => void; noun?: string } & Omit<InputHTMLAttributes<HTMLInputElement>, "value" | "onChange" | "type">) {
  const [shown, setShown] = useState(false);
  const ref = useRef<HTMLInputElement>(null);
  return (
    <span className="secret-input">
      <input
        {...rest}
        ref={ref}
        type={shown ? "text" : "password"}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
      />
      <span className="secret-actions">
        {value && (
          <button
            type="button"
            className="icon-button ghost"
            aria-label={`Clear the ${noun}`}
            onClick={() => {
              onChange("");
              ref.current?.focus();
            }}
          >
            <Icon name="close" size={18} />
          </button>
        )}
        <button
          type="button"
          className="icon-button ghost"
          aria-label={`${shown ? "Hide" : "Show"} the ${noun}`}
          aria-pressed={shown}
          onClick={() => setShown(!shown)}
        >
          <Icon name={shown ? "eyeOff" : "eye"} size={18} />
        </button>
      </span>
    </span>
  );
}

/**
 * The head of a connection card (handoff 0.7, You > Connections): the name, a dot and a word for its
 * state, one line on what it brings, and the one action that matters now on the right.
 */
export function ConnHead({ name, status, tone, note, action }: { name: string; status: string; tone: Status; note: ReactNode; action?: ReactNode }) {
  return (
    <div className="conn-head">
      <span className="grow">
        <h2>{name}</h2>
        <span className="conn-status">
          <span className={`conn-dot ${tone}`} aria-hidden />
          {status}
        </span>
        <span className="muted small">{note}</span>
      </span>
      {action}
    </div>
  );
}
