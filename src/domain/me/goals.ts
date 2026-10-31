import { createLogger } from "../../core/log.js";
import { addDays } from "../../core/tz.js";
import type { SqlDriver } from "../../db/driver.js";

/**
 * Goals and how they are going. A goal measures one daily number (a synced metric, a manual
 * measurement, a food total or an alcohol total) against a target over a day, week or month.
 *
 * - day: each day on its own. Shows today, the last 7 days met, and the streak.
 * - week (Monday start) / month: the period so far. Amounts (steps, kcal, grams, distance:
 *   anything summed per day) are summed; levels (heart rate, sleep score, weight) are averaged,
 *   except manual measurements, where the latest one counts.
 * Free-text goals (target_kind none) have no number and no progress.
 */

const log = createLogger("me.goals");

export type TargetKind = "sample" | "manual" | "food" | "drink" | "none";
export type Period = "day" | "week" | "month";

export interface Goal {
  id: string;
  title: string;
  targetKind: TargetKind;
  metric: string | null;
  comparator: ">=" | "<=" | null;
  targetNum: number | null;
  unit: string | null;
  period: Period;
  startDay: string;
  endDay: string | null;
  notes: string | null;
}

export const FOOD_COLUMNS = ["calories", "protein_g", "carbs_g", "fat_g"] as const;
export const DRINK_COLUMNS = ["alcohol_g", "calories", "drinks", "price"] as const;

export async function listGoals(db: SqlDriver, today: string): Promise<Goal[]> {
  const rows = await db.all<{
    id: string;
    title: string;
    target_kind: TargetKind;
    metric: string | null;
    comparator: Goal["comparator"];
    target_num: number | null;
    unit: string | null;
    period: Period;
    start_day: string;
    end_day: string | null;
    notes: string | null;
  }>(
    `SELECT id, title, target_kind, metric, comparator, target_num, unit, period, start_day, end_day, notes FROM goals
     WHERE deleted_at IS NULL AND (end_day IS NULL OR end_day >= ?)
     ORDER BY start_day, created_at`,
    [today],
  );
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    targetKind: r.target_kind,
    metric: r.metric,
    comparator: r.comparator,
    targetNum: r.target_num,
    unit: r.unit,
    period: r.period,
    startDay: r.start_day,
    endDay: r.end_day,
    notes: r.notes,
  }));
}

/** Soft delete: the goal disappears from lists, the row stays for backups and history. */
export async function deleteGoal(db: SqlDriver, id: string, nowMs: number = Date.now()): Promise<void> {
  await db.run("UPDATE goals SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL", [nowMs, nowMs, id]);
  log.info("goal deleted", { id });
}

/** How the days of a week or month combine into one number. */
export type Combine = "sum" | "avg" | "last";

/** The goal's daily numbers between two days, and how to combine them. */
async function goalDays(db: SqlDriver, g: Goal, from: string, to: string): Promise<{ values: Map<string, number>; combine: Combine }> {
  const values = new Map<string, number>();
  const put = (rows: { day: string; v: number | null }[]) => rows.forEach((r) => r.v !== null && values.set(r.day, r.v));
  switch (g.targetKind) {
    case "food": {
      if (!FOOD_COLUMNS.includes(g.metric as never)) break;
      put(await db.all(`SELECT local_day AS day, ${g.metric} AS v FROM daily_nutrition WHERE local_day BETWEEN ? AND ?`, [from, to]));
      return { values, combine: "sum" };
    }
    case "drink": {
      if (!DRINK_COLUMNS.includes(g.metric as never)) break;
      put(await db.all(`SELECT local_day AS day, ${g.metric} AS v FROM daily_alcohol WHERE local_day BETWEEN ? AND ?`, [from, to]));
      return { values, combine: "sum" };
    }
    case "manual": {
      // The day's latest measurement of that kind.
      put(
        await db.all(
          `SELECT m.local_day AS day, m.value_num AS v FROM manual_measurements m
           WHERE m.deleted_at IS NULL AND m.kind = ? AND m.value_num IS NOT NULL AND m.local_day BETWEEN ? AND ?
             AND m.measured_at_ms = (SELECT MAX(x.measured_at_ms) FROM manual_measurements x
                                     WHERE x.deleted_at IS NULL AND x.kind = m.kind AND x.local_day = m.local_day AND x.value_num IS NOT NULL)`,
          [g.metric, from, to],
        ),
      );
      return { values, combine: "last" };
    }
    case "sample": {
      // One number per day, picked as metric_catalog.daily_agg says. Several devices on one day:
      // the one with most readings.
      const rows = await db.all<{ day: string; v: number; agg: string | null; readings: number }>(
        `SELECT d.local_day AS day, d.readings,
                CASE COALESCE(c.daily_agg, 'avg') WHEN 'sum' THEN d.sum_num WHEN 'min' THEN d.min_num WHEN 'max' THEN d.max_num
                     WHEN 'last' THEN d.last_num ELSE d.avg_num END AS v, c.daily_agg AS agg
         FROM daily_metric_values d LEFT JOIN metric_catalog c ON c.source = d.source AND c.metric = d.metric
         WHERE d.metric = ? AND d.local_day BETWEEN ? AND ?
         ORDER BY d.local_day, d.readings DESC`,
        [g.metric, from, to],
      );
      for (const r of rows) if (!values.has(r.day)) values.set(r.day, r.v);
      return { values, combine: rows.some((r) => r.agg === "sum") ? "sum" : "avg" };
    }
    case "none":
      break;
  }
  return { values, combine: "avg" };
}

export type Status = "met" | "on_track" | "behind" | "missed" | "no_data";

export interface Progress {
  /** The number compared with the target: today's value, or the period so far. */
  current: number | null;
  status: Status;
  /** Share of the target reached, 0-1+ (for >= goals; null for <= goals and free text). */
  fraction: number | null;
  periodFrom: string;
  periodTo: string;
  /** Day goals: of the last 7 days (today included), how many had data and met it. */
  last7: { met: number; withData: number } | null;
  /** Day goals: consecutive met days up to today (or yesterday while today is not met yet). */
  streak: number | null;
}

/** Monday of the week, first of the month, or the day itself. */
export function periodStart(period: Period, day: string): string {
  if (period === "day") return day;
  if (period === "month") return `${day.slice(0, 8)}01`;
  const dow = (new Date(`${day}T12:00:00Z`).getUTCDay() + 6) % 7;
  return addDays(day, -dow);
}

const meets = (v: number, cmp: ">=" | "<=", target: number) => (cmp === ">=" ? v >= target : v <= target);

/** Pure: progress of a measurable goal from its daily numbers. */
export function evaluate(g: Pick<Goal, "comparator" | "targetNum" | "period">, values: Map<string, number>, combine: Combine, today: string): Progress {
  const from = periodStart(g.period, today);
  const cmp = g.comparator;
  const target = g.targetNum;
  const empty: Progress = { current: null, status: "no_data", fraction: null, periodFrom: from, periodTo: today, last7: null, streak: null };
  if (!cmp || target === null) return empty;
  const frac = (v: number) => (cmp === ">=" && target > 0 ? v / target : null);

  if (g.period === "day") {
    const v = values.get(today) ?? null;
    let met = 0;
    let withData = 0;
    for (let i = 0; i < 7; i++) {
      const x = values.get(addDays(today, -i));
      if (x === undefined) continue;
      withData++;
      if (meets(x, cmp, target)) met++;
    }
    // A <= goal is only settled when the day is over, so today does not break or extend the streak until it is met.
    let streak = 0;
    let d = v !== null && meets(v, cmp, target) ? today : addDays(today, -1);
    for (let x = values.get(d); x !== undefined && meets(x, cmp, target); x = values.get(d)) {
      streak++;
      d = addDays(d, -1);
    }
    const status: Status = v === null ? "no_data" : meets(v, cmp, target) ? "met" : cmp === "<=" ? "missed" : "behind";
    return { current: v, status, fraction: v === null ? null : frac(v), periodFrom: today, periodTo: today, last7: { met, withData }, streak };
  }

  const days = [...values.entries()].filter(([d]) => d >= from && d <= today).sort(([a], [b]) => (a < b ? -1 : 1));
  if (!days.length) return empty;
  const nums = days.map(([, v]) => v);
  const current =
    combine === "sum" ? nums.reduce((a, b) => a + b, 0) : combine === "last" ? nums[nums.length - 1] : nums.reduce((a, b) => a + b, 0) / nums.length;
  // A summed amount under a <= limit can still go over before the period ends: "on track", not "met".
  const ok = meets(current, cmp, target);
  const status: Status = ok ? (cmp === "<=" && combine === "sum" ? "on_track" : "met") : cmp === "<=" && combine === "sum" ? "missed" : "behind";
  return { current, status, fraction: frac(current), periodFrom: from, periodTo: today, last7: null, streak: null };
}

export async function goalProgress(db: SqlDriver, g: Goal, today: string): Promise<Progress | null> {
  if (g.targetKind === "none") return null;
  // Day goals read 60 days back (the last 7 days and a streak of up to 60); periods from their start.
  const from = g.period === "day" ? addDays(today, -60) : periodStart(g.period, today);
  const { values, combine } = await goalDays(db, g, from, today);
  return evaluate(g, values, combine, today);
}
