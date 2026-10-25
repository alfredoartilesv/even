import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import type { SqlDriver } from "../db/driver";
import { dailySeries, type MetricSeries } from "../db/queries";
import type { DataClass } from "./consent";

type BetaTool = Anthropic.Beta.Messages.BetaTool;

/**
 * Tools Claude can call. They run locally as SQL against the phone's database; only their
 * results leave the phone. Each tool declares the class of data it returns, which decides
 * the consent it needs and how it is logged in ai_disclosures.
 */
export interface ChatTool {
  definition: BetaTool;
  dataClass: DataClass;
  run(db: SqlDriver, input: unknown): Promise<ToolOutput>;
}

export interface ToolOutput {
  /** Sent to Claude as the tool_result (JSON). */
  result: unknown;
  /** One line for the "what was sent" panel. */
  summary: string;
}

const MAX_SERIES_DAYS = 400;
const MAX_RANGE_DAYS = 3660;

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "dates are YYYY-MM-DD");
const range = z
  .object({ from: day, to: day })
  .refine((r) => r.from <= r.to, "from must not be after to")
  .refine((r) => daysBetween(r.from, r.to) <= MAX_RANGE_DAYS, `ranges are limited to ${MAX_RANGE_DAYS} days`);

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;
}

const round = (n: number | null | undefined) => (n == null || !Number.isFinite(n) ? null : Math.round(n * 100) / 100);

const DATE_DESC = "Local calendar day, YYYY-MM-DD";

function schema(properties: Record<string, unknown>): BetaTool["input_schema"] {
  return { type: "object", properties, required: Object.keys(properties), additionalProperties: false };
}

function tool(name: string, description: string, properties: Record<string, unknown>): BetaTool {
  return { name, description, input_schema: schema(properties), strict: true };
}

/** Summary statistics of one series: what "aggregate" means in this app. */
export function summarise(s: MetricSeries) {
  const values = s.points.map((p) => p.value);
  const n = values.length;
  const first = s.points[0];
  const last = s.points[n - 1];
  return {
    source: s.source,
    device: s.device,
    unit: s.unit,
    daily_agg: s.dailyAgg,
    days_with_data: n,
    avg: round(n ? values.reduce((a, b) => a + b, 0) / n : null),
    min: round(n ? Math.min(...values) : null),
    max: round(n ? Math.max(...values) : null),
    first: first ? { day: first.day, value: round(first.value) } : null,
    last: last ? { day: last.day, value: round(last.value), day_not_over: last.partial } : null,
    trend_per_week: round(slopePerDay(s.points) * 7),
  };
}

/** Least-squares slope of value over days, in units per day (0 with fewer than 2 points). */
function slopePerDay(points: { day: string; value: number }[]): number {
  if (points.length < 2) return 0;
  const xs = points.map((p) => Date.parse(`${p.day}T00:00:00Z`) / 86_400_000);
  const mx = xs.reduce((a, b) => a + b, 0) / xs.length;
  const my = points.reduce((a, p) => a + p.value, 0) / points.length;
  let num = 0;
  let den = 0;
  points.forEach((p, i) => {
    num += (xs[i] - mx) * (p.value - my);
    den += (xs[i] - mx) ** 2;
  });
  return den === 0 ? 0 : num / den;
}

const listMetrics: ChatTool = {
  dataClass: "aggregate",
  definition: tool(
    "list_metrics",
    "List what health data exists on this phone: synced metrics (name, label, category, unit, how a day is aggregated, first and last day, days with data), manual measurement kinds, and how many days have food or drink logs. Call this first to learn the exact metric names.",
    {},
  ),
  async run(db) {
    const metrics = await db.all<Record<string, string | number | null>>(
      `SELECT h.source, h.metric, c.label, COALESCE(c.category, 'other') AS category, MAX(h.unit) AS unit,
              COALESCE(c.daily_agg, 'avg') AS daily_agg, MIN(h.local_day) AS first_day, MAX(h.local_day) AS last_day,
              COUNT(DISTINCT h.local_day) AS days, SUM(CASE WHEN h.value_num IS NULL THEN 1 ELSE 0 END) AS text_values
       FROM health_samples h
       LEFT JOIN metric_catalog c ON c.source = h.source AND c.metric = h.metric
       GROUP BY h.source, h.metric
       ORDER BY category, h.metric`,
    );
    const manual = await db.all<Record<string, string | number | null>>(
      `SELECT kind, MAX(unit) AS unit, COUNT(*) AS entries, MIN(local_day) AS first_day, MAX(local_day) AS last_day
       FROM manual_measurements WHERE deleted_at IS NULL GROUP BY kind ORDER BY kind`,
    );
    const [food] = await db.all<{ days: number }>("SELECT COUNT(*) AS days FROM daily_nutrition");
    const [drink] = await db.all<{ days: number }>("SELECT COUNT(*) AS days FROM daily_alcohol");
    return {
      result: { metrics, manual_kinds: manual, food_log_days: food.days, drink_log_days: drink.days },
      summary: `Metric list (${metrics.length} metrics, ${manual.length} manual kinds)`,
    };
  },
};

const metricSummary: ChatTool = {
  dataClass: "aggregate",
  definition: tool(
    "metric_summary",
    "Summary of one synced metric over a date range: days with data, average, min, max, first and last value, and linear trend per week. One entry per source/device. A day's value follows the metric's daily_agg (from list_metrics).",
    {
      metric: { type: "string", description: "Exact metric name from list_metrics" },
      from: { type: "string", description: DATE_DESC },
      to: { type: "string", description: DATE_DESC },
    },
  ),
  async run(db, input) {
    const p = range.and(z.object({ metric: z.string().min(1) })).parse(input);
    const series = await dailySeries(db, p.metric, p.from, p.to);
    return {
      result: { metric: p.metric, from: p.from, to: p.to, label: series[0]?.label ?? p.metric, series: series.map(summarise) },
      summary: `Summary of ${p.metric}, ${p.from} to ${p.to}`,
    };
  },
};

const comparePeriods: ChatTool = {
  dataClass: "aggregate",
  definition: tool(
    "compare_periods",
    "Compare one synced metric between two date ranges (for example this week vs last week): the summary of each and the difference of the averages.",
    {
      metric: { type: "string", description: "Exact metric name from list_metrics" },
      a_from: { type: "string", description: `Period A start. ${DATE_DESC}` },
      a_to: { type: "string", description: `Period A end. ${DATE_DESC}` },
      b_from: { type: "string", description: `Period B start. ${DATE_DESC}` },
      b_to: { type: "string", description: `Period B end. ${DATE_DESC}` },
    },
  ),
  async run(db, input) {
    const p = z.object({ metric: z.string().min(1), a_from: day, a_to: day, b_from: day, b_to: day }).parse(input);
    range.parse({ from: p.a_from, to: p.a_to });
    range.parse({ from: p.b_from, to: p.b_to });
    const a = (await dailySeries(db, p.metric, p.a_from, p.a_to)).map(summarise);
    const b = (await dailySeries(db, p.metric, p.b_from, p.b_to)).map(summarise);
    const devices = [...new Set([...a, ...b].map((s) => `${s.source}|${s.device}`))];
    const comparison = devices.map((key) => {
      const sa = a.find((s) => `${s.source}|${s.device}` === key) ?? null;
      const sb = b.find((s) => `${s.source}|${s.device}` === key) ?? null;
      const diff = sa?.avg != null && sb?.avg != null ? round(sb.avg - sa.avg) : null;
      const pct = sa?.avg && diff != null ? round((diff / sa.avg) * 100) : null;
      return { device: (sa ?? sb)!.device, period_a: sa, period_b: sb, avg_change_b_minus_a: diff, avg_change_percent: pct };
    });
    return {
      result: { metric: p.metric, period_a: { from: p.a_from, to: p.a_to }, period_b: { from: p.b_from, to: p.b_to }, comparison },
      summary: `Comparison of ${p.metric}: ${p.a_from}..${p.a_to} vs ${p.b_from}..${p.b_to}`,
    };
  },
};

const nutritionSummary: ChatTool = {
  dataClass: "aggregate",
  definition: tool(
    "nutrition_summary",
    "Summary of the food and alcohol logs over a date range: days logged, average calories and macros per logged day, alcohol grams in total, per drinking day and per calendar day, and drinking days.",
    { from: { type: "string", description: DATE_DESC }, to: { type: "string", description: DATE_DESC } },
  ),
  async run(db, input) {
    const p = range.parse(input);
    const [food] = await db.all<Record<string, number | null>>(
      `SELECT COUNT(*) AS days_logged, AVG(calories) AS avg_calories, AVG(protein_g) AS avg_protein_g,
              AVG(carbs_g) AS avg_carbs_g, AVG(fat_g) AS avg_fat_g, SUM(entries) AS entries
       FROM daily_nutrition WHERE local_day BETWEEN ? AND ?`,
      [p.from, p.to],
    );
    const [drink] = await db.all<Record<string, number | null>>(
      `SELECT COUNT(*) AS drinking_days, SUM(drinks) AS drinks, SUM(alcohol_g) AS alcohol_g_total,
              AVG(alcohol_g) AS alcohol_g_per_drinking_day
       FROM daily_alcohol WHERE local_day BETWEEN ? AND ?`,
      [p.from, p.to],
    );
    const days = daysBetween(p.from, p.to);
    const roundAll = (o: Record<string, number | null>) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, round(v)]));
    return {
      result: {
        from: p.from,
        to: p.to,
        calendar_days: days,
        food: roundAll(food),
        alcohol: { ...roundAll(drink), alcohol_g_per_calendar_day: round((drink.alcohol_g_total ?? 0) / days) },
      },
      summary: `Food and alcohol summary, ${p.from} to ${p.to}`,
    };
  },
};

const manualSummary: ChatTool = {
  dataClass: "aggregate",
  definition: tool(
    "manual_summary",
    "Summary of one kind of manual measurement (kinds come from list_metrics, e.g. blood_pressure, weight, glucose) over a date range: count, average, min, max of the value (and of the second value, e.g. diastolic), first and last day.",
    {
      kind: { type: "string", description: "Manual measurement kind from list_metrics" },
      from: { type: "string", description: DATE_DESC },
      to: { type: "string", description: DATE_DESC },
    },
  ),
  async run(db, input) {
    const p = range.and(z.object({ kind: z.string().min(1) })).parse(input);
    const [r] = await db.all<Record<string, number | string | null>>(
      `SELECT COUNT(*) AS entries, MAX(unit) AS unit, AVG(value_num) AS avg, MIN(value_num) AS min, MAX(value_num) AS max,
              AVG(value_num2) AS avg2, MIN(value_num2) AS min2, MAX(value_num2) AS max2,
              MIN(local_day) AS first_day, MAX(local_day) AS last_day
       FROM manual_measurements WHERE kind = ? AND deleted_at IS NULL AND local_day BETWEEN ? AND ?`,
      [p.kind, p.from, p.to],
    );
    const result = Object.fromEntries(Object.entries(r).map(([k, v]) => [k, typeof v === "number" ? round(v) : v]));
    return { result: { kind: p.kind, from: p.from, to: p.to, ...result }, summary: `Summary of manual ${p.kind}, ${p.from} to ${p.to}` };
  },
};

const listGoals: ChatTool = {
  dataClass: "aggregate",
  definition: tool(
    "list_goals",
    "List the user's active goals: title, what is measured (target_kind and metric), comparator, target, unit, period and dates.",
    {},
  ),
  async run(db) {
    const goals = await db.all(
      `SELECT title, target_kind, metric, comparator, target_num, unit, period, start_day, end_day
       FROM goals WHERE deleted_at IS NULL ORDER BY start_day`,
    );
    return { result: { goals }, summary: `Goal list (${goals.length})` };
  },
};

const dailySeriesTool: ChatTool = {
  dataClass: "raw",
  definition: tool(
    "daily_series",
    `Day-by-day values of one synced metric over a date range (at most ${MAX_SERIES_DAYS} days). Sends raw data, which the user must allow separately, so prefer metric_summary or compare_periods when a summary answers the question.`,
    {
      metric: { type: "string", description: "Exact metric name from list_metrics" },
      from: { type: "string", description: DATE_DESC },
      to: { type: "string", description: DATE_DESC },
    },
  ),
  async run(db, input) {
    const p = range.and(z.object({ metric: z.string().min(1) })).parse(input);
    if (daysBetween(p.from, p.to) > MAX_SERIES_DAYS) throw new Error(`daily_series is limited to ${MAX_SERIES_DAYS} days`);
    const series = await dailySeries(db, p.metric, p.from, p.to);
    return {
      result: {
        metric: p.metric,
        series: series.map((s) => ({
          source: s.source,
          device: s.device,
          unit: s.unit,
          daily_agg: s.dailyAgg,
          points: s.points.map((pt) => (pt.partial ? { day: pt.day, value: round(pt.value), day_not_over: true } : { day: pt.day, value: round(pt.value) })),
        })),
      },
      summary: `Daily values of ${p.metric}, ${p.from} to ${p.to}`,
    };
  },
};

const dayNotes: ChatTool = {
  dataClass: "note",
  definition: tool(
    "day_notes",
    "The user's daily check-ins over a date range (at most 92 days): mood and energy (1 to 5) and the note they wrote. Sends personal text, which the user must allow separately.",
    { from: { type: "string", description: DATE_DESC }, to: { type: "string", description: DATE_DESC } },
  ),
  async run(db, input) {
    const p = range.parse(input);
    if (daysBetween(p.from, p.to) > 92) throw new Error("day_notes is limited to 92 days");
    const notes = await db.all(
      `SELECT local_day AS day, mood, energy, body AS note FROM day_notes
       WHERE deleted_at IS NULL AND local_day BETWEEN ? AND ? ORDER BY local_day`,
      [p.from, p.to],
    );
    return { result: { from: p.from, to: p.to, notes }, summary: `Day notes, ${p.from} to ${p.to} (${notes.length})` };
  },
};

/** Fixed order: the tool list is part of the cached prompt prefix, so it must not change between requests. */
export const CHAT_TOOLS: ChatTool[] = [
  listMetrics,
  metricSummary,
  comparePeriods,
  nutritionSummary,
  manualSummary,
  listGoals,
  dailySeriesTool,
  dayNotes,
];

export const TOOLS_BY_NAME = new Map(CHAT_TOOLS.map((t) => [t.definition.name, t]));
