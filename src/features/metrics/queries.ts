import type { DailyAgg, MetricCategory } from "./catalog";
import type { SqlDriver } from "../../db/driver";

export interface DayValue {
  metric: string;
  label: string;
  category: MetricCategory;
  device: string;
  /** The day's number, aggregated the way metric_catalog.daily_agg says. */
  value: number;
  unit: string | null;
  readings: number;
  partial: boolean;
}

interface Aggregates {
  avg_num: number;
  sum_num: number;
  min_num: number;
  max_num: number;
  last_num: number;
}

/** The one number a day stands for, per metric_catalog.daily_agg (avg when unset). */
function pickDaily(r: Aggregates, agg: DailyAgg | null): number {
  return { avg: r.avg_num, sum: r.sum_num, min: r.min_num, max: r.max_num, last: r.last_num }[agg ?? "avg"];
}

export interface SeriesPoint {
  day: string;
  value: number;
  partial: boolean;
}

export interface MetricSeries {
  source: string;
  metric: string;
  label: string;
  device: string;
  unit: string | null;
  dailyAgg: DailyAgg;
  points: SeriesPoint[];
}

/** One value per day for a metric between two local days (inclusive), one series per source/device. */
export async function dailySeries(db: SqlDriver, metric: string, from: string, to: string): Promise<MetricSeries[]> {
  const rows = await db.all<
    Aggregates & {
      source: string;
      device: string;
      local_day: string;
      unit: string | null;
      partial: number;
      label: string | null;
      daily_agg: DailyAgg | null;
    }
  >(
    `SELECT d.source, d.device, d.local_day, d.avg_num, d.sum_num, d.min_num, d.max_num, d.last_num,
            COALESCE(d.unit, c.unit) AS unit, d.partial, c.label, c.daily_agg
     FROM daily_metric_values d
     LEFT JOIN metric_catalog c ON c.source = d.source AND c.metric = d.metric
     WHERE d.metric = ? AND d.local_day BETWEEN ? AND ?
     ORDER BY d.source, d.device, d.local_day`,
    [metric, from, to],
  );
  const bySeries = new Map<string, MetricSeries>();
  for (const r of rows) {
    const key = `${r.source}|${r.device}`;
    let s = bySeries.get(key);
    if (!s) {
      s = {
        source: r.source,
        metric,
        label: r.label ?? metric,
        device: r.device,
        unit: r.unit,
        dailyAgg: r.daily_agg ?? "avg",
        points: [],
      };
      bySeries.set(key, s);
    }
    s.points.push({ day: r.local_day, value: pickDaily(r, r.daily_agg), partial: r.partial === 1 });
  }
  return [...bySeries.values()];
}

/** Most recent local day that has any sample, or null on an empty database. */
export async function latestSampleDay(db: SqlDriver): Promise<string | null> {
  const rows = await db.all<{ d: string | null }>("SELECT MAX(local_day) AS d FROM health_samples");
  return rows[0]?.d ?? null;
}

export async function dayValues(db: SqlDriver, day: string): Promise<DayValue[]> {
  const rows = await db.all<{
    metric: string;
    label: string | null;
    category: MetricCategory | null;
    daily_agg: DailyAgg | null;
    device: string;
    avg_num: number;
    sum_num: number;
    min_num: number;
    max_num: number;
    last_num: number;
    unit: string | null;
    readings: number;
    partial: number;
    pinned: number | null;
  }>(
    `SELECT d.metric, c.label, c.category, c.daily_agg, d.device, d.avg_num, d.sum_num, d.min_num, d.max_num,
            d.last_num, d.unit, d.readings, d.partial, c.pinned
     FROM daily_metric_values d
     LEFT JOIN metric_catalog c ON c.source = d.source AND c.metric = d.metric
     WHERE d.local_day = ?
     ORDER BY COALESCE(c.pinned, 0) DESC, COALESCE(c.sort_order, 1e9), COALESCE(c.category, 'other'), d.metric`,
    [day],
  );
  return rows.map((r) => {
    const value = pickDaily(r, r.daily_agg);
    return {
      metric: r.metric,
      label: r.label ?? r.metric,
      category: r.category ?? "other",
      device: r.device,
      value,
      unit: r.unit,
      readings: r.readings,
      partial: r.partial === 1,
    };
  });
}

/**
 * One number per day for a synced metric, picked as metric_catalog.daily_agg says. Several
 * devices on one day: the one with most readings. summed: the metric is an amount (steps, kcal).
 */
export async function metricDays(db: SqlDriver, metric: string, from: string, to: string): Promise<{ values: Map<string, number>; summed: boolean }> {
  return (await metricsDays(db, [metric], from, to)).get(metric)!;
}

/** metricDays for several metrics in one query: the Dashboard reads three at start-up, and each query is a call to the native plugin. */
export async function metricsDays(
  db: SqlDriver,
  metrics: string[],
  from: string,
  to: string,
): Promise<Map<string, { values: Map<string, number>; summed: boolean }>> {
  const rows = await db.all<{ metric: string; day: string; v: number; agg: string | null; readings: number }>(
    `SELECT d.metric, d.local_day AS day, d.readings,
            CASE COALESCE(c.daily_agg, 'avg') WHEN 'sum' THEN d.sum_num WHEN 'min' THEN d.min_num WHEN 'max' THEN d.max_num
                 WHEN 'last' THEN d.last_num ELSE d.avg_num END AS v, c.daily_agg AS agg
     FROM daily_metric_values d LEFT JOIN metric_catalog c ON c.source = d.source AND c.metric = d.metric
     WHERE d.metric IN (${metrics.map(() => "?").join(", ")}) AND d.local_day BETWEEN ? AND ?
     ORDER BY d.metric, d.local_day, d.readings DESC`,
    [...metrics, from, to],
  );
  const out = new Map(metrics.map((m) => [m, { values: new Map<string, number>(), summed: false }]));
  for (const r of rows) {
    const m = out.get(r.metric)!;
    // The row with the most readings wins a day (rows are sorted that way).
    if (!m.values.has(r.day)) m.values.set(r.day, r.v);
    if (r.agg === "sum") m.summed = true;
  }
  return out;
}
