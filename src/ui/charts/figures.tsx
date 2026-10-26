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
          <span aria-hidden>{dir === "up" ? "▲" : dir === "down" ? "▼" : "●"}</span> {dir === "flat" ? "no change" : `${delta.value > 0 ? "+" : "−"}${formatDelta(Math.abs(delta.value))}`}{" "}
          <span className="muted">{delta.period}</span>
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
export function Meter({ value, max, label, children }: { value: number; max: number; label: string; children?: ReactNode }) {
  const over = value > max;
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  return (
    <>
      <div className={over ? "viz-meter over" : "viz-meter"} role="meter" aria-valuemin={0} aria-valuemax={max} aria-valuenow={value} aria-label={label}>
        <div className="fill" style={{ width: `${pct}%` }} />
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
        {total > 0
          ? parts.filter((p) => p.value > 0).map((p) => <div key={p.label} style={{ flexGrow: p.value, background: seriesColor(p.slot) }} />)
          : <div className="empty" />}
      </div>
      <Legend items={items} />
    </div>
  );
}
