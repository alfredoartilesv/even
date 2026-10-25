import { localDay, tzOffsetMinutes } from "../lib/tz";
import { uuidv7 } from "../lib/uuidv7";
import { available, foldBatch, type BatchInfo, type BatchStock, type Location, type Move, type MoveKind } from "../mealprep/stock";
import type { SqlDriver, SqlValue } from "./driver";
import { deviceId, getSetting, setSetting } from "./settings";

/** Meal prep recipes, batches and portion moves (schema 0003). Stock maths is in src/mealprep/stock.ts. */

export interface Ingredient {
  /** Present for rows already saved; editing keeps the id. */
  id?: string;
  name: string;
  quantity: number | null;
  unit: string | null;
}

export interface MealPrepInput {
  /** Omit to create. */
  id?: string;
  name: string;
  portions: number;
  fridgeDays: number;
  freezerDays: number;
  thawHours: number;
  calories: number | null;
  proteinG: number | null;
  carbsG: number | null;
  fatG: number | null;
  notes: string | null;
  tags: string[];
  ingredients: Ingredient[];
}

export type MealPrep = Required<Pick<MealPrepInput, "id">> & Omit<MealPrepInput, "id"> & { ingredients: Required<Ingredient>[] };

export const DEFAULT_MEAL_PREP: Omit<MealPrepInput, "name"> = {
  portions: 4,
  fridgeDays: 4,
  freezerDays: 90,
  thawHours: 24,
  calories: null,
  proteinG: null,
  carbsG: null,
  fatG: null,
  notes: null,
  tags: [],
  ingredients: [],
};

/** Tags are stored trimmed, lower case, inner spaces collapsed. */
export function normalizeTag(tag: string): string {
  return tag.trim().toLowerCase().replace(/\s+/g, " ");
}

const posInt = (n: number, what: string, min = 1) => {
  if (!Number.isInteger(n) || n < min) throw new Error(`${what} must be a whole number of at least ${min}`);
  return n;
};

async function inTransaction<T>(db: SqlDriver, fn: () => Promise<T>): Promise<T> {
  await db.exec("BEGIN");
  try {
    const out = await fn();
    await db.exec("COMMIT");
    return out;
  } catch (err) {
    await db.exec("ROLLBACK");
    throw err;
  }
}

function validate(input: MealPrepInput): void {
  if (!input.name.trim()) throw new Error("Give the meal prep a name");
  posInt(input.portions, "Portions");
  posInt(input.fridgeDays, "Fridge days");
  posInt(input.freezerDays, "Freezer days");
  posInt(input.thawHours, "Thaw hours", 0);
  for (const i of input.ingredients) {
    if (!i.name.trim()) throw new Error("Every ingredient needs a name");
    if (i.quantity !== null && !(i.quantity > 0)) throw new Error(`Quantity for ${i.name} must be more than 0`);
  }
}

/** Create or update a recipe with its tags and ingredients. Returns its id. */
export async function saveMealPrep(db: SqlDriver, input: MealPrepInput, nowMs: number = Date.now()): Promise<string> {
  validate(input);
  const dev = await deviceId(db, nowMs);
  const id = input.id ?? uuidv7(nowMs);
  const tags = [...new Set(input.tags.map(normalizeTag).filter(Boolean))];

  return inTransaction(db, async () => {
    const cols: SqlValue[] = [
      input.name.trim(),
      input.portions,
      input.fridgeDays,
      input.freezerDays,
      input.thawHours,
      input.calories,
      input.proteinG,
      input.carbsG,
      input.fatG,
      input.notes?.trim() || null,
    ];
    if (input.id) {
      await db.run(
        `UPDATE meal_preps SET name = ?, portions = ?, fridge_days = ?, freezer_days = ?, thaw_hours = ?,
           calories = ?, protein_g = ?, carbs_g = ?, fat_g = ?, notes = ?, updated_at = ?
         WHERE id = ? AND deleted_at IS NULL`,
        [...cols, nowMs, id],
      );
    } else {
      await db.run(
        `INSERT INTO meal_preps (id, name, portions, fridge_days, freezer_days, thaw_hours, calories, protein_g, carbs_g, fat_g, notes,
           created_at, updated_at, origin_device_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, ...cols, nowMs, nowMs, dev],
      );
    }

    // Tags: soft-delete the ones removed, insert the new ones.
    const liveTags = await db.all<{ id: string; tag: string }>(
      "SELECT id, tag FROM meal_prep_tags WHERE meal_prep_id = ? AND deleted_at IS NULL",
      [id],
    );
    for (const t of liveTags) {
      if (!tags.includes(t.tag)) {
        await db.run("UPDATE meal_prep_tags SET deleted_at = ?, updated_at = ? WHERE id = ?", [nowMs, nowMs, t.id]);
      }
    }
    for (const tag of tags) {
      if (liveTags.some((t) => t.tag === tag)) continue;
      await db.run(
        `INSERT INTO meal_prep_tags (id, meal_prep_id, tag, created_at, updated_at, origin_device_id) VALUES (?, ?, ?, ?, ?, ?)`,
        [uuidv7(nowMs), id, tag, nowMs, nowMs, dev],
      );
    }

    // Ingredients: update by id, soft-delete the missing ones, insert the rest.
    const liveIngredients = await db.all<{ id: string }>(
      "SELECT id FROM meal_prep_ingredients WHERE meal_prep_id = ? AND deleted_at IS NULL",
      [id],
    );
    const keep = new Set(input.ingredients.map((i) => i.id).filter(Boolean));
    for (const row of liveIngredients) {
      if (!keep.has(row.id)) {
        await db.run("UPDATE meal_prep_ingredients SET deleted_at = ?, updated_at = ? WHERE id = ?", [nowMs, nowMs, row.id]);
      }
    }
    for (const [n, i] of input.ingredients.entries()) {
      const vals: SqlValue[] = [n, i.name.trim(), i.quantity, i.unit?.trim() || null];
      if (i.id && liveIngredients.some((r) => r.id === i.id)) {
        await db.run(
          "UPDATE meal_prep_ingredients SET sort_order = ?, name = ?, quantity = ?, unit = ?, updated_at = ? WHERE id = ?",
          [...vals, nowMs, i.id],
        );
      } else {
        await db.run(
          `INSERT INTO meal_prep_ingredients (id, meal_prep_id, sort_order, name, quantity, unit, created_at, updated_at, origin_device_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [uuidv7(nowMs), id, ...vals, nowMs, nowMs, dev],
        );
      }
    }
    return id;
  });
}

/** Soft-delete a recipe and its tags and ingredients. Batches already cooked stay in stock. */
export async function deleteMealPrep(db: SqlDriver, id: string, nowMs: number = Date.now()): Promise<void> {
  await inTransaction(db, async () => {
    for (const table of ["meal_prep_tags", "meal_prep_ingredients"]) {
      await db.run(`UPDATE ${table} SET deleted_at = ?, updated_at = ? WHERE meal_prep_id = ? AND deleted_at IS NULL`, [nowMs, nowMs, id]);
    }
    await db.run("UPDATE meal_preps SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL", [nowMs, nowMs, id]);
  });
}

interface PrepRow {
  id: string;
  name: string;
  portions: number;
  fridge_days: number;
  freezer_days: number;
  thaw_hours: number;
  calories: number | null;
  protein_g: number | null;
  carbs_g: number | null;
  fat_g: number | null;
  notes: string | null;
}

async function tagsByPrep(db: SqlDriver, ids: string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (!ids.length) return out;
  const rows = await db.all<{ meal_prep_id: string; tag: string }>(
    `SELECT meal_prep_id, tag FROM meal_prep_tags
     WHERE deleted_at IS NULL AND meal_prep_id IN (${ids.map(() => "?").join(",")}) ORDER BY tag`,
    ids,
  );
  for (const r of rows) out.set(r.meal_prep_id, [...(out.get(r.meal_prep_id) ?? []), r.tag]);
  return out;
}

/** Live recipes, by name, optionally only those carrying a tag. */
export async function listMealPreps(db: SqlDriver, tag?: string | null): Promise<MealPrep[]> {
  const t = tag ? normalizeTag(tag) : null;
  const preps = await db.all<PrepRow>(
    `SELECT id, name, portions, fridge_days, freezer_days, thaw_hours, calories, protein_g, carbs_g, fat_g, notes
     FROM meal_preps p
     WHERE deleted_at IS NULL
       AND (? IS NULL OR EXISTS (SELECT 1 FROM meal_prep_tags t WHERE t.meal_prep_id = p.id AND t.tag = ? AND t.deleted_at IS NULL))
     ORDER BY name COLLATE NOCASE`,
    [t, t],
  );
  const ids = preps.map((p) => p.id);
  const tags = await tagsByPrep(db, ids);
  const ingredients = new Map<string, Required<Ingredient>[]>();
  if (ids.length) {
    const rows = await db.all<{ id: string; meal_prep_id: string; name: string; quantity: number | null; unit: string | null }>(
      `SELECT id, meal_prep_id, name, quantity, unit FROM meal_prep_ingredients
       WHERE deleted_at IS NULL AND meal_prep_id IN (${ids.map(() => "?").join(",")}) ORDER BY sort_order, rowid`,
      ids,
    );
    for (const r of rows) {
      ingredients.set(r.meal_prep_id, [...(ingredients.get(r.meal_prep_id) ?? []), { id: r.id, name: r.name, quantity: r.quantity, unit: r.unit }]);
    }
  }
  return preps.map((p) => ({
    id: p.id,
    name: p.name,
    portions: p.portions,
    fridgeDays: p.fridge_days,
    freezerDays: p.freezer_days,
    thawHours: p.thaw_hours,
    calories: p.calories,
    proteinG: p.protein_g,
    carbsG: p.carbs_g,
    fatG: p.fat_g,
    notes: p.notes,
    tags: tags.get(p.id) ?? [],
    ingredients: ingredients.get(p.id) ?? [],
  }));
}

/** Every tag in use on a live recipe, with how many recipes carry it. */
export async function listTags(db: SqlDriver): Promise<{ tag: string; recipes: number }[]> {
  return db.all(
    `SELECT t.tag, COUNT(*) AS recipes FROM meal_prep_tags t
     JOIN meal_preps p ON p.id = t.meal_prep_id AND p.deleted_at IS NULL
     WHERE t.deleted_at IS NULL GROUP BY t.tag ORDER BY t.tag`,
  );
}

export interface LogBatchInput {
  mealPrepId: string;
  /** Defaults to the recipe's portions. */
  portions?: number;
  /** Portions that go straight into the freezer. */
  frozen?: number;
  cookedAtMs?: number;
  timeZone: string;
  notes?: string | null;
}

/** Record a cooking session. Returns the batch id. */
export async function logBatch(db: SqlDriver, input: LogBatchInput): Promise<string> {
  const at = input.cookedAtMs ?? Date.now();
  const [prep] = await db.all<{ portions: number }>("SELECT portions FROM meal_preps WHERE id = ? AND deleted_at IS NULL", [input.mealPrepId]);
  if (!prep) throw new Error("That meal prep no longer exists");
  const portions = posInt(input.portions ?? prep.portions, "Portions");
  const frozen = posInt(input.frozen ?? 0, "Frozen portions", 0);
  if (frozen > portions) throw new Error(`Only ${portions} portions were made, cannot freeze ${frozen}`);

  const dev = await deviceId(db, at);
  const offset = tzOffsetMinutes(at, input.timeZone);
  const day = localDay(at, input.timeZone);
  const id = uuidv7(at);
  await inTransaction(db, async () => {
    await db.run(
      `INSERT INTO meal_prep_batches (id, meal_prep_id, cooked_at_ms, offset_min, local_day, portions, notes, created_at, updated_at, origin_device_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, input.mealPrepId, at, offset, day, portions, input.notes?.trim() || null, at, at, dev],
    );
    if (frozen > 0) {
      await db.run(
        `INSERT INTO meal_prep_moves (id, batch_id, at_ms, offset_min, local_day, kind, from_loc, portions, created_at, updated_at, origin_device_id)
         VALUES (?, ?, ?, ?, ?, 'freeze', 'fridge', ?, ?, ?, ?)`,
        [uuidv7(at), id, at, offset, day, frozen, at, at, dev],
      );
    }
  });
  return id;
}

/** Soft-delete a batch logged by mistake, with its moves and the food log rows they made. */
export async function deleteBatch(db: SqlDriver, batchId: string, nowMs: number = Date.now()): Promise<void> {
  await inTransaction(db, async () => {
    await db.run(
      `UPDATE food_entries SET deleted_at = ?, updated_at = ? WHERE deleted_at IS NULL
         AND id IN (SELECT food_entry_id FROM meal_prep_moves WHERE batch_id = ? AND deleted_at IS NULL)`,
      [nowMs, nowMs, batchId],
    );
    await db.run("UPDATE meal_prep_moves SET deleted_at = ?, updated_at = ? WHERE batch_id = ? AND deleted_at IS NULL", [nowMs, nowMs, batchId]);
    await db.run("UPDATE meal_prep_batches SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL", [nowMs, nowMs, batchId]);
  });
}

interface BatchRow {
  id: string;
  meal_prep_id: string;
  name: string;
  cooked_at_ms: number;
  local_day: string;
  portions: number;
  fridge_days: number;
  freezer_days: number;
  thaw_hours: number;
}

interface MoveRow {
  id: string;
  batch_id: string;
  at_ms: number;
  local_day: string;
  kind: MoveKind;
  from_loc: Location;
  portions: number;
}

const toMove = (r: MoveRow): Move => ({
  id: r.id,
  batchId: r.batch_id,
  atMs: r.at_ms,
  localDay: r.local_day,
  kind: r.kind,
  fromLoc: r.from_loc,
  portions: r.portions,
});

export type StockEntry = BatchStock & { lastMove: Move | null };

/**
 * Stock per batch, for batches that still have portions (unless includeFinished).
 * Recipe settings are read even from a deleted recipe, so its leftovers stay visible.
 */
export async function loadStock(
  db: SqlDriver,
  opts: { tag?: string | null; batchId?: string; includeFinished?: boolean } = {},
): Promise<StockEntry[]> {
  const t = opts.tag ? normalizeTag(opts.tag) : null;
  const batches = await db.all<BatchRow>(
    `SELECT b.id, b.meal_prep_id, p.name, b.cooked_at_ms, b.local_day, b.portions, p.fridge_days, p.freezer_days, p.thaw_hours
     FROM meal_prep_batches b
     JOIN meal_preps p ON p.id = b.meal_prep_id
     WHERE b.deleted_at IS NULL
       AND (? IS NULL OR b.id = ?)
       AND (? IS NULL OR EXISTS (SELECT 1 FROM meal_prep_tags t WHERE t.meal_prep_id = p.id AND t.tag = ? AND t.deleted_at IS NULL))
       AND (? = 1 OR b.portions > (SELECT COALESCE(SUM(m.portions), 0) FROM meal_prep_moves m
                                   WHERE m.batch_id = b.id AND m.deleted_at IS NULL AND m.kind IN ('eat','discard')))
     ORDER BY b.cooked_at_ms`,
    [opts.batchId ?? null, opts.batchId ?? null, t, t, opts.includeFinished ? 1 : 0],
  );
  if (!batches.length) return [];
  const ids = batches.map((b) => b.id);
  const moves = (
    await db.all<MoveRow>(
      `SELECT id, batch_id, at_ms, local_day, kind, from_loc, portions FROM meal_prep_moves
       WHERE deleted_at IS NULL AND batch_id IN (${ids.map(() => "?").join(",")}) ORDER BY at_ms, id`,
      ids,
    )
  ).map(toMove);
  const tags = await tagsByPrep(db, [...new Set(batches.map((b) => b.meal_prep_id))]);

  return batches.map((b) => {
    const info: BatchInfo = {
      id: b.id,
      mealPrepId: b.meal_prep_id,
      name: b.name,
      tags: tags.get(b.meal_prep_id) ?? [],
      cookedAtMs: b.cooked_at_ms,
      localDay: b.local_day,
      portions: b.portions,
      fridgeDays: b.fridge_days,
      freezerDays: b.freezer_days,
      thawHours: b.thaw_hours,
    };
    const own = moves.filter((m) => m.batchId === b.id);
    return { ...foldBatch(info, own), lastMove: own.at(-1) ?? null };
  });
}

export interface MoveInput {
  batchId: string;
  kind: MoveKind;
  /** Only needed for discard; freeze, eat come from the fridge and thaw from the freezer. */
  fromLoc?: Location;
  portions: number;
  atMs?: number;
  timeZone: string;
}

/**
 * Freeze, defrost, eat or throw out portions of a batch. Refuses more portions than are there.
 * Eating also writes a food log row (meal = prep) with the recipe's macros times the portions.
 */
export async function addMove(db: SqlDriver, input: MoveInput): Promise<string> {
  const at = input.atMs ?? Date.now();
  const portions = posInt(input.portions, "Portions");
  const fromLoc: Location = input.kind === "thaw" ? "freezer" : input.kind === "discard" ? (input.fromLoc ?? "fridge") : "fridge";
  const [stock] = await loadStock(db, { batchId: input.batchId, includeFinished: true });
  if (!stock) throw new Error("That batch no longer exists");
  const max = available(stock, input.kind, fromLoc);
  if (portions > max) {
    throw new Error(`Only ${max} portion${max === 1 ? "" : "s"} in the ${fromLoc}`);
  }

  const dev = await deviceId(db, at);
  const offset = tzOffsetMinutes(at, input.timeZone);
  const day = localDay(at, input.timeZone);
  const id = uuidv7(at);
  await inTransaction(db, async () => {
    let foodId: string | null = null;
    if (input.kind === "eat") {
      const [p] = await db.all<{ name: string; calories: number | null; protein_g: number | null; carbs_g: number | null; fat_g: number | null }>(
        "SELECT name, calories, protein_g, carbs_g, fat_g FROM meal_preps WHERE id = ?",
        [stock.batch.mealPrepId],
      );
      const times = (v: number | null) => (v === null ? null : v * portions);
      foodId = uuidv7(at);
      await db.run(
        `INSERT INTO food_entries (id, eaten_at_ms, offset_min, local_day, name, meal, calories, protein_g, carbs_g, fat_g, notes,
           created_at, updated_at, origin_device_id)
         VALUES (?, ?, ?, ?, ?, 'prep', ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          foodId,
          at,
          offset,
          day,
          p.name,
          times(p.calories),
          times(p.protein_g),
          times(p.carbs_g),
          times(p.fat_g),
          portions === 1 ? null : `${portions} portions`,
          at,
          at,
          dev,
        ],
      );
    }
    await db.run(
      `INSERT INTO meal_prep_moves (id, batch_id, at_ms, offset_min, local_day, kind, from_loc, portions, food_entry_id,
         created_at, updated_at, origin_device_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, input.batchId, at, offset, day, input.kind, fromLoc, portions, foodId, at, at, dev],
    );
  });
  return id;
}

/**
 * Undo a move (soft delete, plus its food log row). Refused when later moves depend on it,
 * for example undoing a defrost after one of the defrosted portions was eaten.
 */
export async function undoMove(db: SqlDriver, moveId: string, nowMs: number = Date.now()): Promise<void> {
  const [row] = await db.all<{ batch_id: string; food_entry_id: string | null }>(
    "SELECT batch_id, food_entry_id FROM meal_prep_moves WHERE id = ? AND deleted_at IS NULL",
    [moveId],
  );
  if (!row) throw new Error("Nothing to undo");
  const [stock] = await loadStock(db, { batchId: row.batch_id, includeFinished: true });
  const rest = (
    await db.all<MoveRow>(
      "SELECT id, batch_id, at_ms, local_day, kind, from_loc, portions FROM meal_prep_moves WHERE batch_id = ? AND deleted_at IS NULL AND id <> ?",
      [row.batch_id, moveId],
    )
  ).map(toMove);
  if (stock && foldBatch(stock.batch, rest).overdrawn > 0) {
    throw new Error("Later changes to this batch depend on it. Undo those first.");
  }
  await inTransaction(db, async () => {
    await db.run("UPDATE meal_prep_moves SET deleted_at = ?, updated_at = ? WHERE id = ?", [nowMs, nowMs, moveId]);
    if (row.food_entry_id) {
      await db.run("UPDATE food_entries SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL", [nowMs, nowMs, row.food_entry_id]);
    }
  });
}

/** Prep portions eaten on a local day, optionally only recipes with a tag. */
export async function portionsEatenOn(db: SqlDriver, day: string, tag?: string | null): Promise<number> {
  const t = tag ? normalizeTag(tag) : null;
  const [r] = await db.all<{ n: number | null }>(
    `SELECT SUM(m.portions) AS n FROM meal_prep_moves m
     JOIN meal_prep_batches b ON b.id = m.batch_id AND b.deleted_at IS NULL
     WHERE m.deleted_at IS NULL AND m.kind = 'eat' AND m.local_day = ?
       AND (? IS NULL OR EXISTS (SELECT 1 FROM meal_prep_tags t WHERE t.meal_prep_id = b.meal_prep_id AND t.tag = ? AND t.deleted_at IS NULL))`,
    [day, t, t],
  );
  return r?.n ?? 0;
}

/** Planned prep portions per day, kept per tag filter ("all" when none). Default 1. */
const perDayKey = (tag?: string | null) => `meal_prep.portions_per_day.${tag ? normalizeTag(tag) : "all"}`;

export async function getPortionsPerDay(db: SqlDriver, tag?: string | null): Promise<number> {
  const raw = await getSetting(db, perDayKey(tag));
  const v = raw === null ? NaN : Number(raw);
  return Number.isInteger(v) && v >= 0 ? v : 1;
}

export async function setPortionsPerDay(db: SqlDriver, n: number, tag?: string | null, nowMs: number = Date.now()): Promise<void> {
  await setSetting(db, perDayKey(tag), String(posInt(n, "Portions per day", 0)), nowMs);
}
