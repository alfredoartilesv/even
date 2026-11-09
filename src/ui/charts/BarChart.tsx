import { useState, type KeyboardEvent, type ReactNode } from "react";
import { ChartFrame, EmptyPlot, SINGLE, Tooltip, useWidth, type LegendItem } from "./frame";
import { columnPath, compact, fmtValue, labelIndexes, linear, niceTicks } from "./scale";

export interface BarChartProps {
  title: string;
  subtitle?: string;
  /** The x positions, in order (usually local days). */
  x: string[];
  /** One value per x, null for nothing logged. */
  values: (number | null)[];
  formatX?: (x: string) => string;
  formatXLong?: (x: string) => string;
  formatValue?: (v: number) => string;
  unit?: string;
  /** A limit drawn as a labelled line. Bars above it switch to the warning color and say so. */
  target?: number | null;
  /** The highlighted x; its value is printed on its cap. */
  selected?: string | null;
  /** Makes each column a button (tap a day to open it). */
  onSelect?: (x: string) => void;
  height?: number;
  dim?: boolean;
  /** A button in the card's head beside Table (Today's pin). */
  action?: ReactNode;
}

const PAD = { top: 18, right: 8, bottom: 24, left: 40 };
const MAX_BAR = 24;

/**
 * Magnitude per x, columns from a zero baseline. Thin columns (24px at most) with a 4px rounded
 * end; the band's leftover is air. Over-target columns use the warning color, and the tooltip,
 * table and legend say "over target" so color is never the only signal.
 */
export function BarChart({
  title,
  subtitle,
  x,
  values,
  formatX = (s) => s,
  formatXLong,
  formatValue = fmtValue,
  unit,
  target = null,
  selected = null,
  onSelect,
  height = 170,
  dim,
  action,
}: BarChartProps) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const long = formatXLong ?? formatX;
  const withUnit = (v: number) => `${formatValue(v)}${unit ? ` ${unit}` : ""}`;
  const over = (v: number | null) => target !== null && v !== null && v > target;
  const describe = (i: number) => {
    const v = values[i];
    return v === null ? "nothing logged" : `${withUnit(v)}${over(v) ? ", over target" : ""}`;
  };

  const anyOver = values.some(over);
  const legend: LegendItem[] = anyOver
    ? [
        { label: "Within target", slot: null, mark: "rect" },
        { label: "Over target", slot: null, mark: "rect", color: "var(--warning)" },
      ]
    : [];
  // The table says the same in fewer words ("–", "2,767 kcal · over"), so with a large font each
  // value keeps one line beside its label; aria labels and the tooltip keep the full sentence.
  const cell = (i: number) => {
    const v = values[i];
    return v === null ? "–" : `${withUnit(v)}${over(v) ? " · over" : ""}`;
  };
  // The chart's title sits over the table already (and is its caption): the value column is "Value".
  const table = { columns: ["", "Value"], rows: x.map((xi, i) => [long(xi), cell(i)]) };

  const max = Math.max(0, target ?? 0, ...values.map((v) => v ?? 0));
  if (!x.length || (max === 0 && values.every((v) => v === null))) {
    return (
      <ChartFrame title={title} subtitle={subtitle} dim={dim} action={action}>
        <EmptyPlot height={height} />
      </ChartFrame>
    );
  }

  const ticks = niceTicks(0, max || 1);
  const plotW = Math.max(40, width - PAD.left - PAD.right);
  const plotH = height - PAD.top - PAD.bottom;
  const band = plotW / x.length;
  const barW = Math.max(2, Math.min(MAX_BAR, band - 2)); // at least the 2px surface gap between neighbours
  const sy = linear([0, ticks[ticks.length - 1]], [PAD.top + plotH, PAD.top]);
  const baseline = PAD.top + plotH;
  const cx = (i: number) => PAD.left + band * i + band / 2;

  return (
    <ChartFrame title={title} subtitle={subtitle} legend={legend} table={table} dim={dim} action={action}>
      <div ref={ref} className="viz-plot">
        <svg width={width} height={height} role={onSelect ? "group" : "img"} aria-label={title}>
          {ticks.map((t) => (
            <g key={t}>
              <line className={t === 0 ? "viz-axis" : "viz-grid"} x1={PAD.left} x2={PAD.left + plotW} y1={sy(t)} y2={sy(t)} />
              <text className="viz-tick" x={PAD.left - 6} y={sy(t)} dy="0.32em" textAnchor="end">
                {compact(t)}
              </text>
            </g>
          ))}
          {labelIndexes(x.length, plotW, 28).map((i) => (
            <text key={i} className={x[i] === selected ? "viz-tick strong" : "viz-tick"} x={cx(i)} y={baseline + 16} textAnchor="middle">
              {formatX(x[i])}
            </text>
          ))}
          {values.map((v, i) => {
            const isSel = x[i] === selected;
            const label = `${long(x[i])}: ${describe(i)}`;
            const bar = v ? columnPath(cx(i) - barW / 2, barW, sy(v), baseline) : "";
            const cls = ["viz-bar", over(v) && "over", (isSel || hover === i) && "active", selected !== null && !isSel && "muted"].filter(Boolean).join(" ");
            const interactive = onSelect
              ? {
                  role: "button",
                  tabIndex: 0,
                  "aria-label": label,
                  "aria-pressed": isSel,
                  onClick: () => onSelect(x[i]),
                  onKeyDown: (e: KeyboardEvent) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      onSelect(x[i]);
                    }
                  },
                }
              : {};
            return (
              <g
                key={x[i]}
                {...interactive}
                onPointerEnter={() => setHover(i)}
                onPointerLeave={() => setHover(null)}
                onFocus={() => setHover(i)}
                onBlur={() => setHover(null)}
              >
                {/* The hit target is the whole band, not the painted pixels. */}
                <rect className="viz-hit" x={PAD.left + band * i} y={PAD.top} width={band} height={plotH} />
                {bar && <path className={cls} d={bar} style={over(v) ? undefined : { fill: SINGLE }} />}
                {isSel && v !== null && (
                  <text className="viz-label" x={cx(i)} y={sy(v) - 5} textAnchor="middle">
                    {formatValue(v)}
                  </text>
                )}
              </g>
            );
          })}
          {target !== null && (
            <g pointerEvents="none">
              <line className="viz-target" x1={PAD.left} x2={PAD.left + plotW} y1={sy(target)} y2={sy(target)} />
              {/* Left end: the latest (usually selected) column is on the right, with its value on top. */}
              <text className="viz-tick halo" x={PAD.left + 2} y={sy(target) - 4}>
                target {formatValue(target)}
              </text>
            </g>
          )}
        </svg>
        {hover !== null && (
          <Tooltip
            x={cx(hover)}
            width={width}
            title={long(x[hover])}
            rows={[{ label: title, value: describe(hover), color: over(values[hover]) ? "var(--warning)" : SINGLE }]}
          />
        )}
      </div>
    </ChartFrame>
  );
}
