/**
 * Pure helpers behind the charts: scales, axis ticks, number formats. No React, so they are
 * tested in Node like the rest of the logic.
 */

/** Map a domain onto a range, linearly. A zero-width domain maps everything to the range middle. */
export function linear([d0, d1]: [number, number], [r0, r1]: [number, number]): (v: number) => number {
  if (d1 === d0) return () => (r0 + r1) / 2;
  const k = (r1 - r0) / (d1 - d0);
  return (v) => r0 + (v - d0) * k;
}

/** Smallest and largest finite value, or null when there is none. */
export function extent(values: Iterable<number | null | undefined>): [number, number] | null {
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of values) {
    if (typeof v !== "number" || !Number.isFinite(v)) continue;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  return lo === Infinity ? null : [lo, hi];
}

/** 1, 2 or 5 times a power of ten, the smallest such step that gives at most `count` intervals. */
function niceStep(span: number, count: number): number {
  const raw = span / Math.max(1, count);
  const pow = 10 ** Math.floor(Math.log10(raw));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * pow >= raw) return m * pow;
  return 10 * pow;
}

/**
 * Round axis ticks that cover [min, max]: about `count` intervals on a 1/2/2.5/5 step.
 * A flat series still gets an axis (one step either side of the value).
 */
export function niceTicks(min: number, max: number, count = 4): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [0, 1];
  if (min > max) [min, max] = [max, min];
  if (min === max) {
    const pad = min === 0 ? 1 : niceStep(Math.abs(min), 4);
    min -= pad;
    max += pad;
  }
  const step = niceStep(max - min, count);
  const start = Math.floor(min / step + 1e-9) * step;
  const end = Math.ceil(max / step - 1e-9) * step;
  const ticks: number[] = [];
  // Rounded to the step's precision, so 0.1 + 0.2 never shows as 0.30000000000000004.
  const digits = Math.max(0, -Math.floor(Math.log10(step)) + 1);
  for (let v = start; v <= end + step / 2; v += step) ticks.push(Number(v.toFixed(digits)));
  return ticks;
}

/** Axis and tile numbers: 950, 1,284 -> "1.3K", 12,900 -> "12.9K", 4,200,000 -> "4.2M". Small values keep one decimal. */
export function compact(n: number): string {
  const a = Math.abs(n);
  if (a >= 1e6) return `${trim(n / 1e6)}M`;
  if (a >= 1e3) return `${trim(n / 1e3)}K`;
  return Number.isInteger(n) ? String(n) : n.toFixed(1).replace(/\.0$/, "");
}
const trim = (v: number) => (Math.abs(v) >= 100 ? Math.round(v).toString() : v.toFixed(1).replace(/\.0$/, ""));

/** A value for reading (tooltip, table): grouped thousands, at most one decimal. */
export function fmtValue(n: number): string {
  return n.toLocaleString(undefined, { maximumFractionDigits: Number.isInteger(n) ? 0 : 1 });
}

/**
 * Which x labels to print so they never collide: always the first and last, and evenly spaced
 * ones in between, at most one per `minGap` pixels.
 */
export function labelIndexes(count: number, plotWidth: number, minGap = 48): number[] {
  if (count <= 0) return [];
  if (count === 1) return [0];
  const fit = Math.max(2, Math.floor(plotWidth / minGap) + 1);
  if (count <= fit) return Array.from({ length: count }, (_, i) => i);
  const every = Math.ceil((count - 1) / (fit - 1));
  const out: number[] = [];
  for (let i = 0; i < count - 1; i += every) out.push(i);
  // Drop the last regular label if it would sit closer than minGap to the final one.
  const px = plotWidth / (count - 1);
  if (out.length > 1 && (count - 1 - out[out.length - 1]) * px < minGap) out.pop();
  out.push(count - 1);
  return out;
}

/** Index of the slot nearest to pixel x, for a band of `count` equal slots starting at `left`. */
export function nearestIndex(x: number, left: number, width: number, count: number): number {
  if (count <= 1) return 0;
  const i = Math.round(((x - left) / width) * (count - 1));
  return Math.min(count - 1, Math.max(0, i));
}

/** Runs of consecutive non-null values, so a line breaks at missing days instead of bridging them. */
/** The points that have a value, as [index, value], for a line drawn straight across the gaps. */
export function present(values: (number | null)[]): [number, number][] {
  return values.flatMap((v, i) => (v === null || !Number.isFinite(v) ? [] : [[i, v] as [number, number]]));
}

export function segments(values: (number | null)[]): { start: number; values: number[] }[] {
  const out: { start: number; values: number[] }[] = [];
  let cur: { start: number; values: number[] } | null = null;
  values.forEach((v, i) => {
    if (v === null || !Number.isFinite(v)) {
      cur = null;
      return;
    }
    if (!cur) {
      cur = { start: i, values: [] };
      out.push(cur);
    }
    cur.values.push(v);
  });
  return out;
}

/** Index of the last non-null value, or -1. */
export function lastValueIndex(values: (number | null)[]): number {
  for (let i = values.length - 1; i >= 0; i--) if (values[i] !== null) return i;
  return -1;
}

/** "M x y L x y ..." through the points. */
export function linePath(points: [number, number][]): string {
  return points.map(([x, y], i) => `${i ? "L" : "M"}${round(x)} ${round(y)}`).join(" ");
}

/** A column from the baseline up to `top`: square at the baseline, 4px rounded data end. */
export function columnPath(x: number, width: number, top: number, baseline: number, radius = 4): string {
  const h = baseline - top;
  if (h <= 0) return "";
  const r = Math.min(radius, width / 2, h);
  return [
    `M${round(x)} ${round(baseline)}`,
    `V${round(top + r)}`,
    `Q${round(x)} ${round(top)} ${round(x + r)} ${round(top)}`,
    `H${round(x + width - r)}`,
    `Q${round(x + width)} ${round(top)} ${round(x + width)} ${round(top + r)}`,
    `V${round(baseline)}`,
    "Z",
  ].join(" ");
}

const round = (v: number) => Math.round(v * 10) / 10;
