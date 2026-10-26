import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import type { SqlDriver } from "../../db/driver";
import { dayFood, listSavedMeals } from "../food/food";
import { listMealPreps, loadStock } from "../mealprep/mealPrep";
import { dailySeries, type MetricSeries } from "../metrics/queries";
import { listShopping } from "../mealprep/shopping";
import { ACTIVITY_FACTORS, bmr, calorieTarget, proteinTarget, slopePerDay, tdee, type ActivityLevel } from "../../core/health";
import { addDays } from "../../core/tz";
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

export const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "dates are YYYY-MM-DD");
const range = z
  .object({ from: day, to: day })
  .refine((r) => r.from <= r.to, "from must not be after to")
  .refine((r) => daysBetween(r.from, r.to) <= MAX_RANGE_DAYS, `ranges are limited to ${MAX_RANGE_DAYS} days`);

export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;
}

export const round = (n: number | null | undefined) => (n == null || !Number.isFinite(n) ? null : Math.round(n * 100) / 100);

export const DATE_DESC = "Local calendar day, YYYY-MM-DD";

function schema(properties: Record<string, unknown>): BetaTool["input_schema"] {
  return { type: "object", properties, required: Object.keys(properties), additionalProperties: false };
}

export function tool(name: string, description: string, properties: Record<string, unknown>): BetaTool {
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
    "List the owner's active goals, including the daily calorie target (target_kind food, metric calories): title, what is measured (target_kind and metric), comparator, target, unit, period and dates.",
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

const listFoodEntries: ChatTool = {
  dataClass: "raw",
  definition: tool(
    "list_food_entries",
    "Individual entries of the food log over a date range (at most 31 days): id, local time, meal, name, calories and macros, notes, whether it came from a meal prep portion or a saved meal, and who logged it. Use it to see what was already logged before adding more. Sends detailed records, which the owner must allow separately.",
    { from: { type: "string", description: DATE_DESC }, to: { type: "string", description: DATE_DESC } },
  ),
  async run(db, input) {
    const p = range.parse(input);
    if (daysBetween(p.from, p.to) > 31) throw new Error("list_food_entries is limited to 31 days");
    const ids: string[] = [];
    const entries = [];
    for (let d = p.from; d <= p.to; d = addDays(d, 1)) {
      for (const e of await dayFood(db, d)) {
        ids.push(e.id);
        entries.push({
          id: e.id,
          day: e.localDay,
          meal: e.meal,
          name: e.name,
          calories: round(e.calories),
          protein_g: round(e.proteinG),
          carbs_g: round(e.carbsG),
          fat_g: round(e.fatG),
          notes: e.notes,
          from_meal_prep: e.fromPrep,
          saved_meal_id: e.savedMealId,
        });
      }
    }
    // Local time and author are not on FoodEntry; read them for the same rows.
    const extra = new Map<string, { time: string; logged_by: string }>();
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500);
      const rows = await db.all<{ id: string; eaten_at_ms: number; offset_min: number; created_by: string }>(
        `SELECT id, eaten_at_ms, offset_min, created_by FROM food_entries WHERE id IN (${chunk.map(() => "?").join(",")})`,
        chunk,
      );
      for (const r of rows) extra.set(r.id, { time: new Date(r.eaten_at_ms + r.offset_min * 60_000).toISOString().slice(11, 16), logged_by: r.created_by });
    }
    const full = entries.map((e) => ({ ...e, ...extra.get(e.id) }));
    return { result: { from: p.from, to: p.to, entries: full }, summary: `Food log entries, ${p.from} to ${p.to} (${full.length})` };
  },
};

const listSavedMealsTool: ChatTool = {
  dataClass: "aggregate",
  definition: tool(
    "list_saved_meals",
    "The owner's saved (favourite) meals: id, name, usual meal, calories and macros per serving, how often and when last logged. Log one with log_saved_meal.",
    {},
  ),
  async run(db) {
    const meals = (await listSavedMeals(db)).map((m) => ({
      id: m.id,
      name: m.name,
      meal: m.meal,
      calories: round(m.calories),
      protein_g: round(m.proteinG),
      carbs_g: round(m.carbsG),
      fat_g: round(m.fatG),
      has_photo: m.photoId !== null,
      times_logged: m.uses,
      last_logged_ms: m.lastMs,
    }));
    return { result: { saved_meals: meals }, summary: `Saved meals (${meals.length})` };
  },
};

const listMealPrepsTool: ChatTool = {
  dataClass: "aggregate",
  definition: tool(
    "list_meal_preps",
    "The owner's meal prep recipes: id, name, tags, portions per batch, shelf life (fridge days, freezer days, thaw hours), calories and macros per portion, ingredients for one batch, notes. Optionally only recipes with a tag (e.g. 'lunch').",
    { tag: { type: ["string", "null"], description: "Only recipes with this tag, or null for all" } },
  ),
  async run(db, input) {
    const p = z.object({ tag: z.string().trim().max(40).nullable() }).parse(input);
    const preps = (await listMealPreps(db, p.tag || null)).map((r) => ({
      id: r.id,
      name: r.name,
      tags: r.tags,
      portions: r.portions,
      fridge_days: r.fridgeDays,
      freezer_days: r.freezerDays,
      thaw_hours: r.thawHours,
      calories: round(r.calories),
      protein_g: round(r.proteinG),
      carbs_g: round(r.carbsG),
      fat_g: round(r.fatG),
      ingredients: r.ingredients.map((i) => ({ name: i.name, quantity: i.quantity, unit: i.unit })),
      notes: r.notes,
    }));
    return { result: { meal_preps: preps }, summary: `Meal prep recipes (${preps.length})` };
  },
};

const mealPrepStock: ChatTool = {
  dataClass: "aggregate",
  definition: tool(
    "meal_prep_stock",
    "Cooked meal prep batches that still have portions: batch id, recipe, day cooked, portions in the fridge (with eat-by days, and whether thawed) and in the freezer (with best-before days), portions eaten and thrown out.",
    {},
  ),
  async run(db) {
    const stock = (await loadStock(db)).map((s) => ({
      batch_id: s.batch.id,
      meal_prep_id: s.batch.mealPrepId,
      recipe: s.batch.name,
      tags: s.batch.tags,
      cooked_day: s.batch.localDay,
      portions_made: s.batch.portions,
      fridge: s.fridge.map((l) => ({ portions: l.portions, eat_by: l.eatBy, thawed: l.thawed })),
      freezer: s.freezer.map((l) => ({ portions: l.portions, frozen_day: l.frozenDay, best_before: l.bestBefore })),
      in_fridge: s.fridgeCount,
      in_freezer: s.freezerCount,
      eaten: s.eaten,
      discarded: s.discarded,
      left: s.left,
    }));
    return { result: { batches: stock }, summary: `Meal prep stock (${stock.length} batches)` };
  },
};

const shoppingListTool: ChatTool = {
  dataClass: "aggregate",
  definition: tool("shopping_list", "The shopping list: item, quantity, unit, and whether it is ticked off.", {}),
  async run(db) {
    const items = (await listShopping(db)).map((i) => ({ name: i.name, quantity: i.quantity, unit: i.unit, checked: i.checked }));
    return { result: { items }, summary: `Shopping list (${items.length} items)` };
  },
};

const ACTIVITY = Object.keys(ACTIVITY_FACTORS) as ActivityLevel[];

const energyNeeds: ChatTool = {
  dataClass: "aggregate",
  definition: tool(
    "energy_needs",
    "Calculator, reads nothing from the phone: basal metabolic rate (Mifflin-St Jeor), daily energy expenditure for an activity level, the daily calorie intake for a weight change per week (never below BMR, flagged if the goal would need less), and a protein target (1.6 g/kg). Use the owner's own numbers, asking for missing ones.",
    {
      sex: { type: "string", enum: ["male", "female"], description: "For the BMR formula" },
      age_years: { type: "number", description: "Age in years" },
      height_cm: { type: "number", description: "Height in cm" },
      weight_kg: { type: "number", description: "Weight in kg" },
      activity: { type: "string", enum: ACTIVITY, description: "sedentary, light (1-3 days/week), moderate (3-5), active (6-7), very_active" },
      kg_per_week: { type: "number", description: "Wanted weight change per week, negative to lose (e.g. -0.5), 0 to maintain" },
    },
  ),
  async run(_db, input) {
    const p = z
      .object({
        sex: z.enum(["male", "female"]),
        age_years: z.number().min(16).max(110),
        height_cm: z.number().min(120).max(230),
        weight_kg: z.number().min(30).max(300),
        activity: z.enum(ACTIVITY as [ActivityLevel, ...ActivityLevel[]]),
        kg_per_week: z.number().min(-1).max(1),
      })
      .parse(input);
    const person = { sex: p.sex, ageYears: p.age_years, heightCm: p.height_cm, weightKg: p.weight_kg };
    const target = calorieTarget(person, p.activity, p.kg_per_week);
    return {
      result: {
        bmr_kcal: Math.round(bmr(person)),
        tdee_kcal: Math.round(tdee(person, p.activity)),
        target_kcal: target.kcal,
        target_floored_at_bmr: target.floored,
        protein_target_g: proteinTarget(p.weight_kg),
        assumptions: "Mifflin-St Jeor BMR, activity factor, 7700 kcal per kg of body weight. Estimates, typically within about 10%.",
      },
      summary: "Energy needs calculation (no stored data sent)",
    };
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
  listSavedMealsTool,
  listMealPrepsTool,
  mealPrepStock,
  shoppingListTool,
  energyNeeds,
  dailySeriesTool,
  listFoodEntries,
  dayNotes,
];

export const TOOLS_BY_NAME = new Map(CHAT_TOOLS.map((t) => [t.definition.name, t]));
