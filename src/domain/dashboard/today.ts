import type { SqlDriver } from "../../db/driver";
import { loadStock } from "../mealprep/mealPrep";

/**
 * What Today suggests eating next (handoff 0.7, "Next up"): the meal prep portion in the fridge
 * that is ready and has to go first, with its recipe's calories and protein per portion.
 */
export interface NextUp {
  batchId: string;
  name: string;
  /** Ready portions in the fridge. */
  fridge: number;
  eatBy: string;
  kcal: number | null;
  proteinG: number | null;
}

export async function nextUp(db: SqlDriver, nowMs: number = Date.now()): Promise<NextUp | null> {
  const ready = (await loadStock(db))
    .map((s) => ({ s, lots: s.fridge.filter((l) => l.readyAtMs <= nowMs && l.portions > 0) }))
    .filter((x) => x.lots.length > 0)
    .map((x) => ({ ...x, eatBy: x.lots.map((l) => l.eatBy).sort()[0] }))
    .sort((a, b) => (a.eatBy < b.eatBy ? -1 : a.eatBy > b.eatBy ? 1 : 0));
  const first = ready[0];
  if (!first) return null;
  const [p] = await db.all<{ calories: number | null; protein_g: number | null }>("SELECT calories, protein_g FROM meal_preps WHERE id = ?", [
    first.s.batch.mealPrepId,
  ]);
  return {
    batchId: first.s.batch.id,
    name: first.s.batch.name,
    fridge: first.lots.reduce((n, l) => n + l.portions, 0),
    eatBy: first.eatBy,
    kcal: p?.calories ?? null,
    proteinG: p?.protein_g ?? null,
  };
}

export type MealSlot = "breakfast" | "lunch" | "dinner" | "snack";

/** The meal the next hours are about, from the local hour: what Next up is called. */
export function slotAt(hour: number): MealSlot {
  return hour < 10 ? "breakfast" : hour < 15 ? "lunch" : hour < 21 ? "dinner" : "snack";
}
