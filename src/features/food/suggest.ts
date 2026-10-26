/**
 * Which meals to offer for one-tap logging. Pure: ./food.ts gathers the candidates.
 * Meals eaten often, at this time of day, and bookmarked ones come first.
 */

export type Meal = "breakfast" | "lunch" | "dinner" | "snack" | "prep";
export const MEALS: Meal[] = ["breakfast", "lunch", "dinner", "snack", "prep"];

/** The meal slot a local hour usually belongs to. */
export function mealForHour(hour: number): Meal {
  if (hour >= 5 && hour < 11) return "breakfast";
  if (hour >= 11 && hour < 16) return "lunch";
  if (hour >= 16 && hour < 19) return "snack";
  return "dinner";
}

export interface Candidate {
  /** "saved:<id>" or "name:<lower-case name>". */
  key: string;
  savedMealId: string | null;
  /** Newest log entry for this meal: what "log again" copies when it is not a saved meal. */
  lastEntryId: string | null;
  name: string;
  calories: number | null;
  photoId: string | null;
  /** Times logged in the look-back window (30 days). */
  uses: number;
  lastMs: number | null;
  /** How often it was logged in each slot, plus the saved meal's own slot. */
  slots: Partial<Record<Meal, number>>;
  defaultMeal: Meal | null;
  loggedToday: boolean;
}

/** The slot a candidate is usually eaten in: most logged, else its saved slot. */
export function usualMeal(c: Pick<Candidate, "slots" | "defaultMeal">): Meal | null {
  let best: Meal | null = null;
  let n = 0;
  for (const m of MEALS) {
    const k = c.slots[m] ?? 0;
    if (k > n) {
      best = m;
      n = k;
    }
  }
  return best ?? c.defaultMeal;
}

export function score(c: Candidate, slot: Meal, nowMs: number): number {
  let s = Math.min(c.uses, 10);
  if (usualMeal(c) === slot) s += 4;
  if (c.savedMealId) s += 2;
  if (c.lastMs !== null && nowMs - c.lastMs < 3 * 86_400_000) s += 1;
  if (c.loggedToday) s -= 6; // already had it today: still listed, lower down
  return s;
}

/** Best first. Ties go to the most recently eaten, then by name. */
export function rankSuggestions(cands: Candidate[], slot: Meal, nowMs: number, limit = 8): Candidate[] {
  return cands
    .map((c) => ({ c, s: score(c, slot, nowMs) }))
    .sort((a, b) => b.s - a.s || (b.c.lastMs ?? 0) - (a.c.lastMs ?? 0) || a.c.name.localeCompare(b.c.name))
    .slice(0, limit)
    .map((x) => x.c);
}
