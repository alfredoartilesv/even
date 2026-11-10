import type { SqlDriver } from "../../db/driver.js";
import { getSetting, setSetting } from "../../db/settings.js";
import { addDays } from "../../core/tz.js";
import { createLogger } from "../../core/log.js";

const log = createLogger("mealprep");

/**
 * Days a tupper is not eaten (the owner's ask, 9 Nov 2026), so the plan moves the rest on a day
 * instead of counting a meal that did not happen:
 * - skipped by hand, from the plan or Today's Next up;
 * - eaten out: a meal the tuppers are for logged as something else that day (a lunch entry that
 *   is not a portion), which skips that meal's tupper by itself, or uses up a skip set by hand
 *   for that day (daySkipCount).
 * Kept in app_settings beside the tuppers a day (one small JSON value per device, like that one),
 * days before the last month dropped as it is written.
 */
export type PrepMeal = "breakfast" | "lunch" | "dinner";
export const PREP_MEALS: PrepMeal[] = ["breakfast", "lunch", "dinner"];

const MEALS_KEY = "meal_prep.meals";
const SKIPS_KEY = "meal_prep.skips";
const KEEP_DAYS = 31;
/** The tuppers a day as a number, before the meals took its place: read only for the default. */
const LEGACY_PER_DAY_KEY = "meal_prep.portions_per_day.all";

/**
 * The meals the tuppers are for; how many there are is the tuppers a day (the owner's choice,
 * 9 Nov 2026: one setting, not a count beside the meals). Unset, it comes from the count set
 * before: lunch for one, lunch and dinner for two, all three beyond, none for 0.
 */
export async function getPrepMeals(db: SqlDriver): Promise<PrepMeal[]> {
  const raw = await getSetting(db, MEALS_KEY);
  try {
    const v: unknown = raw === null ? null : JSON.parse(raw);
    if (Array.isArray(v)) return PREP_MEALS.filter((m) => v.includes(m));
  } catch {
    log.warn("prep meals unreadable, using the default");
  }
  const old = Number(await getSetting(db, LEGACY_PER_DAY_KEY));
  const perDay = Number.isInteger(old) && old >= 0 && (await getSetting(db, LEGACY_PER_DAY_KEY)) !== null ? old : 1;
  return perDay === 0 ? [] : perDay === 1 ? ["lunch"] : perDay === 2 ? ["lunch", "dinner"] : [...PREP_MEALS];
}

export async function setPrepMeals(db: SqlDriver, meals: PrepMeal[], nowMs: number = Date.now()): Promise<void> {
  await setSetting(db, MEALS_KEY, JSON.stringify(PREP_MEALS.filter((m) => meals.includes(m))), nowMs);
  log.debug("prep meals set", { n: meals.length });
}

async function readSkips(db: SqlDriver): Promise<Record<string, number>> {
  const raw = await getSetting(db, SKIPS_KEY);
  try {
    const v: unknown = raw === null ? {} : JSON.parse(raw);
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const out: Record<string, number> = {};
      for (const [k, n] of Object.entries(v)) if (/^\d{4}-\d{2}-\d{2}$/.test(k) && Number.isInteger(n) && (n as number) > 0) out[k] = n as number;
      return out;
    }
  } catch {
    log.warn("prep skips unreadable, starting again");
  }
  return {};
}

/** Set how many tuppers are skipped by hand on a day (0 takes the skips back). Returns that day's skips. */
export async function setDaySkips(db: SqlDriver, day: string, today: string, n: number, nowMs: number = Date.now()): Promise<number> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error("Pick a day");
  if (day < today) throw new Error("That day is over");
  if (!Number.isInteger(n) || n < 0) throw new Error("Pick how many tuppers to skip");
  const all = await readSkips(db);
  const oldest = addDays(today, -KEEP_DAYS);
  const kept: Record<string, number> = {};
  for (const [k, v] of Object.entries(all)) if (k >= oldest) kept[k] = v;
  const was = kept[day] ?? 0;
  if (n) kept[day] = n;
  else delete kept[day];
  await setSetting(db, SKIPS_KEY, JSON.stringify(kept), nowMs);
  log.info(n > was ? "tupper skipped" : "tupper skip undone", { skips: n });
  return n;
}

/** Skip one more tupper on a day (by = 1), or take a skip back (by = -1). Returns that day's skips. */
export async function skipTupper(db: SqlDriver, day: string, today: string, by: 1 | -1 = 1, nowMs: number = Date.now()): Promise<number> {
  const n = Math.max(0, ((await readSkips(db))[day] ?? 0) + by);
  return setDaySkips(db, day, today, n, nowMs);
}

export interface DaySkips {
  /** Skipped by hand. */
  manual: number;
  /** Meals the tuppers are for that were logged as something else. */
  ateOut: PrepMeal[];
}

/** Each day's skips from `from` to `to`, only days with any. */
export async function skipsBetween(db: SqlDriver, from: string, to: string, meals: PrepMeal[]): Promise<Map<string, DaySkips>> {
  const out = new Map<string, DaySkips>();
  const all = await readSkips(db);
  for (const [day, n] of Object.entries(all)) if (day >= from && day <= to) out.set(day, { manual: n, ateOut: [] });
  if (meals.length) {
    const rows = await db.all<{ local_day: string; meal: PrepMeal }>(
      `SELECT DISTINCT local_day, meal FROM food_entries
       WHERE deleted_at IS NULL AND local_day BETWEEN ? AND ? AND meal IN (${meals.map(() => "?").join(", ")})`,
      [from, to, ...meals],
    );
    for (const r of rows) {
      const d = out.get(r.local_day) ?? { manual: 0, ateOut: [] };
      d.ateOut.push(r.meal);
      out.set(r.local_day, d);
    }
  }
  return out;
}

/**
 * Tuppers not eaten on a day. A skip set by hand is a meal planned elsewhere, so logging that
 * meal as something else uses the skip up instead of adding a second one (the owner's report,
 * 10 Nov 2026: skipping tomorrow's lunch, then logging lunch out, dropped dinner's tupper too).
 * Only meals eaten out beyond the planned skips add to them.
 */
export const daySkipCount = (d: DaySkips) => Math.max(d.manual, d.ateOut.length);

/** Hand skips not yet used up by a meal logged as something else that day. */
export const skipsLeft = (d: DaySkips) => Math.max(0, d.manual - d.ateOut.length);

/** Tuppers not eaten each day, for the plan (planDefrost's skips). */
export const skipCounts = (s: Map<string, DaySkips>) => new Map([...s].map(([d, v]) => [d, daySkipCount(v)]));

/** What a plan from `day` needs to know: the meals the tuppers are for and each day's skips. */
export async function planSkips(db: SqlDriver, day: string, horizonDays: number): Promise<{ meals: PrepMeal[]; days: Map<string, DaySkips> }> {
  const meals = await getPrepMeals(db);
  return { meals, days: await skipsBetween(db, day, addDays(day, horizonDays - 1), meals) };
}
