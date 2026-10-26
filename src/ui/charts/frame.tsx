import { useEffect, useId, useRef, useState, type ReactNode } from "react";

/**
 * The parts every chart is made of: its frame (title, legend, table view), the tooltip, and the
 * width hook that lets charts draw in real pixels so text never scales with the SVG.
 */

/**
 * Series colors by role, slots 1 to 8 (validated for color-vision deficiency in this order).
 * Slot n is a fixed hue: color follows the series, never its rank. There is no 9th: fold the rest
 * into "Other" or split the chart.
 */
export const seriesColor = (slot: number) => `var(--series-${slot})`;
/** A chart with one series uses the app accent. */
export const SINGLE = "var(--accent)";

/** Width of the element, following resizes. Starts at `fallback` (also what server rendering and tests see). */
export function useWidth<T extends HTMLElement>(fallback = 320) {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(fallback);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.clientWidth || fallback);
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.round(e.contentRect.width) || fallback));
    ro.observe(el);
    return () => ro.disconnect();
  }, [fallback]);
  return [ref, width] as const;
}

export interface LegendItem {
  label: string;
  /** Categorical slot, or null for the single-series accent. */
  slot: number | null;
  /** Mirrors the mark: a short line for line charts, a square for bars and segments. */
  mark: "line" | "rect";
  /** Optional value shown after the label (part-to-whole legends carry the numbers). */
  value?: string;
  /** Overrides the color, for status keys such as "over target". */
  color?: string;
}

export function Legend({ items }: { items: LegendItem[] }) {
  if (!items.length) return null;
  return (
    <ul className="viz-legend">
      {items.map((it) => (
        <li key={it.label}>
          <span className={`viz-key ${it.mark}`} style={{ background: it.color ?? (it.slot === null ? SINGLE : seriesColor(it.slot)) }} aria-hidden />
          <span>{it.label}</span>
          {it.value !== undefined && <strong>{it.value}</strong>}
        </li>
      ))}
    </ul>
  );
}

export interface TableView {
  columns: string[];
  rows: string[][];
}

/** The chart's accessible twin: every value as text. */
export function DataTable({ table, caption }: { table: TableView; caption: string }) {
  return (
    <div className="viz-table">
      <table className="values">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr>
            {table.columns.map((c, i) => (
              <th key={c} scope="col" className={i ? "num" : undefined}>
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {table.rows.map((r, i) => (
            <tr key={i}>
              {r.map((cell, j) =>
                j === 0 ? (
                  <th key={j} scope="row">
                    {cell}
                  </th>
                ) : (
                  <td key={j} className="num">
                    {cell}
                  </td>
                ),
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * A chart card: title and subtitle, the legend (only for two or more series), the chart, and a
 * "Table" toggle that swaps the chart for its data table.
 */
export function ChartFrame({
  title,
  subtitle,
  legend,
  table,
  dim = false,
  children,
}: {
  title: string;
  subtitle?: ReactNode;
  legend?: LegendItem[];
  table?: TableView;
  /** Data is reloading: keep the previous render, faded, instead of a flash. */
  dim?: boolean;
  children: ReactNode;
}) {
  const [asTable, setAsTable] = useState(false);
  const id = useId();
  return (
    <figure className="viz" aria-labelledby={`${id}-t`} style={dim ? { opacity: 0.5 } : undefined}>
      <div className="viz-head">
        <div className="grow">
          <h3 id={`${id}-t`}>{title}</h3>
          {subtitle && <div className="muted small">{subtitle}</div>}
        </div>
        {table && table.rows.length > 0 && (
          <button type="button" className="secondary viz-toggle" aria-pressed={asTable} onClick={() => setAsTable(!asTable)}>
            {asTable ? "Chart" : "Table"}
          </button>
        )}
      </div>
      {legend && legend.length > 1 && <Legend items={legend} />}
      {asTable && table ? <DataTable table={table} caption={title} /> : children}
    </figure>
  );
}

export interface TooltipRow {
  label: string;
  value: string;
  color: string;
}

/** Hover / focus readout: the value leads, the series name follows, keyed by a short line. */
export function Tooltip({ x, title, rows, width }: { x: number; title: string; rows: TooltipRow[]; width: number }) {
  // Flip to the left of the pointer in the right half, so it never runs off the card.
  const right = x > width / 2;
  return (
    <div className="viz-tip" role="status" style={right ? { right: width - x + 8 } : { left: x + 8 }}>
      <div className="muted small">{title}</div>
      {rows.map((r) => (
        <div key={r.label} className="viz-tip-row">
          <span className="viz-key line" style={{ background: r.color }} aria-hidden />
          <strong>{r.value}</strong>
          <span className="muted small">{r.label}</span>
        </div>
      ))}
    </div>
  );
}

export function EmptyPlot({ height, text = "No data for this range." }: { height: number; text?: string }) {
  return (
    <div className="viz-empty muted small" style={{ height }}>
      {text}
    </div>
  );
}
