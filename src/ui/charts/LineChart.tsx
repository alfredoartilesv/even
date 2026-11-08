import { useState, type KeyboardEvent, type ReactNode, type PointerEvent } from "react";
import { ChartFrame, EmptyPlot, seriesColor, SINGLE, Tooltip, useWidth, type LegendItem } from "./frame";
import { compact, extent, fmtValue, labelIndexes, lastValueIndex, linear, linePath, nearestIndex, niceTicks, present, segments } from "./scale";

export interface LineSeries {
  id: string;
  label: string;
  /** One value per x, null where there is none (the line breaks there). */
  values: (number | null)[];
  /** Categorical slot 1-8. Defaults to the series' position; pass it to keep colors when series are filtered. */
  slot?: number;
  /** "dots": each value as a dot, no line (the real days of a sparse log). Default "line". */
  style?: "line" | "dots";
  /** A guide drawn under the others (a running average): not in the legend, the readout or the table. */
  guide?: boolean;
}

export interface LineChartProps {
  title: string;
  subtitle?: string;
  /** The x positions, in order (usually local days). */
  x: string[];
  series: LineSeries[];
  /** Short x label for the axis ("M", "12 Oct"). */
  formatX?: (x: string) => string;
  /** Long x label for the tooltip and table. Defaults to formatX. */
  formatXLong?: (x: string) => string;
  formatValue?: (v: number) => string;
  unit?: string;
  /** A goal drawn as a labelled line, e.g. a step target. */
  target?: number | null;
  /** Start the y axis at zero (amounts). Off for levels such as resting heart rate. */
  zero?: boolean;
  /** Draw each line straight across missing days instead of breaking it (sparse logs such as mood). */
  connectGaps?: boolean;
  height?: number;
  dim?: boolean;
  /** A button in the card's head beside Table (Today's pin). */
  action?: ReactNode;
  /** A fixed y range with a tick at every whole number, for a scale such as mood (1 to 5). */
  domain?: [number, number];
  /** Labels for the y ticks, when they are words rather than numbers ("Very good"). */
  formatTick?: (v: number) => string;
  /** Room for the y labels when they are words. */
  padLeft?: number;
}

const PAD = { top: 12, right: 12, bottom: 24, left: 40 };

/**
 * Trend over time, one or more series on one axis. Missing days break the line, unless connectGaps
 * joins the days either side. One series gets
 * a soft area wash and its last value labelled; several get a legend. Hover or arrow keys move a
 * crosshair that reads out every series at that x.
 */
export function LineChart({
  title,
  subtitle,
  x,
  series,
  formatX = (s) => s,
  formatXLong,
  formatValue = fmtValue,
  unit,
  target = null,
  zero = false,
  connectGaps = false,
  height = 180,
  dim,
  action,
  domain,
  formatTick = compact,
  padLeft = PAD.left,
}: LineChartProps) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const long = formatXLong ?? formatX;
  const single = series.length === 1;
  const color = (s: LineSeries, i: number) => (single ? SINGLE : seriesColor(s.slot ?? i + 1));
  const withUnit = (v: number) => `${formatValue(v)}${unit ? ` ${unit}` : ""}`;

  const ext = extent([...series.flatMap((s) => s.values), ...(target !== null ? [target] : []), ...(zero ? [0] : [])]);
  const shown = series.filter((s) => !s.guide);
  const legend: LegendItem[] = series.flatMap((s, i) => (s.guide ? [] : [{ label: s.label, slot: single ? null : (s.slot ?? i + 1), mark: "line" as const }]));
  const table = {
    columns: ["", ...shown.map((s) => s.label)],
    rows: x.map((xi, j) => [long(xi), ...shown.map((s) => (s.values[j] === null ? "–" : withUnit(s.values[j]!)))]),
  };

  if (!ext || !x.length) {
    return (
      <ChartFrame title={title} subtitle={subtitle} dim={dim} action={action}>
        <EmptyPlot height={height} />
      </ChartFrame>
    );
  }

  const ticks = domain ? Array.from({ length: domain[1] - domain[0] + 1 }, (_, k) => domain[0] + k) : niceTicks(ext[0], ext[1]);
  const left = padLeft;
  const plotW = Math.max(40, width - left - PAD.right);
  const plotH = height - PAD.top - PAD.bottom;
  const sx = (i: number) => (x.length === 1 ? left + plotW / 2 : left + (i / (x.length - 1)) * plotW);
  const sy = linear([ticks[0], ticks[ticks.length - 1]], [PAD.top + plotH, PAD.top]);
  const baseline = PAD.top + plotH;

  const move = (e: PointerEvent<SVGRectElement>) => {
    const box = e.currentTarget.ownerSVGElement!.getBoundingClientRect();
    setHover(nearestIndex(e.clientX - box.left, left, plotW, x.length));
  };
  const key = (e: KeyboardEvent) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const step = e.key === "ArrowLeft" ? -1 : 1;
    setHover((h) => Math.min(x.length - 1, Math.max(0, (h ?? (step < 0 ? x.length : -1)) + step)));
  };

  return (
    <ChartFrame title={title} subtitle={subtitle} legend={legend} table={table} dim={dim} action={action}>
      <div ref={ref} className="viz-plot">
        <svg
          width={width}
          height={height}
          role="img"
          aria-label={`${title}. ${single ? "" : `${series.length} series. `}Use the arrow keys to read values, or open the table.`}
          tabIndex={0}
          onKeyDown={key}
          onBlur={() => setHover(null)}
        >
          {ticks.map((t) => (
            <g key={t}>
              <line className="viz-grid" x1={left} x2={left + plotW} y1={sy(t)} y2={sy(t)} />
              <text className="viz-tick" x={left - 6} y={sy(t)} dy="0.32em" textAnchor="end">
                {formatTick(t)}
              </text>
            </g>
          ))}
          {labelIndexes(x.length, plotW).map((i) => (
            <text
              key={i}
              className="viz-tick"
              x={sx(i)}
              y={baseline + 16}
              textAnchor={i === 0 && x.length > 1 ? "start" : i === x.length - 1 && x.length > 1 ? "end" : "middle"}
            >
              {formatX(x[i])}
            </text>
          ))}
          {target !== null && (
            <g>
              <line className="viz-target" x1={left} x2={left + plotW} y1={sy(target)} y2={sy(target)} />
              {/* Left end: the right end carries the latest value's label. */}
              <text className="viz-tick halo" x={left + 2} y={sy(target) - 4}>
                target {formatValue(target)}
              </text>
            </g>
          )}
          {series.map((s, i) =>
            s.style === "dots" ? (
              <g key={s.id}>
                {s.values.map((v, j) => (v === null ? null : <circle key={j} className="viz-dot" cx={sx(j)} cy={sy(v)} r={4} style={{ fill: color(s, i) }} />))}
              </g>
            ) : (
              (connectGaps ? [present(s.values)] : segments(s.values).map((seg) => seg.values.map((v, k) => [seg.start + k, v] as [number, number])))
                .filter((seg) => seg.length > 0)
                .map((seg) => {
                  const pts = seg.map(([j, v]) => [sx(j), sy(v)] as [number, number]);
                  return (
                    <g key={`${s.id}-${seg[0][0]}`}>
                      {single && pts.length > 1 && (
                        <path className="viz-area" d={`${linePath(pts)} V${baseline} H${pts[0][0]} Z`} style={{ fill: color(s, i) }} />
                      )}
                      {pts.length > 1 && <path className={s.guide ? "viz-line guide" : "viz-line"} d={linePath(pts)} style={{ stroke: color(s, i) }} />}
                      {pts.length === 1 && (
                        // A lone day between gaps has no line to sit on: show it as a dot.
                        <circle className="viz-dot" cx={pts[0][0]} cy={pts[0][1]} r={4} style={{ fill: color(s, i) }} />
                      )}
                    </g>
                  );
                })
            ),
          )}
          {single &&
            (() => {
              const s = series[0];
              const last = lastValueIndex(s.values);
              if (last < 0 || hover !== null) return null;
              const v = s.values[last]!;
              return (
                <g>
                  <circle className="viz-dot" cx={sx(last)} cy={sy(v)} r={4} style={{ fill: SINGLE }} />
                  <text className="viz-label" x={sx(last)} y={sy(v) - 10} textAnchor={last > x.length / 2 ? "end" : "start"}>
                    {formatValue(v)}
                  </text>
                </g>
              );
            })()}
          {hover !== null && (
            <g>
              <line className="viz-crosshair" x1={sx(hover)} x2={sx(hover)} y1={PAD.top} y2={baseline} />
              {series.map((s, i) =>
                s.guide || s.values[hover] === null ? null : (
                  <circle key={s.id} className="viz-dot" cx={sx(hover)} cy={sy(s.values[hover]!)} r={4} style={{ fill: color(s, i) }} />
                ),
              )}
            </g>
          )}
          <rect className="viz-hit" x={left} y={PAD.top} width={plotW} height={plotH} onPointerMove={move} onPointerLeave={() => setHover(null)} />
        </svg>
        {hover !== null && (
          <Tooltip
            x={sx(hover)}
            width={width}
            title={long(x[hover])}
            rows={series.flatMap((s, i) =>
              s.guide ? [] : [{ label: s.label, value: s.values[hover] === null ? "–" : withUnit(s.values[hover]!), color: color(s, i) }],
            )}
          />
        )}
      </div>
    </ChartFrame>
  );
}
