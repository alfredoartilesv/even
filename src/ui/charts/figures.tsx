import type { ReactNode } from "react";
import { Legend, seriesColor, SINGLE, type LegendItem } from "./frame";
import { extent, fmtValue, lastValueIndex, linear, linePath, segments } from "./scale";

/**
 * Charts whose form is a number: the stat tile, its sparkline, the meter, and the part-to-whole
 * bar. No axes; the numbers are printed, so none of them needs a table view.
 */

/** A small trend with no axes: the line in the de-emphasis color, the latest point in the accent. */
export function Sparkline({ values, label, width = 96, height = 28 }: { values: (number | null)[]; label: string; width?: number; height?: number }) {
  const ext = extent(values);
  if (!ext || values.length < 2) return null;
  const sx = linear([0, values.length - 1], [3, width - 5]);
  const sy = linear(ext, [height - 4, 4]);
  const last = lastValueIndex(values);
  return (
    <svg className="viz-spark" width={width} height={height} role="img" aria-label={label}>
      {segments(values).map((seg) => (
        <path key={seg.start} className="viz-line thin" d={linePath(seg.values.map((v, k) => [sx(seg.start + k), sy(v)]))} />
      ))}
      <circle className="viz-dot" cx={sx(last)} cy={sy(values[last]!)} r={3.5} style={{ fill: SINGLE }} />
    </svg>
  );
}

export interface Delta {
  /** Signed change, already in display units. */
  value: number;
  /** What it is compared with: "vs last week". */
  period: string;
  /** Which direction is good news. "none" for changes that are neither (body weight on maintenance). */
  good: "up" | "down" | "none";
}

/**
 * One headline number: label, value, optional change against a named period, optional trend.
 * The change carries an arrow and words, so its color is never the only signal.
 */
export function StatTile({
  label,
  value,
  unit,
  delta,
  trend,
  formatDelta = fmtValue,
  note,
}: {
  label: string;
  /** Already formatted ("7,492", "6 h 05 min"); null shows a dash. */
  value: string | null;
  unit?: string;
  delta?: Delta | null;
  trend?: (number | null)[];
  formatDelta?: (v: number) => string;
  note?: string;
}) {
  const dir = delta ? (delta.value > 0 ? "up" : delta.value < 0 ? "down" : "flat") : null;
  const tone = !delta || dir === "flat" || delta.good === "none" ? "neutral" : dir === delta.good ? "good" : "bad";
  return (
    <div className="viz-tile">
      <div className="muted small">{label}</div>
      <div className="viz-tile-value">
        <strong>{value ?? "–"}</strong>
        {value !== null && unit && <span className="muted"> {unit}</span>}
      </div>
      {delta && (
        <div className={`small viz-delta ${tone}`}>
          <span aria-hidden>{dir === "up" ? "▲" : dir === "down" ? "▼" : "●"}</span>{" "}
          {dir === "flat" ? "no change" : `${delta.value > 0 ? "+" : "−"}${formatDelta(Math.abs(delta.value))}`} <span className="muted">{delta.period}</span>
        </div>
      )}
      {note && <div className="muted small">{note}</div>}
      {trend && <Sparkline values={trend} label={`${label}, recent trend`} />}
    </div>
  );
}

/**
 * A value against a limit. The track is a light step of the fill's own hue; past the limit the
 * fill turns to the warning color and the text says how far over.
 */
export function Meter({
  value,
  max,
  label,
  children,
  slot,
  overIsFine = false,
}: {
  value: number;
  max: number;
  label: string;
  children?: ReactNode;
  /** Categorical slot for the fill (protein's color, say); the accent without one. */
  slot?: number;
  /** A floor, not a limit (protein): going past it is not a warning. */
  overIsFine?: boolean;
}) {
  const over = value > max && !overIsFine;
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  return (
    <>
      <div className={over ? "viz-meter over" : "viz-meter"} role="meter" aria-valuemin={0} aria-valuemax={max} aria-valuenow={value} aria-label={label}>
        <div className="fill" style={{ width: `${pct}%`, ...(slot && !over ? { background: seriesColor(slot) } : {}) }} />
      </div>
      {children}
    </>
  );
}

export interface Part {
  label: string;
  value: number;
  /** Categorical slot 1-8, fixed per part (protein is always slot 1, say). */
  slot: number;
}

/**
 * Part-to-whole in one horizontal bar, 2px surface gaps between parts. The legend underneath
 * carries every value and share as text, so no label is ever squeezed inside a segment.
 */
export function StackedBar({ parts, format = fmtValue, unit, label }: { parts: Part[]; format?: (v: number) => string; unit?: string; label: string }) {
  const total = parts.reduce((s, p) => s + Math.max(0, p.value), 0);
  const items: LegendItem[] = parts.map((p) => ({
    label: p.label,
    slot: p.slot,
    mark: "rect",
    value: `${format(p.value)}${unit ? ` ${unit}` : ""}${total > 0 ? ` · ${Math.round((p.value / total) * 100)}%` : ""}`,
  }));
  return (
    <div className="viz-stack-wrap">
      <div className="viz-stack" role="img" aria-label={`${label}: ${items.map((i) => `${i.label} ${i.value}`).join(", ")}`}>
        {total > 0 ? (
          parts.filter((p) => p.value > 0).map((p) => <div key={p.label} style={{ flexGrow: p.value, background: seriesColor(p.slot) }} />)
        ) : (
          <div className="empty" />
        )}
      </div>
      <Legend items={items} />
    </div>
  );
}

/**
 * Progress toward a target as a ring, the number in the middle. `limit` targets (calories) turn
 * the warning color past the target and say "over"; `goal` targets (steps) just fill. The arc
 * grows in on first paint (CSS), except with reduced motion.
 */
export function Ring({
  value,
  target,
  label,
  unit,
  kind = "goal",
  format = fmtValue,
  size = 132,
}: {
  value: number | null;
  target: number | null;
  label: string;
  unit?: string;
  kind?: "goal" | "limit";
  format?: (v: number) => string;
  size?: number;
}) {
  const stroke = 10;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const frac = value !== null && target ? Math.max(0, value / target) : 0;
  const over = kind === "limit" && target !== null && value !== null && value > target;
  const left = target !== null && value !== null ? target - value : null;
  const note =
    value === null
      ? "no data"
      : target === null
        ? (unit ?? "")
        : over
          ? `${format(value - target)} over`
          : kind === "limit"
            ? `${format(Math.max(0, left!))} left`
            : left! > 0
              ? `${format(left!)} to go`
              : "goal met";
  return (
    <div
      className="ring"
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={target ?? undefined}
      aria-valuenow={value ?? undefined}
      aria-valuetext={value === null ? "no data" : `${format(value)}${unit ? ` ${unit}` : ""}${target !== null ? ` of ${format(target)}, ${note}` : ""}`}
    >
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden>
        <circle className="ring-track" cx={size / 2} cy={size / 2} r={r} strokeWidth={stroke} />
        {target !== null && value !== null && (
          <circle
            className={over ? "ring-fill over" : "ring-fill"}
            cx={size / 2}
            cy={size / 2}
            r={r}
            strokeWidth={stroke}
            strokeDasharray={c}
            strokeDashoffset={c * (1 - Math.min(1, frac))}
            transform={`rotate(-90 ${size / 2} ${size / 2})`}
            style={{ ["--ring-c" as string]: c }}
          />
        )}
      </svg>
      <div className="ring-center">
        <strong>{value === null ? "–" : format(value)}</strong>
        <span className={over ? "small warning" : "small muted"}>{note}</span>
      </div>
      <div className="ring-label small">
        {label}
        {target !== null && <span className="muted"> · {format(target)}</span>}
      </div>
    </div>
  );
}

/** One macro around Today's ring: grams eaten against the day's target (null: no target set). */
export interface RingMacro {
  key: string;
  label: string;
  grams: number | null;
  target: number | null;
  /** Its series color while within the target. */
  color: string;
}

/** The macro rings sit outside the calorie ring, protein nearest it: radius of the first and the step out. */
const MACRO_R0 = 88;
const MACRO_STEP = 12;

/**
 * Today's big ring (handoff 0.7): calories eaten against the target, with what is left in the
 * middle, or how far over in the warning colour. Without a target it shows what was eaten.
 * With macros, each wraps the calorie ring as a thinner ring of its own (the owner's choice,
 * 14 Nov 2026): it fills toward its target and, past it, closes in the warning colour like the
 * calories do. A macro without a target keeps an empty track.
 */
export function BalanceRing({
  eaten,
  target,
  size = 184,
  caption = "kcal left today",
  macros,
}: {
  eaten: number | null;
  target: number | null;
  size?: number;
  caption?: string;
  macros?: RingMacro[];
}) {
  const r = 70;
  const c = 2 * Math.PI * r;
  const e = eaten ?? 0;
  const over = target !== null && e > target;
  const frac = target ? Math.min(1, e / target) : 0;
  const big = target === null ? Math.round(e).toLocaleString() : Math.round(Math.abs(target - e)).toLocaleString();
  const rings = macros ?? [];
  // The box grows by the macro rings so the calorie ring keeps its size inside it.
  const half = 80 + (rings.length ? MACRO_R0 - 80 + MACRO_STEP * (rings.length - 1) + 10 : 0);
  const mid = half;
  const macroText = rings.map((m) => `${m.label} ${Math.round(m.grams ?? 0)}${m.target ? ` of ${Math.round(m.target)}` : ""} g`).join(", ");
  const label =
    (target === null
      ? `${Math.round(e).toLocaleString()} kcal eaten, no target set`
      : `${Math.round(e).toLocaleString()} of ${Math.round(target).toLocaleString()} kcal eaten, ${big} ${over ? "over" : "left"}`) +
    (macroText ? `. ${macroText}` : "");
  return (
    <svg
      className={`balance-ring${over ? " over" : ""}${rings.length ? " with-macros" : ""}`}
      role="img"
      aria-label={label}
      width={size}
      height={size}
      viewBox={`0 0 ${half * 2} ${half * 2}`}
    >
      {rings.map((m, i) => {
        const mr = MACRO_R0 + MACRO_STEP * i;
        const mc = 2 * Math.PI * mr;
        const g = m.grams ?? 0;
        const mOver = m.target !== null && g > m.target;
        const mf = m.target ? Math.min(1, g / m.target) : 0;
        return (
          <g key={m.key} className={`macro${mOver ? " over" : ""}`}>
            <circle className="macro-track" cx={mid} cy={mid} r={mr} />
            {mf > 0 && (
              <circle
                className="macro-fill"
                cx={mid}
                cy={mid}
                r={mr}
                style={mOver ? undefined : { stroke: m.color }}
                strokeDasharray={`${(mf * mc).toFixed(1)} ${mc.toFixed(1)}`}
                transform={`rotate(-90 ${mid} ${mid})`}
              />
            )}
          </g>
        );
      })}
      <circle className="track" cx={mid} cy={mid} r={r} />
      <circle className="fill" cx={mid} cy={mid} r={r} strokeDasharray={`${(frac * c).toFixed(1)} ${c.toFixed(1)}`} transform={`rotate(-90 ${mid} ${mid})`} />
      <text className="big" x={mid} y={mid + 2} textAnchor="middle">
        {big}
      </text>
      <text className="small" x={mid} y={mid + 24} textAnchor="middle">
        {target === null ? "kcal eaten" : over ? "kcal over target" : caption}
      </text>
    </svg>
  );
}
