import { addDays } from "../../core/tz";
import type { SqlDriver } from "../../db/driver";
import { drinkKcalByDay } from "../alcohol/alcohol";
import { getCalorieGoal, nutritionRange } from "../food/food";
import { loadStock } from "../mealprep/mealPrep";
import { listWorkouts } from "../me/workouts";
import { metricDays } from "../metrics/queries";

/**
 * The Dashboard's numbers for a day, a week (Monday start) or a calendar month: one row per day,
 * then for each figure the total and the daily average. Averages divide by the days that have
 * data, so a week with two days synced is not pulled down by five empty ones. Days after today
 * are left out of the current week or month.
 */

export type Span = "day" | "week" | "month";

/** Synced daily metrics the dashboard reads (the Garmin sync and the Garmin export import use the same names). */
export const DASH_METRICS = {
  steps: "daily_steps",
  /** Everything burned: resting (BMR) plus active. */
  burned: "daily_totalKilocalories",
  active: "daily_activeKilocalories",
} as const;

export interface DashDay {
  day: string;
  steps: number | null;
  burnedKcal: number | null;
  activeKcal: number | null;
  /** Food plus drinks; null when neither was logged. */
  eatenKcal: number | null;
  drinkKcal: number | null;
  proteinG: number | null;
  /** Meal prep portions eaten; null when none. */
  prepPortions: number | null;
  workouts: number;
  workoutS: number;
}

export interface Figure {
  total: number | null;
  /** Total over days with data. */
  avg: number | null;
  daysWithData: number;
}

export interface Dashboard {
  span: Span;
  from: string;
  /** Last day of the span, clipped to today. Before from when the span is in the future. */
  to: string;
  days: DashDay[];
  steps: Figure;
  burned: Figure;
  active: Figure;
  eaten: Figure;
  drinks: Figure;
  protein: Figure;
  /** Eaten minus burned, over the days that have both. */
  balance: Figure;
  prep: Figure;
  workouts: { count: number; durationS: number };
  /** Meal prep portions in the fridge and freezer now (not per span). */
  stock: { portions: number; batches: number };
  /** The live daily targets: calories (at most) and steps (at least); null when none is set. */
  targets: { kcal: number | null; steps: number | null };
}

/** Monday of the week, first of the month, or the day itself. */
export function spanStart(span: Span, day: string): string {
  if (span === "day") return day;
  if (span === "month") return `${day.slice(0, 8)}01`;
  const dow = (new Date(`${day}T12:00:00Z`).getUTCDay() + 6) % 7;
  return addDays(day, -dow);
}

/** First and last day of the span that holds anchor. */
export function spanRange(span: Span, anchor: string): { from: string; to: string } {
  const from = spanStart(span, anchor);
  if (span === "day") return { from, to: from };
  if (span === "week") return { from, to: addDays(from, 6) };
  const [y, m] = from.split("-").map(Number);
  return { from, to: new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10) };
}

/** The anchor of the previous (-1) or next (+1) span. */
export function shiftSpan(span: Span, anchor: string, dir: 1 | -1): string {
  const { from, to } = spanRange(span, anchor);
  return dir === 1 ? addDays(to, 1) : spanStart(span, addDays(from, -1));
}

/** Total and per-day average of the non-null values. */
export function figure(values: (number | null)[]): Figure {
  const have = values.filter((v): v is number => v !== null);
  const total = have.length ? have.reduce((a, b) => a + b, 0) : null;
  return { total, avg: total === null ? null : total / have.length, daysWithData: have.length };
}

export async function loadDashboard(db: SqlDriver, span: Span, anchor: string, today: string): Promise<Dashboard> {
  const range = spanRange(span, anchor);
  const from = range.from;
  const to = range.to > today ? today : range.to;
  const [steps, burned, active, food, drinks, prep, workouts, stock, kcalGoal, stepGoal] = await Promise.all([
    metricDays(db, DASH_METRICS.steps, from, to),
    metricDays(db, DASH_METRICS.burned, from, to),
    metricDays(db, DASH_METRICS.active, from, to),
    from <= to ? nutritionRange(db, from, to) : Promise.resolve([]),
    drinkKcalByDay(db, from, to),
    prepPortionsByDay(db, from, to),
    listWorkouts(db, from, to),
    loadStock(db),
    getCalorieGoal(db),
    dailyStepGoal(db, today),
  ]);
  const foodBy = new Map(food.map((f) => [f.day, f]));

  const days: DashDay[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) {
    const f = foodBy.get(d);
    const foodKcal = f && f.entries > 0 ? (f.calories ?? 0) : null;
    const drinkKcal = drinks.get(d) ?? null;
    const ws = workouts.filter((w) => w.day === d);
    days.push({
      day: d,
      steps: steps.values.get(d) ?? null,
      burnedKcal: burned.values.get(d) ?? null,
      activeKcal: active.values.get(d) ?? null,
      eatenKcal: foodKcal === null && drinkKcal === null ? null : (foodKcal ?? 0) + (drinkKcal ?? 0),
      drinkKcal,
      proteinG: f && f.entries > 0 ? f.proteinG : null,
      prepPortions: prep.get(d) ?? null,
      workouts: ws.length,
      workoutS: ws.reduce((s, w) => s + (w.durationS ?? 0), 0),
    });
  }

  const col = <K extends keyof DashDay>(k: K) => days.map((d) => d[k] as number | null);
  return {
    span,
    from,
    to,
    days,
    steps: figure(col("steps")),
    burned: figure(col("burnedKcal")),
    active: figure(col("activeKcal")),
    eaten: figure(col("eatenKcal")),
    drinks: figure(col("drinkKcal")),
    protein: figure(col("proteinG")),
    balance: figure(days.map((d) => (d.eatenKcal !== null && d.burnedKcal !== null ? d.eatenKcal - d.burnedKcal : null))),
    prep: figure(col("prepPortions")),
    workouts: { count: workouts.length, durationS: workouts.reduce((s, w) => s + (w.durationS ?? 0), 0) },
    stock: { portions: stock.reduce((s, b) => s + b.left, 0), batches: stock.length },
    targets: { kcal: kcalGoal?.target ?? null, steps: stepGoal },
  };
}

/** The newest live "steps a day" goal (at least N), or null. */
async function dailyStepGoal(db: SqlDriver, today: string): Promise<number | null> {
  const [g] = await db.all<{ target_num: number }>(
    `SELECT target_num FROM goals
     WHERE deleted_at IS NULL AND target_kind = 'sample' AND metric = ? AND period = 'day' AND comparator = '>='
       AND target_num IS NOT NULL AND start_day <= ? AND (end_day IS NULL OR end_day >= ?)
     ORDER BY start_day DESC, created_at DESC LIMIT 1`,
    [DASH_METRICS.steps, today, today],
  );
  return g?.target_num ?? null;
}

/** Meal prep portions eaten per local day. */
async function prepPortionsByDay(db: SqlDriver, from: string, to: string): Promise<Map<string, number>> {
  const rows = await db.all<{ day: string; n: number }>(
    `SELECT m.local_day AS day, SUM(m.portions) AS n FROM meal_prep_moves m
     JOIN meal_prep_batches b ON b.id = m.batch_id AND b.deleted_at IS NULL
     WHERE m.deleted_at IS NULL AND m.kind = 'eat' AND m.local_day BETWEEN ? AND ?
     GROUP BY m.local_day`,
    [from, to],
  );
  return new Map(rows.map((r) => [r.day, r.n]));
}
