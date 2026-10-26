import { useState } from "react";
import { addDays } from "../../core/tz";
import { ChartFrame, EmptyPlot, Tooltip, useWidth } from "./frame";
import { extent, fmtValue } from "./scale";

export interface CalendarHeatmapProps {
  title: string;
  subtitle?: string;
  /** Value per local day ("2026-10-24"). Days not in the map are drawn empty. */
  values: Record<string, number>;
  /** First and last day shown (inclusive). */
  from: string;
  to: string;
  formatValue?: (v: number) => string;
  unit?: string;
  formatDay?: (day: string) => string;
}

/** Five steps of one hue, light to dark (sequential: more is darker). */
const BINS = 5;
const GAP = 2;
const DAY_LABEL_W = 14;

/** Monday-based weekday, 0 = Monday. */
const weekday = (day: string) => (new Date(`${day}T12:00:00Z`).getUTCDay() + 6) % 7;

/**
 * Days as a grid of weeks (columns) by weekday (rows), each cell shaded by its value in five
 * steps of the accent. For consistency over months: did I sleep enough, walk every day. Missing
 * days stay empty, never zero. A scale legend shows the step bounds.
 */
export function CalendarHeatmap({ title, subtitle, values, from, to, formatValue = fmtValue, unit, formatDay = (d) => d }: CalendarHeatmapProps) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<string | null>(null);
  const withUnit = (v: number) => `${formatValue(v)}${unit ? ` ${unit}` : ""}`;

  const days: string[] = [];
  for (let d = from; d <= to && days.length < 800; d = addDays(d, 1)) days.push(d);
  const ext = extent(days.map((d) => values[d]));
  const table = { columns: ["", title], rows: days.filter((d) => d in values).map((d) => [formatDay(d), withUnit(values[d])]) };
  if (!ext) {
    return (
      <ChartFrame title={title} subtitle={subtitle}>
        <EmptyPlot height={120} />
      </ChartFrame>
    );
  }

  const lead = weekday(from);
  const weeks = Math.ceil((lead + days.length) / 7);
  const cell = Math.max(6, Math.min(16, Math.floor((width - DAY_LABEL_W) / weeks) - GAP));
  const step = cell + GAP;
  const bin = (v: number) => (ext[1] === ext[0] ? BINS - 1 : Math.min(BINS - 1, Math.floor(((v - ext[0]) / (ext[1] - ext[0])) * BINS)));
  const bounds = Array.from({ length: BINS }, (_, i) => ext[0] + ((ext[1] - ext[0]) * i) / BINS);
  const pos = (i: number) => ({ col: Math.floor((lead + i) / 7), row: (lead + i) % 7 });
  const height = 7 * step;
  const hovered = hover ? days.indexOf(hover) : -1;

  return (
    <ChartFrame title={title} subtitle={subtitle} table={table}>
      <div ref={ref} className="viz-plot viz-heat">
        <svg width={DAY_LABEL_W + weeks * step} height={height} role="img" aria-label={`${title}, ${formatDay(from)} to ${formatDay(to)}. Open the table for every value.`}>
          {["M", "W", "F"].map((l, k) => (
            <text key={l} className="viz-tick" x={0} y={k * 2 * step + cell / 2} dy="0.32em">
              {l}
            </text>
          ))}
          {days.map((d, i) => {
            const { col, row } = pos(i);
            const v = values[d];
            return (
              <rect
                key={d}
                className={v === undefined ? "viz-cell empty" : `viz-cell b${bin(v)}`}
                x={DAY_LABEL_W + col * step}
                y={row * step}
                width={cell}
                height={cell}
                rx={2}
                onPointerEnter={() => setHover(d)}
                onPointerLeave={() => setHover(null)}
              />
            );
          })}
          {hovered >= 0 && (
            <rect className="viz-cell-ring" x={DAY_LABEL_W + pos(hovered).col * step - 1} y={pos(hovered).row * step - 1} width={cell + 2} height={cell + 2} rx={3} />
          )}
        </svg>
        {hover && (
          <Tooltip
            x={DAY_LABEL_W + pos(hovered).col * step + cell / 2}
            width={width}
            title={formatDay(hover)}
            rows={[{ label: title, value: hover in values ? withUnit(values[hover]) : "no data", color: "var(--accent)" }]}
          />
        )}
      </div>
      <div className="viz-scale small muted" aria-hidden>
        <span>{formatValue(ext[0])}</span>
        {bounds.map((b, i) => (
          <span key={i} className={`viz-cell-key b${i}`} title={`from ${formatValue(b)}`} />
        ))}
        <span>{withUnit(ext[1])}</span>
      </div>
    </ChartFrame>
  );
}
