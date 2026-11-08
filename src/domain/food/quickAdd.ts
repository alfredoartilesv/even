import type { SqlDriver } from "../../db/driver.js";
import { deleteDrink, logDrink, type DrinkType } from "../alcohol/alcohol.js";
import { deleteFood, logSavedMeal, relogFood } from "./food.js";
import type { Candidate, Meal } from "./suggest.js";

/**
 * Quick add (handoff 0.7, the Add button and Today's bar): "Tell Even what you ate or drank".
 * Worked out on this device from the owner's own data, nothing is sent anywhere: a favourite
 * drink by name or kind ("beer"), and foods logged before or saved ("2 eggs, toast and a coffee"
 * finds each part it knows). A part it does not know stays as text, for the owner to add by hand
 * or ask Coach about. Weight is not here: the owner wants food and a weigh-in kept apart (8 Nov
 * 2026), so a weigh-in has its own row on Today and its own form in Journal.
 */
export type QuickLine =
  | { kind: "food"; part: string; count: number; candidate: Candidate }
  | { kind: "drink"; part: string; count: number; type: DrinkType }
  | { kind: "unknown"; part: string };

const DRINK_WORDS = [
  "beer",
  "lager",
  "ale",
  "wine",
  "cider",
  "gin",
  "vodka",
  "whisky",
  "whiskey",
  "rum",
  "cocktail",
  "spritz",
  "cava",
  "champagne",
  "cerveza",
  "vino",
];
const NUMBER_WORDS: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5 };

/** "2 eggs" -> 2 and "eggs"; "a coffee" -> 1 and "coffee". */
function quantity(part: string): { count: number; rest: string } {
  const m = /^(\d+(?:[.,]\d+)?|a|an|one|two|three|four|five)\s+(.+)$/i.exec(part);
  if (!m) return { count: 1, rest: part };
  const n = NUMBER_WORDS[m[1].toLowerCase()] ?? Number(m[1].replace(",", "."));
  // "330 ml beer": a size, not a count.
  if (/^(ml|cl|l|g|oz)\b/i.test(m[2]) || n > 20) return { count: 1, rest: part };
  return { count: n, rest: m[2] };
}

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^\p{L}\p{N} ]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

/** How well a known name fits what was typed: 3 same, 2 one holds the other, 1 shares a word of 4+ letters, 0 not at all. */
function fit(typed: string, known: string): number {
  const a = norm(typed);
  const b = norm(known);
  if (!a || !b) return 0;
  if (a === b) return 3;
  if (b.includes(a) || a.includes(b)) return 2;
  const words = new Set(b.split(" ").filter((w) => w.length >= 4));
  return a.split(" ").some((w) => words.has(w) || words.has(w.replace(/s$/, ""))) ? 1 : 0;
}

function best<T>(typed: string, items: T[], name: (t: T) => string, score: (t: T) => number = () => 0): T | null {
  let top: T | null = null;
  let topFit = 0;
  for (const t of items) {
    const f = fit(typed, name(t));
    if (f > topFit || (f === topFit && f > 0 && top && score(t) > score(top))) {
      top = t;
      topFit = f;
    }
  }
  return topFit > 0 ? top : null;
}

export function parseQuickAdd(text: string, known: { foods: Candidate[]; drinks: DrinkType[] }): QuickLine[] {
  const parts = text
    .split(/,|;|\+|\band\b|\bwith\b|\by\b/i)
    .map((p) => p.trim())
    .filter(Boolean);
  return parts.map((part): QuickLine => {
    const { count, rest } = quantity(part);
    const drink = best(
      rest,
      known.drinks,
      (d) => d.name,
      (d) => d.uses,
    );
    const word = DRINK_WORDS.find((x) => norm(rest).split(" ").includes(x));
    if (drink && (fit(rest, drink.name) >= 2 || word)) return { kind: "drink", part, count, type: drink };
    if (word) {
      const byWord = known.drinks.filter((d) => norm(d.name).includes(word)).sort((a, b) => b.uses - a.uses)[0];
      if (byWord) return { kind: "drink", part, count, type: byWord };
    }
    const food = best(
      rest,
      known.foods,
      (c) => c.name,
      (c) => c.uses,
    );
    if (food) return { kind: "food", part, count, candidate: food };
    return { kind: "unknown", part };
  });
}

/** What a quick add wrote, so Undo can take it all back. */
export interface QuickUndo {
  foods: string[];
  drinks: string[];
}

export async function applyQuickAdd(
  db: SqlDriver,
  lines: QuickLine[],
  opts: { meal: Meal; timeZone: string; drinkPrice?: (type: DrinkType) => number | null },
): Promise<QuickUndo> {
  const undo: QuickUndo = { foods: [], drinks: [] };
  for (const l of lines) {
    if (l.kind === "food") {
      const c = l.candidate;
      if (c.savedMealId) undo.foods.push(await logSavedMeal(db, c.savedMealId, { servings: l.count, meal: opts.meal, timeZone: opts.timeZone }));
      else if (c.lastEntryId)
        for (let i = 0; i < l.count; i++) undo.foods.push(await relogFood(db, c.lastEntryId, { timeZone: opts.timeZone, meal: opts.meal }));
    } else if (l.kind === "drink") {
      const price = opts.drinkPrice?.(l.type);
      undo.drinks.push(...(await logDrink(db, { typeId: l.type.id, count: l.count, ...(price !== undefined ? { price } : {}), timeZone: opts.timeZone })));
    }
  }
  return undo;
}

export async function undoQuickAdd(db: SqlDriver, u: QuickUndo): Promise<void> {
  for (const id of u.foods) await deleteFood(db, id);
  for (const id of u.drinks) await deleteDrink(db, id);
}
