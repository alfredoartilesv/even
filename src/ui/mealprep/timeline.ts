import { addDays } from "../../core/tz";

/**
 * The defrost plan as a strip of days. Takes the plan's shape structurally (the fields of
 * domain/mealprep/stock.ts Plan it needs), so ui/ stays below domain/.
 */
export interface PlanLike {
  thaw: { day: string; forDay: string; name: string; portions: number; late: boolean }[];
  short: { day: string; missing: number }[];
  coveredThrough: string | null;
  waste: { name: string; portions: number; eatBy: string }[];
}

export interface TimelineDay {
  day: string;
  /** "covered": planned portions are there. "short": `missing` portions are not. */
  state: "covered" | "short";
  missing: number;
  /** Take these out of the freezer on this day. */
  takeOut: { name: string; portions: number; forDay: string; late: boolean }[];
  /** Fridge portions whose eat-by is this day and that the plan will not reach. */
  expiring: { name: string; portions: number }[];
}

export function timelineDays(plan: PlanLike, today: string, horizon = 7): TimelineDay[] {
  return Array.from({ length: horizon }, (_, i) => {
    const day = addDays(today, i);
    const missing = plan.short.find((s) => s.day === day)?.missing ?? 0;
    return {
      day,
      state: missing > 0 ? "short" : "covered",
      missing,
      // Late advice ("should have started yesterday") belongs to today: it is what to do now.
      takeOut: plan.thaw.filter((t) => (t.late ? today : t.day) === day).map(({ name, portions, forDay, late }) => ({ name, portions, forDay, late })),
      expiring: plan.waste.filter((w) => w.eatBy === day).map(({ name, portions }) => ({ name, portions })),
    };
  });
}

/** Days from today through coveredThrough, inclusive: 0 when today is already short. */
export function daysCovered(plan: Pick<PlanLike, "coveredThrough">, today: string): number {
  if (!plan.coveredThrough || plan.coveredThrough < today) return 0;
  let n = 1;
  for (let d = today; d < plan.coveredThrough && n < 400; d = addDays(d, 1)) n++;
  return n;
}
