import { addDays } from "../../core/tz";

/**
 * The defrost plan as a strip of days. Takes the plan's shape structurally (the fields of
 * domain/mealprep/stock.ts Plan it needs), so ui/ stays below domain/.
 */
export interface PlanLike {
  meals?: { day: string; batchId: string; name: string; portions: number; from: "fridge" | "thawed"; eatBy: string | null; thawDay: string | null }[];
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
  /** What is eaten this day, and where it comes from. */
  meals: NonNullable<PlanLike["meals"]>;
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
      meals: (plan.meals ?? []).filter((m) => m.day === day),
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

/** A run of days in the plan: one day with its meals, or several days in a row with nothing. */
export type PlanRow = { kind: "day"; day: TimelineDay } | { kind: "gap"; from: string; to: string; days: number };

/** The timeline with consecutive short days that have nothing at all folded into one gap row. */
export function planRows(days: TimelineDay[]): PlanRow[] {
  const rows: PlanRow[] = [];
  for (const d of days) {
    const empty = d.state === "short" && d.meals.length === 0 && d.takeOut.length === 0;
    const last = rows[rows.length - 1];
    if (empty && last?.kind === "gap") rows[rows.length - 1] = { ...last, to: d.day, days: last.days + 1 };
    else if (empty) rows.push({ kind: "gap", from: d.day, to: d.day, days: 1 });
    else rows.push({ kind: "day", day: d });
  }
  return rows;
}
