import { z } from "zod";
import { withTransaction } from "../../db/tx.js";
import type { SqlDriver } from "../../db/driver.js";
import { deleteFood, updateFood } from "../food/food.js";
import type { Meal } from "../food/suggest.js";
import { deleteDrink, deleteDrinkType, listDrinkTypes, saveDrinkType, servingKcal, updateDrink } from "../alcohol/alcohol.js";
import { localDateTimeToMs } from "../../core/tz.js";
import {
  hhmm,
  kcal,
  logDay,
  MEALS,
  nullableMeal,
  nullableNumber,
  nullableString,
  optNum,
  optText,
  plural,
  time,
  type DrinkSnapshot,
  type DrinkTypeSnapshot,
  type FoodSnapshot,
  type WriteTool,
} from "./actions.js";
import { day, tool } from "./tools.js";

/**
 * Tools that change or delete what is already in the owner's food and drink logs. Only the health
 * connector offers them, and only with its own consent (claude.connector_edits, consent.ts):
 * the Chat tab keeps the additive-only rule (architecture.md section 3, decision 22 Nov 2026).
 *
 * Same security model as actions.ts: every input is validated with hard limits, nothing is written
 * until the owner approves the exact change, every call is logged in agent_actions with what it
 * touched, and the owner can undo it: an edit puts the old values back, a delete brings the row
 * back (both only while the row is as the action left it). Deletes are soft deletes, as in the app.
 * Writes go through the functions the screens use (food.ts, alcohol.ts).
 *
 * Scope: food entries, drink entries and drink types. Saved meals (their photo makes a delete hard
 * to reverse exactly), recipes, shopping and everything else stay with the owner.
 */

/** A change field left null stays as it is. (A value cannot be cleared this way: delete and log again.) */
const KEEP = "null leaves it unchanged";
const MAX_IDS = 20;
const ids = (what: string) => ({ type: "array", items: { type: "string" }, description: `1 to ${MAX_IDS} ${what} ids` });

const money = (n: number | null | undefined) => (n == null ? "no price" : `${n}`);

interface FoodRow extends FoodSnapshot {
  id: string;
  updated_at: number;
  from_prep: number;
}
const FOOD_COLS = `e.id, e.eaten_at_ms, e.offset_min, e.local_day, e.name, e.meal, e.calories, e.protein_g, e.carbs_g, e.fat_g, e.notes, e.updated_at,
  EXISTS (SELECT 1 FROM meal_prep_moves m WHERE m.food_entry_id = e.id AND m.deleted_at IS NULL) AS from_prep`;

async function foodRows(db: SqlDriver, entryIds: string[]): Promise<FoodRow[]> {
  const unique = [...new Set(entryIds)];
  const rows = await db.all<FoodRow>(
    `SELECT ${FOOD_COLS} FROM food_entries e WHERE e.deleted_at IS NULL AND e.id IN (${unique.map(() => "?").join(",")})`,
    unique,
  );
  const missing = unique.filter((id) => !rows.some((r) => r.id === id));
  if (missing.length) throw new Error(`No food entry with id ${missing.join(", ")} (it may be deleted: check list_food_entries)`);
  return unique.map((id) => rows.find((r) => r.id === id)!);
}

const snapFood = (r: FoodRow): FoodSnapshot => ({
  eaten_at_ms: r.eaten_at_ms,
  offset_min: r.offset_min,
  local_day: r.local_day,
  name: r.name,
  meal: r.meal,
  calories: r.calories,
  protein_g: r.protein_g,
  carbs_g: r.carbs_g,
  fat_g: r.fat_g,
  notes: r.notes,
});

const foodLine = (r: FoodSnapshot, tz: string) => `${r.local_day} ${hhmm(r.eaten_at_ms, tz)}${r.meal ? ` ${r.meal}` : ""}: ${r.name}, ${kcal(r.calories)}`;

// ---- food entries ---------------------------------------------------------------------------

const updateFoodTool: WriteTool = {
  definition: tool(
    "update_food_entry",
    `Change one entry of the food log (id from list_food_entries): name, meal, day, time, calories, macros or notes. Moving it to another day or time needs the new day, the new time, or both (a missing one stays as it was). ${KEEP}. A meal prep portion keeps its time. The owner confirms first.`,
    {
      entry_id: { type: "string", description: "Id from list_food_entries" },
      name: nullableString(`New name. ${KEEP}`),
      meal: nullableMeal,
      day: nullableString(`New local day, YYYY-MM-DD. ${KEEP}`),
      time: nullableString(`New local time HH:MM. ${KEEP}`),
      calories: nullableNumber(`kcal for the portion eaten. ${KEEP}`),
      protein_g: nullableNumber(`grams. ${KEEP}`),
      carbs_g: nullableNumber(`grams. ${KEEP}`),
      fat_g: nullableNumber(`grams. ${KEEP}`),
      notes: nullableString(`New note. ${KEEP}`),
    },
  ),
  async prepare(ctx, input) {
    const p = z
      .object({
        entry_id: z.string().min(1),
        name: optText(120),
        meal: z.enum(MEALS).nullable(),
        day: day.nullable(),
        time,
        calories: optNum(0, 5000),
        protein_g: optNum(0, 500),
        carbs_g: optNum(0, 1000),
        fat_g: optNum(0, 500),
        notes: optText(500),
      })
      .parse(input);
    const [cur] = await foodRows(ctx.db, [p.entry_id]);
    const next = {
      name: p.name ?? cur.name,
      meal: (p.meal ?? cur.meal) as Meal | null,
      calories: p.calories ?? cur.calories,
      proteinG: p.protein_g ?? cur.protein_g,
      carbsG: p.carbs_g ?? cur.carbs_g,
      fatG: p.fat_g ?? cur.fat_g,
      notes: p.notes ?? cur.notes,
    };
    const moves = p.day !== null || p.time !== null;
    let at: { ms: number; offsetMin: number } | null = null;
    if (moves) {
      const d = logDay(ctx, p.day ?? cur.local_day, 400);
      at = localDateTimeToMs(d, p.time ?? hhmm(cur.eaten_at_ms, ctx.timeZone), ctx.timeZone);
      if (at.ms > ctx.now + 60_000) throw new Error("That time has not happened yet");
    }
    const after: FoodSnapshot = {
      ...snapFood(cur),
      name: next.name,
      meal: next.meal,
      calories: next.calories,
      protein_g: next.proteinG,
      carbs_g: next.carbsG,
      fat_g: next.fatG,
      notes: next.notes,
      ...(at ? { eaten_at_ms: at.ms, offset_min: at.offsetMin, local_day: p.day ?? cur.local_day } : {}),
    };
    if (JSON.stringify(after) === JSON.stringify(snapFood(cur))) throw new Error("Nothing to change: every field is null or the same as now");
    if (at && cur.from_prep === 1 && at.ms !== cur.eaten_at_ms)
      throw new Error("A meal prep portion keeps its time. Delete it in Even and eat it again from Stock on the right day.");
    return {
      tool: "update_food_entry",
      summary: `Change the food entry ${cur.name}`,
      lines: [`Now: ${foodLine(snapFood(cur), ctx.timeZone)}`, `Becomes: ${foodLine(after, ctx.timeZone)}`],
      async apply() {
        await withTransaction(ctx.db, () => updateFood(ctx.db, cur.id, { ...next, ...(at ? { atMs: at.ms, timeZone: ctx.timeZone } : {}) }, ctx.now));
        return {
          result: { changed: 1, entry_id: cur.id },
          rows: [{ op: "food_edit" as const, table: "food_entries" as const, id: cur.id, stamp: ctx.now, before: snapFood(cur) }],
        };
      },
    };
  },
};

const deleteFoodTool: WriteTool = {
  definition: tool(
    "delete_food_entries",
    "Delete entries from the food log (ids from list_food_entries). They can be undone in Even. A meal prep portion cannot be deleted here: its stock move belongs to Even's Stock screen. The owner confirms first.",
    { entry_ids: ids("food entry") },
  ),
  async prepare(ctx, input) {
    const p = z.object({ entry_ids: z.array(z.string().min(1)).min(1).max(MAX_IDS) }).parse(input);
    const rows = await foodRows(ctx.db, p.entry_ids);
    const prep = rows.find((r) => r.from_prep === 1);
    if (prep) throw new Error(`${prep.name} was eaten from meal prep stock: delete it in Even (Food > History) so the portion goes back to the stock`);
    return {
      tool: "delete_food_entries",
      summary: `Delete ${plural(rows.length, "food entry", "food entries")}`,
      lines: rows.map((r) => foodLine(r, ctx.timeZone)),
      async apply() {
        await withTransaction(ctx.db, async () => {
          for (const r of rows) await deleteFood(ctx.db, r.id, ctx.now);
        });
        return {
          result: { deleted: rows.length },
          rows: rows.map((r) => ({ op: "restore" as const, table: "food_entries" as const, id: r.id, stamp: ctx.now })),
        };
      },
    };
  },
};

// ---- drink entries --------------------------------------------------------------------------

interface DrinkRow extends DrinkSnapshot {
  id: string;
}

async function drinkRows(db: SqlDriver, entryIds: string[]): Promise<DrinkRow[]> {
  const unique = [...new Set(entryIds)];
  const rows = await db.all<DrinkRow>(
    `SELECT id, drunk_at_ms, offset_min, local_day, name, volume_ml, abv_percent, calories, price FROM drink_entries
     WHERE deleted_at IS NULL AND id IN (${unique.map(() => "?").join(",")})`,
    unique,
  );
  const missing = unique.filter((id) => !rows.some((r) => r.id === id));
  if (missing.length) throw new Error(`No drink entry with id ${missing.join(", ")} (it may be deleted: check list_drink_entries)`);
  return unique.map((id) => rows.find((r) => r.id === id)!);
}

const snapDrink = (r: DrinkRow): DrinkSnapshot => ({
  drunk_at_ms: r.drunk_at_ms,
  offset_min: r.offset_min,
  local_day: r.local_day,
  name: r.name,
  volume_ml: r.volume_ml,
  abv_percent: r.abv_percent,
  calories: r.calories,
  price: r.price,
});

const drinkLine = (r: DrinkSnapshot, tz: string) =>
  `${r.local_day} ${hhmm(r.drunk_at_ms, tz)}: ${r.name}, ${r.volume_ml} ml, ${r.abv_percent} %, ${kcal(servingKcal({ volumeMl: r.volume_ml, abvPercent: r.abv_percent, calories: r.calories }))}, price ${money(r.price)}`;

const updateDrinkTool: WriteTool = {
  definition: tool(
    "update_drink_entry",
    `Change one logged drink (id from list_drink_entries): name, size, ABV, kcal, price, day or time. Moving it needs the new day, the new time, or both (a missing one stays as it was). ${KEEP}. Its drink type keeps its own values. The owner confirms first.`,
    {
      entry_id: { type: "string", description: "Id from list_drink_entries" },
      name: nullableString(`New name. ${KEEP}`),
      volume_ml: nullableNumber(`Volume of the drink in ml. ${KEEP}`),
      abv_percent: nullableNumber(`Alcohol by volume, %. ${KEEP}`),
      calories: nullableNumber(`kcal for the drink. ${KEEP}`),
      price: nullableNumber(`Price of the drink. ${KEEP}`),
      day: nullableString(`New local day, YYYY-MM-DD. ${KEEP}`),
      time: nullableString(`New local time HH:MM. ${KEEP}`),
    },
  ),
  async prepare(ctx, input) {
    const p = z
      .object({
        entry_id: z.string().min(1),
        name: optText(80),
        volume_ml: optNum(1, 3000),
        abv_percent: optNum(0, 100),
        calories: optNum(0, 3000),
        price: optNum(0, 10_000),
        day: day.nullable(),
        time,
      })
      .parse(input);
    const [cur] = await drinkRows(ctx.db, [p.entry_id]);
    let at = { ms: cur.drunk_at_ms, offsetMin: cur.offset_min };
    let localDayOf = cur.local_day;
    if (p.day !== null || p.time !== null) {
      localDayOf = logDay(ctx, p.day ?? cur.local_day, 400);
      at = localDateTimeToMs(localDayOf, p.time ?? hhmm(cur.drunk_at_ms, ctx.timeZone), ctx.timeZone);
      if (at.ms > ctx.now) throw new Error("That time has not happened yet");
    }
    const after: DrinkSnapshot = {
      drunk_at_ms: at.ms,
      offset_min: at.offsetMin,
      local_day: localDayOf,
      name: p.name ?? cur.name,
      volume_ml: p.volume_ml ?? cur.volume_ml,
      abv_percent: p.abv_percent ?? cur.abv_percent,
      calories: p.calories ?? cur.calories,
      price: p.price ?? cur.price,
    };
    if (JSON.stringify(after) === JSON.stringify(snapDrink(cur))) throw new Error("Nothing to change: every field is null or the same as now");
    return {
      tool: "update_drink_entry",
      summary: `Change the drink ${cur.name}`,
      lines: [`Now: ${drinkLine(snapDrink(cur), ctx.timeZone)}`, `Becomes: ${drinkLine(after, ctx.timeZone)}`],
      async apply() {
        await withTransaction(ctx.db, () =>
          updateDrink(
            ctx.db,
            cur.id,
            {
              name: after.name,
              volumeMl: after.volume_ml,
              abvPercent: after.abv_percent,
              calories: after.calories,
              price: after.price,
              atMs: after.drunk_at_ms,
              timeZone: ctx.timeZone,
            },
            ctx.now,
          ),
        );
        return {
          result: { changed: 1, entry_id: cur.id },
          rows: [{ op: "drink_edit" as const, table: "drink_entries" as const, id: cur.id, stamp: ctx.now, before: snapDrink(cur) }],
        };
      },
    };
  },
};

const deleteDrinkTool: WriteTool = {
  definition: tool("delete_drink_entries", "Delete logged drinks (ids from list_drink_entries). They can be undone in Even. The owner confirms first.", {
    entry_ids: ids("drink entry"),
  }),
  async prepare(ctx, input) {
    const p = z.object({ entry_ids: z.array(z.string().min(1)).min(1).max(MAX_IDS) }).parse(input);
    const rows = await drinkRows(ctx.db, p.entry_ids);
    return {
      tool: "delete_drink_entries",
      summary: `Delete ${plural(rows.length, "drink")}`,
      lines: rows.map((r) => drinkLine(r, ctx.timeZone)),
      async apply() {
        await withTransaction(ctx.db, async () => {
          for (const r of rows) await deleteDrink(ctx.db, r.id, ctx.now);
        });
        return {
          result: { deleted: rows.length },
          rows: rows.map((r) => ({ op: "restore" as const, table: "drink_entries" as const, id: r.id, stamp: ctx.now })),
        };
      },
    };
  },
};

// ---- drink types ----------------------------------------------------------------------------

const typeLine = (t: DrinkTypeSnapshot) =>
  `${t.name}, ${t.volume_ml} ml, ${t.abv_percent} %, ${t.calories == null ? "kcal estimated" : kcal(t.calories)}, price ${money(t.price)}`;

const updateDrinkTypeTool: WriteTool = {
  definition: tool(
    "update_drink_type",
    `Change a saved drink type (name from drink_types, or its id): rename it or change its serving size, ABV, kcal or price. Drinks already logged keep their own values. ${KEEP}. The owner confirms first.`,
    {
      drink_type: { type: "string", description: "Name or id of the saved drink type" },
      name: nullableString(`New name. ${KEEP}`),
      volume_ml: nullableNumber(`One serving in ml. ${KEEP}`),
      abv_percent: nullableNumber(`Alcohol by volume, %. ${KEEP}`),
      calories: nullableNumber(`kcal per serving. ${KEEP}`),
      price: nullableNumber(`Price per serving. ${KEEP}`),
    },
  ),
  async prepare(ctx, input) {
    const p = z
      .object({
        drink_type: z.string().trim().min(1).max(80),
        name: optText(80),
        volume_ml: optNum(1, 3000),
        abv_percent: optNum(0, 100),
        calories: optNum(0, 3000),
        price: optNum(0, 10_000),
      })
      .parse(input);
    const all = await listDrinkTypes(ctx.db);
    const cur = all.find((t) => t.id === p.drink_type) ?? all.find((t) => t.name.toLowerCase() === p.drink_type.toLowerCase());
    if (!cur) throw new Error(`No drink type called ${p.drink_type} (check drink_types)`);
    const before: DrinkTypeSnapshot = { name: cur.name, volume_ml: cur.volumeMl, abv_percent: cur.abvPercent, calories: cur.calories, price: cur.price };
    const after: DrinkTypeSnapshot = {
      name: p.name ?? cur.name,
      volume_ml: p.volume_ml ?? cur.volumeMl,
      abv_percent: p.abv_percent ?? cur.abvPercent,
      calories: p.calories ?? cur.calories,
      price: p.price ?? cur.price,
    };
    if (JSON.stringify(after) === JSON.stringify(before)) throw new Error("Nothing to change: every field is null or the same as now");
    const clash = all.find((t) => t.id !== cur.id && t.name.toLowerCase() === after.name.toLowerCase());
    if (clash) throw new Error(`There is already a drink called ${clash.name}`);
    return {
      tool: "update_drink_type",
      summary: `Change the drink type ${cur.name}`,
      lines: [`Now: ${typeLine(before)}`, `Becomes: ${typeLine(after)}`],
      async apply() {
        await withTransaction(ctx.db, () =>
          saveDrinkType(
            ctx.db,
            { id: cur.id, name: after.name, volumeMl: after.volume_ml, abvPercent: after.abv_percent, calories: after.calories, price: after.price },
            { nowMs: ctx.now },
          ),
        );
        return {
          result: { changed: 1, drink_type_id: cur.id },
          rows: [{ op: "drink_type_edit" as const, table: "drink_types" as const, id: cur.id, stamp: ctx.now, before }],
        };
      },
    };
  },
};

const deleteDrinkTypeTool: WriteTool = {
  definition: tool(
    "delete_drink_type",
    "Delete a saved drink type (name from drink_types, or its id). Drinks already logged keep their own values and stay in the log. It can be undone in Even. The owner confirms first.",
    { drink_type: { type: "string", description: "Name or id of the saved drink type" } },
  ),
  async prepare(ctx, input) {
    const p = z.object({ drink_type: z.string().trim().min(1).max(80) }).parse(input);
    const all = await listDrinkTypes(ctx.db);
    const cur = all.find((t) => t.id === p.drink_type) ?? all.find((t) => t.name.toLowerCase() === p.drink_type.toLowerCase());
    if (!cur) throw new Error(`No drink type called ${p.drink_type} (check drink_types)`);
    return {
      tool: "delete_drink_type",
      summary: `Delete the drink type ${cur.name}`,
      lines: [
        `${typeLine({ name: cur.name, volume_ml: cur.volumeMl, abv_percent: cur.abvPercent, calories: cur.calories, price: cur.price })}; logged ${plural(cur.uses, "time")}, those drinks stay`,
      ],
      async apply() {
        await deleteDrinkType(ctx.db, cur.id, ctx.now);
        return { result: { deleted: 1 }, rows: [{ op: "restore" as const, table: "drink_types" as const, id: cur.id, stamp: ctx.now }] };
      },
    };
  },
};

/** Fixed order. Not part of WRITE_TOOLS: the Chat tab never gets them (see the header). */
export const EDIT_TOOLS: WriteTool[] = [updateFoodTool, deleteFoodTool, updateDrinkTool, deleteDrinkTool, updateDrinkTypeTool, deleteDrinkTypeTool];
export const EDIT_TOOLS_BY_NAME = new Map(EDIT_TOOLS.map((t) => [t.definition.name, t]));
