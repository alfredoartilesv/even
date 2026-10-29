import { alcoholGrams, alcoholKcal, KCAL_PER_KG_BODY, standardDrinks, weightWithoutKcal } from "../../core/health";
import { createLogger } from "../../core/log";
import { addDays, localDay, tzOffsetMinutes } from "../../core/tz";
import { uuidv7 } from "../../core/uuidv7";
import type { SqlDriver } from "../../db/driver";
import { deviceId, getSetting, setSetting } from "../../db/settings";
import { withTransaction } from "../../db/tx";

/**
 * Alcohol counter (schema 0006): drink types with price and calories, the drink log, totals in
 * alcohol, kcal and money, and the weight the owner would be at without those kcal.
 */

const log = createLogger("alcohol");

export type CreatedBy = "user" | "assistant";

export interface DrinkTypeInput {
  id?: string;
  name: string;
  volumeMl: number;
  abvPercent: number;
  /** kcal per serving from the label; null = estimate from the alcohol. */
  calories: number | null;
  /** Per serving, in the app currency; null = unknown. */
  price: number | null;
}

export interface DrinkType extends Required<DrinkTypeInput> {
  createdBy: CreatedBy;
  /** Drinks logged with this type, ever, and the last time. */
  uses: number;
  lastMs: number | null;
}

/** kcal of one serving: the label value, else 7 kcal per gram of alcohol. */
export const servingKcal = (t: Pick<DrinkTypeInput, "volumeMl" | "abvPercent" | "calories">) => t.calories ?? Math.round(alcoholKcal(t.volumeMl, t.abvPercent));

function check(t: DrinkTypeInput): void {
  if (!t.name.trim()) throw new Error("Give the drink a name");
  if (!(t.volumeMl > 0 && t.volumeMl <= 3000)) throw new Error("Volume must be between 1 and 3000 ml");
  if (!(t.abvPercent >= 0 && t.abvPercent <= 100)) throw new Error("ABV must be between 0 and 100 %");
  if (t.calories !== null && !(t.calories >= 0 && t.calories <= 3000)) throw new Error("Calories must be between 0 and 3000");
  if (t.price !== null && !(t.price >= 0 && t.price <= 10_000)) throw new Error("Price must be 0 or more");
}

interface TypeRow {
  id: string;
  name: string;
  volume_ml: number;
  abv_percent: number;
  calories: number | null;
  price: number | null;
  created_by: CreatedBy;
  uses: number;
  last_ms: number | null;
}

const TYPE_SELECT = `SELECT t.id, t.name, t.volume_ml, t.abv_percent, t.calories, t.price, t.created_by,
    (SELECT COUNT(*) FROM drink_entries e WHERE e.drink_type_id = t.id AND e.deleted_at IS NULL) AS uses,
    (SELECT MAX(drunk_at_ms) FROM drink_entries e WHERE e.drink_type_id = t.id AND e.deleted_at IS NULL) AS last_ms
  FROM drink_types t WHERE t.deleted_at IS NULL`;

const toType = (r: TypeRow): DrinkType => ({
  id: r.id,
  name: r.name,
  volumeMl: r.volume_ml,
  abvPercent: r.abv_percent,
  calories: r.calories,
  price: r.price,
  createdBy: r.created_by,
  uses: r.uses,
  lastMs: r.last_ms,
});

/** Live drink types, most used first. */
export async function listDrinkTypes(db: SqlDriver): Promise<DrinkType[]> {
  return (await db.all<TypeRow>(`${TYPE_SELECT} ORDER BY uses DESC, last_ms DESC, t.name COLLATE NOCASE`)).map(toType);
}

async function getDrinkType(db: SqlDriver, id: string): Promise<DrinkType | null> {
  const [r] = await db.all<TypeRow>(`${TYPE_SELECT} AND t.id = ?`, [id]);
  return r ? toType(r) : null;
}

/** By name, ignoring case and surrounding spaces. */
export async function findDrinkType(db: SqlDriver, name: string): Promise<DrinkType | null> {
  const [r] = await db.all<TypeRow>(`${TYPE_SELECT} AND lower(t.name) = lower(?)`, [name.trim()]);
  return r ? toType(r) : null;
}

/** Create or update a drink type. Names are unique (case-insensitive) among live types. */
export async function saveDrinkType(db: SqlDriver, t: DrinkTypeInput, opts: { createdBy?: CreatedBy; nowMs?: number } = {}): Promise<string> {
  check(t);
  const now = opts.nowMs ?? Date.now();
  const name = t.name.trim();
  const clash = await findDrinkType(db, name);
  if (clash && clash.id !== t.id) throw new Error(`There is already a drink called ${clash.name}`);
  const vals = [name, t.volumeMl, t.abvPercent, t.calories, t.price];
  if (t.id) {
    await db.run(
      "UPDATE drink_types SET name = ?, volume_ml = ?, abv_percent = ?, calories = ?, price = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL",
      [...vals, now, t.id],
    );
    log.info("drink type updated", { id: t.id, hasCalories: t.calories !== null, hasPrice: t.price !== null });
    return t.id;
  }
  const id = uuidv7(now);
  await db.run(
    `INSERT INTO drink_types (id, name, volume_ml, abv_percent, calories, price, created_by, created_at, updated_at, origin_device_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, ...vals, opts.createdBy ?? "user", now, now, await deviceId(db, now)],
  );
  log.info("drink type created", { id, by: opts.createdBy ?? "user", hasCalories: t.calories !== null, hasPrice: t.price !== null });
  return id;
}

/** Remove a type. Drinks already logged keep their own kcal and price. */
export async function deleteDrinkType(db: SqlDriver, id: string, nowMs: number = Date.now()): Promise<void> {
  await db.run("UPDATE drink_types SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL", [nowMs, nowMs, id]);
  log.info("drink type deleted", { id });
}

// ---- The drink log ----

export interface LogDrinkInput {
  /** Log a saved type; its size, ABV, kcal and price are the defaults. */
  typeId?: string | null;
  /** Without a type: what it was. */
  name?: string;
  volumeMl?: number;
  abvPercent?: number;
  /** Per drink; override the type's values. */
  calories?: number | null;
  price?: number | null;
  /** Same drink several times (1 to 20). */
  count?: number;
  notes?: string | null;
  atMs?: number;
  timeZone: string;
  createdBy?: CreatedBy;
}

/** Log one or more drinks. Returns the new entry ids (one per drink). */
export async function logDrink(db: SqlDriver, d: LogDrinkInput): Promise<string[]> {
  const type = d.typeId ? await getDrinkType(db, d.typeId) : null;
  if (d.typeId && !type) throw new Error("That drink type no longer exists");
  const t: DrinkTypeInput = {
    name: d.name?.trim() || type?.name || "",
    volumeMl: d.volumeMl ?? type?.volumeMl ?? NaN,
    abvPercent: d.abvPercent ?? type?.abvPercent ?? NaN,
    calories: d.calories !== undefined ? d.calories : (type?.calories ?? null),
    price: d.price !== undefined ? d.price : (type?.price ?? null),
  };
  check(t);
  const count = d.count ?? 1;
  if (!Number.isInteger(count) || count < 1 || count > 20) throw new Error("Log between 1 and 20 drinks at a time");

  const at = d.atMs ?? Date.now();
  const offset = tzOffsetMinutes(at, d.timeZone);
  const day = localDay(at, d.timeZone);
  const dev = await deviceId(db, at);
  const ids: string[] = [];
  await withTransaction(db, async () => {
    for (let i = 0; i < count; i++) {
      const id = uuidv7(at);
      await db.run(
        `INSERT INTO drink_entries (id, drunk_at_ms, offset_min, local_day, name, volume_ml, abv_percent, notes, drink_type_id, calories, price,
           created_by, created_at, updated_at, origin_device_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          at,
          offset,
          day,
          t.name,
          t.volumeMl,
          t.abvPercent,
          d.notes?.trim() || null,
          type?.id ?? null,
          t.calories,
          t.price,
          d.createdBy ?? "user",
          at,
          at,
          dev,
        ],
      );
      ids.push(id);
    }
  });
  log.info("drinks logged", { count, typed: Boolean(type), by: d.createdBy ?? "user", hasPrice: t.price !== null });
  return ids;
}

export async function deleteDrink(db: SqlDriver, id: string, nowMs: number = Date.now()): Promise<void> {
  await db.run("UPDATE drink_entries SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL", [nowMs, nowMs, id]);
  log.info("drink deleted", { id });
}

export interface DrinkEntry {
  id: string;
  drunkAtMs: number;
  localDay: string;
  name: string;
  volumeMl: number;
  abvPercent: number;
  alcoholG: number;
  kcal: number;
  kcalEstimated: boolean;
  price: number | null;
  typeId: string | null;
  notes: string | null;
}

/** Drinks from..to (local days, inclusive), newest first. */
export async function listDrinks(db: SqlDriver, from: string, to: string): Promise<DrinkEntry[]> {
  const rows = await db.all<{
    id: string;
    drunk_at_ms: number;
    local_day: string;
    name: string;
    volume_ml: number;
    abv_percent: number;
    calories: number | null;
    price: number | null;
    drink_type_id: string | null;
    notes: string | null;
  }>(
    `SELECT id, drunk_at_ms, local_day, name, volume_ml, abv_percent, calories, price, drink_type_id, notes FROM drink_entries
     WHERE deleted_at IS NULL AND local_day BETWEEN ? AND ? ORDER BY drunk_at_ms DESC, id DESC`,
    [from, to],
  );
  return rows.map((r) => ({
    id: r.id,
    drunkAtMs: r.drunk_at_ms,
    localDay: r.local_day,
    name: r.name,
    volumeMl: r.volume_ml,
    abvPercent: r.abv_percent,
    alcoholG: alcoholGrams(r.volume_ml, r.abv_percent),
    kcal: r.calories ?? alcoholKcal(r.volume_ml, r.abv_percent),
    kcalEstimated: r.calories === null,
    price: r.price,
    typeId: r.drink_type_id,
    notes: r.notes,
  }));
}

export interface AlcoholTotals {
  from: string;
  to: string;
  days: number;
  drinks: number;
  drinkingDays: number;
  alcoholG: number;
  /** Spanish standard drinks (10 g). */
  standardDrinks: number;
  kcal: number;
  /** Drinks whose kcal came from the alcohol estimate (no label value). */
  kcalEstimated: number;
  money: number;
  /** Drinks with a price; money only counts these. */
  priced: number;
}

export async function alcoholTotals(db: SqlDriver, from: string, to: string): Promise<AlcoholTotals> {
  const [r] = await db.all<{
    drinks: number | null;
    days: number;
    alcohol_g: number | null;
    calories: number | null;
    est: number | null;
    price: number | null;
    priced: number | null;
  }>(
    `SELECT SUM(drinks) AS drinks, COUNT(*) AS days, SUM(alcohol_g) AS alcohol_g, SUM(calories) AS calories,
            SUM(calories_estimated) AS est, SUM(price) AS price, SUM(priced) AS priced
     FROM daily_alcohol WHERE local_day BETWEEN ? AND ?`,
    [from, to],
  );
  const g = r?.alcohol_g ?? 0;
  let days = 0;
  for (let d = from; d <= to; d = addDays(d, 1)) days++;
  return {
    from,
    to,
    days,
    drinks: r?.drinks ?? 0,
    drinkingDays: r?.days ?? 0,
    alcoholG: g,
    standardDrinks: standardDrinks(g),
    kcal: r?.calories ?? 0,
    kcalEstimated: r?.est ?? 0,
    money: r?.price ?? 0,
    priced: r?.priced ?? 0,
  };
}

/** kcal from drinks per local day, for adding to the food calorie tracker. */
export async function drinkKcalByDay(db: SqlDriver, from: string, to: string): Promise<Map<string, number>> {
  const rows = await db.all<{ local_day: string; calories: number }>("SELECT local_day, calories FROM daily_alcohol WHERE local_day BETWEEN ? AND ?", [
    from,
    to,
  ]);
  return new Map(rows.map((r) => [r.local_day, r.calories]));
}

// ---- Currency ----

export const CURRENCY_KEY = "currency";

export async function getCurrency(db: SqlDriver): Promise<string> {
  return (await getSetting(db, CURRENCY_KEY)) ?? "EUR";
}

export async function setCurrency(db: SqlDriver, code: string, nowMs: number = Date.now()): Promise<void> {
  const c = code.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(c)) throw new Error("Use a 3-letter currency code, e.g. EUR");
  await setSetting(db, CURRENCY_KEY, c, nowMs);
  log.info("currency set", { currency: c });
}

// ---- Weight without alcohol ----

export interface Weight {
  kg: number;
  day: string;
  source: "manual" | "synced";
}

/** Latest weight on or before a day: a manual weigh-in (kg, g or lb) or a synced body weight (grams). */
export async function latestWeight(db: SqlDriver, onOrBefore: string): Promise<Weight | null> {
  const [m] = await db.all<{ v: number; unit: string | null; day: string }>(
    `SELECT value_num AS v, unit, local_day AS day FROM manual_measurements
     WHERE deleted_at IS NULL AND kind = 'weight' AND value_num IS NOT NULL AND local_day <= ?
     ORDER BY measured_at_ms DESC LIMIT 1`,
    [onOrBefore],
  );
  const [s] = await db.all<{ v: number; unit: string | null; day: string }>(
    `SELECT value_num AS v, unit, local_day AS day FROM health_samples
     WHERE metric IN ('body_weightInGrams', 'weight', 'body_weight') AND value_num IS NOT NULL AND local_day <= ?
     ORDER BY local_day DESC, start_ms DESC LIMIT 1`,
    [onOrBefore],
  );
  const toKg = (v: number, unit: string | null, fallback: "kg" | "g") => {
    const u = (unit ?? fallback).toLowerCase();
    if (u.startsWith("g")) return v / 1000;
    if (u === "lb" || u === "lbs") return v * 0.45359237;
    return v;
  };
  const manual = m ? { kg: toKg(m.v, m.unit, "kg"), day: m.day, source: "manual" as const } : null;
  const synced = s ? { kg: toKg(s.v, s.unit, "g"), day: s.day, source: "synced" as const } : null;
  if (!manual) return synced;
  if (!synced) return manual;
  return manual.day >= synced.day ? manual : synced;
}

export interface WeightWithoutAlcohol {
  totals: AlcoholTotals;
  weight: Weight | null;
  /** kcal / 7700. */
  kgFromAlcohol: number;
  /** Latest weight minus kgFromAlcohol, or null without a weight. */
  expectedKg: number | null;
}

/**
 * What the owner would weigh without the drinks from..to, if those kcal were extra and not made
 * up for elsewhere. Uses the latest weight up to `to`.
 */
export async function weightWithoutAlcohol(db: SqlDriver, from: string, to: string): Promise<WeightWithoutAlcohol> {
  const totals = await alcoholTotals(db, from, to);
  const weight = await latestWeight(db, to);
  const kgFromAlcohol = totals.kcal / KCAL_PER_KG_BODY;
  return { totals, weight, kgFromAlcohol, expectedKg: weight ? weightWithoutKcal(weight.kg, totals.kcal) : null };
}
