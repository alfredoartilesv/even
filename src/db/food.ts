import { addDays, localDay, tzOffsetMinutes } from "../lib/tz";
import { uuidv7 } from "../lib/uuidv7";
import { mealForHour, rankSuggestions, type Candidate, type Meal } from "../meals/suggest";
import type { SqlDriver, SqlValue } from "./driver";
import { undoMove } from "./mealPrep";
import { deviceId } from "./settings";

/** Food log, saved meals with photos, the daily calorie goal (schema 0004). */

export interface Macros {
  calories: number | null;
  proteinG: number | null;
  carbsG: number | null;
  fatG: number | null;
}

export interface FoodInput extends Macros {
  name: string;
  meal: Meal | null;
  notes?: string | null;
  savedMealId?: string | null;
  atMs?: number;
  timeZone: string;
}

export interface FoodEntry extends Macros {
  id: string;
  eatenAtMs: number;
  localDay: string;
  name: string;
  meal: Meal | null;
  notes: string | null;
  savedMealId: string | null;
  /** Photo of the saved meal it was logged from, if that meal still has one. */
  photoId: string | null;
  /** Logged by eating a meal prep portion: deleting it undoes that move. */
  fromPrep: boolean;
}

export interface PhotoInput {
  mime: "image/jpeg" | "image/webp";
  dataB64: string;
  width: number | null;
  height: number | null;
}

/** Downsized photos are ~50 to 150 kB. Anything this big was not downsized. */
export const MAX_PHOTO_BYTES = 1_500_000;

const ENTRY_COLS = `e.id, e.eaten_at_ms, e.local_day, e.name, e.meal, e.calories, e.protein_g, e.carbs_g, e.fat_g, e.notes,
  e.saved_meal_id, s.photo_id AS photo_id,
  EXISTS (SELECT 1 FROM meal_prep_moves m WHERE m.food_entry_id = e.id AND m.deleted_at IS NULL) AS from_prep`;
const ENTRY_FROM = `food_entries e
  LEFT JOIN saved_meals s ON s.id = e.saved_meal_id AND s.deleted_at IS NULL`;

interface EntryRow {
  id: string;
  eaten_at_ms: number;
  local_day: string;
  name: string;
  meal: Meal | null;
  calories: number | null;
  protein_g: number | null;
  carbs_g: number | null;
  fat_g: number | null;
  notes: string | null;
  saved_meal_id: string | null;
  photo_id: string | null;
  from_prep: number;
}

const toEntry = (r: EntryRow): FoodEntry => ({
  id: r.id,
  eatenAtMs: r.eaten_at_ms,
  localDay: r.local_day,
  name: r.name,
  meal: r.meal,
  calories: r.calories,
  proteinG: r.protein_g,
  carbsG: r.carbs_g,
  fatG: r.fat_g,
  notes: r.notes,
  savedMealId: r.saved_meal_id,
  photoId: r.photo_id,
  fromPrep: r.from_prep === 1,
});

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

const MACRO_LABELS: [keyof Macros, string][] = [
  ["calories", "Calories"],
  ["proteinG", "Protein"],
  ["carbsG", "Carbs"],
  ["fatG", "Fat"],
];

function checkMacros(m: Macros): void {
  for (const [k, label] of MACRO_LABELS) {
    const v = m[k];
    if (v !== null && !(Number.isFinite(v) && v >= 0)) throw new Error(`${label} must be a number of 0 or more`);
  }
}

const scale = (v: number | null, k: number) => (v === null ? null : Math.round(v * k * 10) / 10);

/** Local hour 0 to 23 of an instant in a zone. */
export const localHour = (ms: number, timeZone: string) =>
  Number(new Intl.DateTimeFormat("en-GB", { hour: "numeric", hourCycle: "h23", timeZone }).format(ms));

export async function logFood(db: SqlDriver, f: FoodInput): Promise<string> {
  const name = f.name.trim();
  if (!name) throw new Error("Give the meal a name");
  checkMacros(f);
  const at = f.atMs ?? Date.now();
  const id = uuidv7(at);
  await db.run(
    `INSERT INTO food_entries (id, eaten_at_ms, offset_min, local_day, name, meal, calories, protein_g, carbs_g, fat_g, notes, saved_meal_id,
       created_at, updated_at, origin_device_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      at,
      tzOffsetMinutes(at, f.timeZone),
      localDay(at, f.timeZone),
      name,
      f.meal,
      f.calories,
      f.proteinG,
      f.carbsG,
      f.fatG,
      f.notes?.trim() || null,
      f.savedMealId ?? null,
      at,
      at,
      await deviceId(db, at),
    ],
  );
  return id;
}

/** Edit name, slot, macros and notes of an entry. The time stays. */
export async function updateFood(db: SqlDriver, id: string, f: Omit<FoodInput, "atMs" | "timeZone" | "savedMealId">, nowMs: number = Date.now()): Promise<void> {
  const name = f.name.trim();
  if (!name) throw new Error("Give the meal a name");
  checkMacros(f);
  await db.run(
    `UPDATE food_entries SET name = ?, meal = ?, calories = ?, protein_g = ?, carbs_g = ?, fat_g = ?, notes = ?, updated_at = ?
     WHERE id = ? AND deleted_at IS NULL`,
    [name, f.meal, f.calories, f.proteinG, f.carbsG, f.fatG, f.notes?.trim() || null, nowMs, id],
  );
}

/** Delete an entry. One made by eating a meal prep portion undoes that move, so the portion is back in stock. */
export async function deleteFood(db: SqlDriver, id: string, nowMs: number = Date.now()): Promise<void> {
  const [move] = await db.all<{ id: string }>("SELECT id FROM meal_prep_moves WHERE food_entry_id = ? AND deleted_at IS NULL", [id]);
  if (move) return undoMove(db, move.id, nowMs);
  await db.run("UPDATE food_entries SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL", [nowMs, nowMs, id]);
}

/** Log the same thing again, now. */
export async function relogFood(db: SqlDriver, entryId: string, opts: { atMs?: number; timeZone: string }): Promise<string> {
  const [e] = await db.all<EntryRow>(`SELECT ${ENTRY_COLS} FROM ${ENTRY_FROM} WHERE e.id = ?`, [entryId]);
  if (!e) throw new Error("That entry no longer exists");
  const at = opts.atMs ?? Date.now();
  return logFood(db, {
    name: e.name,
    // A meal prep portion logged again is a normal meal: the stock is not touched.
    meal: e.meal === "prep" ? mealForHour(localHour(at, opts.timeZone)) : e.meal,
    calories: e.calories,
    proteinG: e.protein_g,
    carbsG: e.carbs_g,
    fatG: e.fat_g,
    savedMealId: e.saved_meal_id,
    atMs: at,
    timeZone: opts.timeZone,
  });
}

export async function dayFood(db: SqlDriver, day: string): Promise<FoodEntry[]> {
  const rows = await db.all<EntryRow>(
    `SELECT ${ENTRY_COLS} FROM ${ENTRY_FROM} WHERE e.local_day = ? AND e.deleted_at IS NULL ORDER BY e.eaten_at_ms, e.id`,
    [day],
  );
  return rows.map(toEntry);
}

export interface DayTotals extends Macros {
  day: string;
  entries: number;
}

/** One row per calendar day from..to (inclusive), zeros for days with nothing logged. */
export async function nutritionRange(db: SqlDriver, from: string, to: string): Promise<DayTotals[]> {
  const rows = await db.all<{ local_day: string; entries: number; calories: number | null; protein_g: number | null; carbs_g: number | null; fat_g: number | null }>(
    "SELECT local_day, entries, calories, protein_g, carbs_g, fat_g FROM daily_nutrition WHERE local_day BETWEEN ? AND ?",
    [from, to],
  );
  const by = new Map(rows.map((r) => [r.local_day, r]));
  const out: DayTotals[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) {
    const r = by.get(d);
    out.push({
      day: d,
      entries: r?.entries ?? 0,
      calories: r?.calories ?? null,
      proteinG: r?.protein_g ?? null,
      carbsG: r?.carbs_g ?? null,
      fatG: r?.fat_g ?? null,
    });
  }
  return out;
}

/** The newest days that have food logged, before (not including) a day. For paging the history. */
export async function loggedDaysBefore(db: SqlDriver, before: string, limit = 30): Promise<string[]> {
  const rows = await db.all<{ local_day: string }>(
    "SELECT local_day FROM daily_nutrition WHERE local_day < ? ORDER BY local_day DESC LIMIT ?",
    [before, limit],
  );
  return rows.map((r) => r.local_day);
}

// ---- Calorie goal: one live row in goals (target_kind food, metric calories, per day). ----

export interface CalorieGoal {
  id: string;
  target: number;
  startDay: string;
}

export async function getCalorieGoal(db: SqlDriver): Promise<CalorieGoal | null> {
  const [g] = await db.all<{ id: string; target_num: number; start_day: string }>(
    `SELECT id, target_num, start_day FROM goals
     WHERE deleted_at IS NULL AND target_kind = 'food' AND metric = 'calories' AND period = 'day'
     ORDER BY start_day DESC, created_at DESC LIMIT 1`,
  );
  return g ? { id: g.id, target: g.target_num, startDay: g.start_day } : null;
}

/** Set (or with null, remove) the daily calorie target. The previous goal ends the day before. */
export async function setCalorieGoal(db: SqlDriver, target: number | null, today: string, nowMs: number = Date.now()): Promise<void> {
  if (target !== null && !(Number.isFinite(target) && target > 0)) throw new Error("The calorie target must be more than 0");
  const current = await getCalorieGoal(db);
  if (current && target !== null && current.target === target) return;
  const dev = await deviceId(db, nowMs);
  await inTransaction(db, async () => {
    if (current) {
      // Keep the old target as history unless it only started today.
      if (current.startDay >= today) {
        await db.run("UPDATE goals SET deleted_at = ?, updated_at = ? WHERE id = ?", [nowMs, nowMs, current.id]);
      } else {
        await db.run("UPDATE goals SET end_day = ?, deleted_at = ?, updated_at = ? WHERE id = ?", [addDays(today, -1), nowMs, nowMs, current.id]);
      }
    }
    if (target !== null) {
      await db.run(
        `INSERT INTO goals (id, title, target_kind, metric, comparator, target_num, unit, period, start_day, created_at, updated_at, origin_device_id)
         VALUES (?, 'Daily calories', 'food', 'calories', '<=', ?, 'kcal', 'day', ?, ?, ?, ?)`,
        [uuidv7(nowMs), target, today, nowMs, nowMs, dev],
      );
    }
  });
}

// ---- Saved meals and photos ----

export interface SavedMealInput extends Macros {
  id?: string;
  name: string;
  meal: Meal | null;
  notes?: string | null;
  /** undefined keeps the current photo, null removes it. */
  photo?: PhotoInput | null;
}

export interface SavedMeal extends Macros {
  id: string;
  name: string;
  meal: Meal | null;
  notes: string | null;
  photoId: string | null;
  /** Times logged, ever, and the last time. */
  uses: number;
  lastMs: number | null;
}

function photoBytes(b64: string): number {
  const pad = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
  return Math.floor((b64.length * 3) / 4) - pad;
}

async function insertPhoto(db: SqlDriver, p: PhotoInput, nowMs: number, dev: string): Promise<string> {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(p.dataB64)) throw new Error("The photo is not valid image data");
  const bytes = photoBytes(p.dataB64);
  if (bytes > MAX_PHOTO_BYTES) throw new Error("The photo is too large");
  const id = uuidv7(nowMs);
  await db.run(
    `INSERT INTO food_photos (id, mime, data_b64, width, height, bytes, created_at, updated_at, origin_device_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, p.mime, p.dataB64, p.width, p.height, bytes, nowMs, nowMs, dev],
  );
  return id;
}

const softDeletePhoto = (db: SqlDriver, id: string, nowMs: number) =>
  db.run("UPDATE food_photos SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL", [nowMs, nowMs, id]);

/** Create or update a saved meal. Returns its id. */
export async function saveMeal(db: SqlDriver, m: SavedMealInput, nowMs: number = Date.now()): Promise<string> {
  const name = m.name.trim();
  if (!name) throw new Error("Give the meal a name");
  checkMacros(m);
  const dev = await deviceId(db, nowMs);
  return inTransaction(db, async () => {
    const [existing] = m.id
      ? await db.all<{ photo_id: string | null }>("SELECT photo_id FROM saved_meals WHERE id = ? AND deleted_at IS NULL", [m.id])
      : [];
    if (m.id && !existing) throw new Error("That saved meal no longer exists");
    let photoId = existing?.photo_id ?? null;
    if (m.photo !== undefined) {
      if (photoId) await softDeletePhoto(db, photoId, nowMs);
      photoId = m.photo ? await insertPhoto(db, m.photo, nowMs, dev) : null;
    }
    const cols: SqlValue[] = [name, m.meal, m.calories, m.proteinG, m.carbsG, m.fatG, m.notes?.trim() || null, photoId];
    if (m.id) {
      await db.run(
        `UPDATE saved_meals SET name = ?, meal = ?, calories = ?, protein_g = ?, carbs_g = ?, fat_g = ?, notes = ?, photo_id = ?, updated_at = ?
         WHERE id = ?`,
        [...cols, nowMs, m.id],
      );
      return m.id;
    }
    const id = uuidv7(nowMs);
    await db.run(
      `INSERT INTO saved_meals (id, name, meal, calories, protein_g, carbs_g, fat_g, notes, photo_id, created_at, updated_at, origin_device_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, ...cols, nowMs, nowMs, dev],
    );
    return id;
  });
}

/**
 * Bookmark a logged meal. Earlier entries with the same name that are not linked to a
 * saved meal get linked too, so the saved meal starts with its real history of uses.
 */
export async function saveEntryAsMeal(db: SqlDriver, entryId: string, photo?: PhotoInput | null, nowMs: number = Date.now()): Promise<string> {
  const [e] = await db.all<EntryRow>(`SELECT ${ENTRY_COLS} FROM ${ENTRY_FROM} WHERE e.id = ? AND e.deleted_at IS NULL`, [entryId]);
  if (!e) throw new Error("That entry no longer exists");
  const existing = e.saved_meal_id ? await getSavedMeal(db, e.saved_meal_id) : null;
  if (existing) {
    if (photo !== undefined) await saveMeal(db, { ...existing, photo }, nowMs);
    return existing.id;
  }
  const id = await saveMeal(
    db,
    { name: e.name, meal: e.meal, calories: e.calories, proteinG: e.protein_g, carbsG: e.carbs_g, fatG: e.fat_g, notes: e.notes, photo: photo ?? null },
    nowMs,
  );
  await db.run(
    `UPDATE food_entries SET saved_meal_id = ?, updated_at = ?
     WHERE deleted_at IS NULL AND lower(trim(name)) = lower(trim(?))
       AND (saved_meal_id IS NULL OR saved_meal_id IN (SELECT id FROM saved_meals WHERE deleted_at IS NOT NULL))`,
    [id, nowMs, e.name],
  );
  return id;
}

/** Remove a bookmark and its photo. Logged entries stay in the history. */
export async function deleteSavedMeal(db: SqlDriver, id: string, nowMs: number = Date.now()): Promise<void> {
  await inTransaction(db, async () => {
    const [m] = await db.all<{ photo_id: string | null }>("SELECT photo_id FROM saved_meals WHERE id = ? AND deleted_at IS NULL", [id]);
    if (!m) return;
    if (m.photo_id) await softDeletePhoto(db, m.photo_id, nowMs);
    await db.run("UPDATE saved_meals SET deleted_at = ?, updated_at = ? WHERE id = ?", [nowMs, nowMs, id]);
  });
}

interface SavedRow {
  id: string;
  name: string;
  meal: Meal | null;
  calories: number | null;
  protein_g: number | null;
  carbs_g: number | null;
  fat_g: number | null;
  notes: string | null;
  photo_id: string | null;
  uses: number;
  last_ms: number | null;
}

const SAVED_SELECT = `SELECT s.id, s.name, s.meal, s.calories, s.protein_g, s.carbs_g, s.fat_g, s.notes, s.photo_id,
    (SELECT COUNT(*) FROM food_entries e WHERE e.saved_meal_id = s.id AND e.deleted_at IS NULL) AS uses,
    (SELECT MAX(eaten_at_ms) FROM food_entries e WHERE e.saved_meal_id = s.id AND e.deleted_at IS NULL) AS last_ms
  FROM saved_meals s WHERE s.deleted_at IS NULL`;

const toSaved = (r: SavedRow): SavedMeal => ({
  id: r.id,
  name: r.name,
  meal: r.meal,
  calories: r.calories,
  proteinG: r.protein_g,
  carbsG: r.carbs_g,
  fatG: r.fat_g,
  notes: r.notes,
  photoId: r.photo_id,
  uses: r.uses,
  lastMs: r.last_ms,
});

/** Saved meals, most used first. */
export async function listSavedMeals(db: SqlDriver): Promise<SavedMeal[]> {
  return (await db.all<SavedRow>(`${SAVED_SELECT} ORDER BY uses DESC, last_ms DESC, s.name COLLATE NOCASE`)).map(toSaved);
}

export async function getSavedMeal(db: SqlDriver, id: string): Promise<SavedMeal | null> {
  const [r] = await db.all<SavedRow>(`${SAVED_SELECT} AND s.id = ?`, [id]);
  return r ? toSaved(r) : null;
}

/** Log a saved meal, scaled by servings. */
export async function logSavedMeal(db: SqlDriver, id: string, opts: { servings?: number; meal?: Meal | null; atMs?: number; timeZone: string }): Promise<string> {
  const m = await getSavedMeal(db, id);
  if (!m) throw new Error("That saved meal no longer exists");
  const k = opts.servings ?? 1;
  if (!(k > 0)) throw new Error("Servings must be more than 0");
  return logFood(db, {
    name: m.name,
    meal: opts.meal !== undefined ? opts.meal : m.meal,
    calories: scale(m.calories, k),
    proteinG: scale(m.proteinG, k),
    carbsG: scale(m.carbsG, k),
    fatG: scale(m.fatG, k),
    notes: k === 1 ? null : `${k} servings`,
    savedMealId: id,
    atMs: opts.atMs,
    timeZone: opts.timeZone,
  });
}

/** A photo as a data: URL for an <img>, or null if it is gone. */
export async function photoDataUrl(db: SqlDriver, id: string): Promise<string | null> {
  const [p] = await db.all<{ mime: string; data_b64: string }>("SELECT mime, data_b64 FROM food_photos WHERE id = ? AND deleted_at IS NULL", [id]);
  return p ? `data:${p.mime};base64,${p.data_b64}` : null;
}

// ---- Suggestions: what you eat again and again ----

const LOOKBACK_DAYS = 30;

/**
 * Meals to offer for one-tap logging now: saved meals, plus anything not saved that was
 * logged at least twice in the last 30 days (meal prep portions excluded, they come from stock).
 */
export async function suggestions(db: SqlDriver, opts: { nowMs?: number; timeZone: string; limit?: number }): Promise<Candidate[]> {
  const now = opts.nowMs ?? Date.now();
  const today = localDay(now, opts.timeZone);
  const since = addDays(today, -LOOKBACK_DAYS);
  const hour = localHour(now, opts.timeZone);

  const recent = await db.all<{ id: string; name: string; meal: Meal | null; calories: number | null; saved_meal_id: string | null; eaten_at_ms: number; local_day: string }>(
    `SELECT e.id, e.name, e.meal, e.calories, s.id AS saved_meal_id, e.eaten_at_ms, e.local_day
     FROM food_entries e LEFT JOIN saved_meals s ON s.id = e.saved_meal_id AND s.deleted_at IS NULL
     WHERE e.deleted_at IS NULL AND e.local_day >= ? AND COALESCE(e.meal, '') <> 'prep'
     ORDER BY e.eaten_at_ms`,
    [since],
  );
  const saved = await listSavedMeals(db);

  const cands = new Map<string, Candidate>();
  for (const s of saved) {
    cands.set(`saved:${s.id}`, {
      key: `saved:${s.id}`,
      savedMealId: s.id,
      lastEntryId: null,
      name: s.name,
      calories: s.calories,
      photoId: s.photoId,
      uses: 0,
      lastMs: s.lastMs,
      slots: {},
      defaultMeal: s.meal,
      loggedToday: false,
    });
  }
  for (const e of recent) {
    const key = e.saved_meal_id ? `saved:${e.saved_meal_id}` : `name:${e.name.trim().toLowerCase()}`;
    let c = cands.get(key);
    if (!c) {
      c = { key, savedMealId: null, lastEntryId: null, name: e.name, calories: e.calories, photoId: null, uses: 0, lastMs: null, slots: {}, defaultMeal: null, loggedToday: false };
      cands.set(key, c);
    }
    c.uses++;
    c.lastMs = Math.max(c.lastMs ?? 0, e.eaten_at_ms);
    if (!c.savedMealId) {
      // Unsaved: show the newest name and calories.
      c.lastEntryId = e.id;
      c.name = e.name;
      c.calories = e.calories;
    }
    if (e.meal) c.slots[e.meal] = (c.slots[e.meal] ?? 0) + 1;
    if (e.local_day === today) c.loggedToday = true;
  }
  const pool = [...cands.values()].filter((c) => c.savedMealId || c.uses >= 2);
  return rankSuggestions(pool, mealForHour(hour), now, opts.limit ?? 8);
}
