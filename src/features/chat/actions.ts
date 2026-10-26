import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import type { SqlDriver } from "../../db/driver";
import { deleteFood, deleteSavedMeal, getSavedMeal, logFood, logSavedMeal, MAX_PHOTO_BYTES, saveMeal, type PhotoInput } from "../food/food";
import { dayNoteExists, insertDayNote, insertDrinkEntry, insertGoal, insertMeasurement, type Stamp } from "../journal/journal";
import { addMove, deleteBatch, deleteMealPrep, listMealPreps, loadStock, logBatch, saveMealPrep, undoMove } from "../mealprep/mealPrep";
import { addRecipesToShopping, addShoppingItem } from "../mealprep/shopping";
import { alcoholGrams } from "../../core/health";
import { addDays, localDateTimeToMs, localDay } from "../../core/tz";
import { uuidv7 } from "../../core/uuidv7";
import { loadMessages } from "./store";
import { DATE_DESC, day, round, tool } from "./tools";

type BetaTool = Anthropic.Beta.Messages.BetaTool;

/**
 * Tools that change the owner's data. Security model, enforced here rather than in the prompt:
 * - only the operations below, all additive: new log rows, saved meals, recipes, cooked batches,
 *   portion moves, shopping-list lines (or more of an open line). No edits of existing entries,
 *   no deletes, no settings, consents, keys, sync or backups;
 * - every input is validated with hard limits (dates, portions, counts, text length);
 * - nothing is written until the owner confirms the exact change (ChatDeps.confirmAction);
 * - every proposal is logged in agent_actions (applied, declined or failed) with what it wrote,
 *   so the owner can undo it (undoAgentAction), using the app's own undo for each kind of row.
 * Writes go through the same functions the screens use (food.ts, mealPrep.ts, shopping.ts, logs.ts).
 */

/** One reversible effect of an applied action. */
export type ActionRow =
  | { op: "food"; table: "food_entries"; id: string }
  | { op: "saved_meal"; table: "saved_meals"; id: string }
  | { op: "meal_prep"; table: "meal_preps"; id: string }
  | { op: "batch"; table: "meal_prep_batches"; id: string }
  | { op: "move"; table: "meal_prep_moves"; id: string }
  | { op: "insert"; table: "drink_entries" | "manual_measurements" | "day_notes" | "goals"; id: string }
  | { op: "shopping_insert"; table: "shopping_list_items"; id: string }
  | { op: "shopping_quantity"; table: "shopping_list_items"; id: string; before: number | null; after: number | null };

/** Tables an action may touch, per operation. Undo refuses anything else, even if the log were edited. */
const OP_TABLES: Record<ActionRow["op"], readonly string[]> = {
  food: ["food_entries"],
  saved_meal: ["saved_meals"],
  meal_prep: ["meal_preps"],
  batch: ["meal_prep_batches"],
  move: ["meal_prep_moves"],
  insert: ["drink_entries", "manual_measurements", "day_notes", "goals"],
  shopping_insert: ["shopping_list_items"],
  shopping_quantity: ["shopping_list_items"],
};
export const AGENT_TABLES = [...new Set(Object.values(OP_TABLES).flat())];

export interface ActionContext {
  db: SqlDriver;
  deviceId: string;
  now: number;
  timeZone: string;
  conversationId: string;
}

/** What the owner is asked to confirm. `lines` is one readable line per thing to be saved. */
export interface ActionProposal {
  tool: string;
  summary: string;
  lines: string[];
}

export interface PreparedAction extends ActionProposal {
  apply(): Promise<{ result: unknown; rows: ActionRow[] }>;
}

export interface WriteTool {
  definition: BetaTool;
  /** Validate and describe. Throws on invalid input; writes nothing. */
  prepare(ctx: ActionContext, input: unknown): Promise<PreparedAction>;
}

const MEALS = ["breakfast", "lunch", "dinner", "snack", "prep"] as const;
/** Used when a time is not given for a past day. Today without a time means now. */
const DEFAULT_TIME: Record<string, string> = { breakfast: "08:30", lunch: "14:00", dinner: "21:00", snack: "17:30", prep: "12:00", none: "12:00" };

const nullableNumber = (description: string) => ({ type: ["number", "null"], description });
const nullableString = (description: string) => ({ type: ["string", "null"], description });
const nullableMeal = { type: ["string", "null"], enum: [...MEALS, null], description: "breakfast, lunch, dinner, snack, prep, or null" };
const TIME_DESC = "Local time HH:MM, or null (today: now; another day: a usual time for the meal)";

const text = (max: number) => z.string().trim().min(1).max(max);
const optText = (max: number) => z.string().trim().max(max).nullable().transform((v) => v || null);
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "times are HH:MM").nullable();
const num = (min: number, max: number) => z.number().min(min).max(max);
const optNum = (min: number, max: number) => num(min, max).nullable();
const int = (min: number, max: number) => z.number().int().min(min).max(max);

function logDay(ctx: ActionContext, d: string, maxDaysBack = 60): string {
  const today = localDay(ctx.now, ctx.timeZone);
  if (d > today) throw new Error(`${d} is in the future: only past or current days can be logged`);
  if (d < addDays(today, -maxDaysBack)) throw new Error(`${d} is more than ${maxDaysBack} days ago`);
  return d;
}

function when(ctx: ActionContext, d: string, t: string | null, meal: string | null): { ms: number; offsetMin: number } {
  if (!t && d === localDay(ctx.now, ctx.timeZone)) return { ms: ctx.now, offsetMin: localDateTimeToMs(d, "12:00", ctx.timeZone).offsetMin };
  return localDateTimeToMs(d, t ?? DEFAULT_TIME[meal ?? "none"], ctx.timeZone);
}

const hhmm = (ms: number, timeZone: string) => new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit" }).format(new Date(ms));
const kcal = (n: number | null | undefined) => (n == null ? "kcal unknown" : `${Math.round(n)} kcal`);
const macros = (p?: number | null, c?: number | null, f?: number | null) =>
  p == null && c == null && f == null ? "" : ` (P ${round(p) ?? "?"} g, C ${round(c) ?? "?"} g, F ${round(f) ?? "?"} g)`;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

const stamp = (ctx: ActionContext): Stamp => ({ deviceId: ctx.deviceId, createdBy: "assistant", now: ctx.now });

/** Rows written through the app's own functions get the assistant's mark afterwards. */
const MARKABLE = new Set(["food_entries", "saved_meals", "meal_preps", "meal_prep_batches", "shopping_list_items"]);
async function markAssistant(db: SqlDriver, table: string, ids: string[]): Promise<void> {
  if (!MARKABLE.has(table)) throw new Error(`Cannot mark rows in ${table}`);
  for (const id of ids) await db.run(`UPDATE ${table} SET created_by = 'assistant' WHERE id = ?`, [id]);
}

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

// ---- food -----------------------------------------------------------------------------------

const foodItem = z.object({
  name: text(120),
  meal: z.enum(MEALS).nullable(),
  day,
  time,
  calories: optNum(0, 5000),
  protein_g: optNum(0, 500),
  carbs_g: optNum(0, 1000),
  fat_g: optNum(0, 500),
  portion: optText(120),
  notes: optText(500),
});

const logFoodTool: WriteTool = {
  definition: tool(
    "log_food",
    "Add one or more entries to the food log (one entry per dish or food). Values are for the portion eaten, not per 100 g. When the numbers are estimates (for example from a photo), say so in notes and give the portion you assumed. For a saved meal use log_saved_meal, for a meal prep portion use prep_portions. The owner confirms before anything is saved.",
    {
      entries: {
        type: "array",
        description: "1 to 20 entries",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["name", "meal", "day", "time", "calories", "protein_g", "carbs_g", "fat_g", "portion", "notes"],
          properties: {
            name: { type: "string", description: "What was eaten, e.g. 'Chicken salad'" },
            meal: nullableMeal,
            day: { type: "string", description: DATE_DESC },
            time: nullableString(TIME_DESC),
            calories: nullableNumber("kcal for the portion eaten"),
            protein_g: nullableNumber("grams"),
            carbs_g: nullableNumber("grams"),
            fat_g: nullableNumber("grams"),
            portion: nullableString("Portion assumed, e.g. '1 plate, about 350 g'"),
            notes: nullableString("e.g. 'Estimated from photo'"),
          },
        },
      },
    },
  ),
  async prepare(ctx, input) {
    const p = z.object({ entries: z.array(foodItem).min(1).max(20) }).parse(input);
    const rows = p.entries.map((e) => {
      logDay(ctx, e.day);
      const t = when(ctx, e.day, e.time, e.meal);
      const notes = [e.portion ? `Portion: ${e.portion}` : null, e.notes].filter(Boolean).join(". ") || null;
      return { e, t, notes };
    });
    const total = rows.reduce((a, r) => a + (r.e.calories ?? 0), 0);
    return {
      tool: "log_food",
      summary: `Log ${plural(rows.length, "food entry", "food entries")} (${Math.round(total)} kcal)`,
      lines: rows.map(
        ({ e, t }) =>
          `${e.day} ${hhmm(t.ms, ctx.timeZone)}${e.meal ? ` ${e.meal}` : ""}: ${e.name}${e.portion ? `, ${e.portion}` : ""}, ${kcal(e.calories)}${macros(e.protein_g, e.carbs_g, e.fat_g)}`,
      ),
      async apply() {
        const ids = await inTransaction(ctx.db, async () => {
          const out: string[] = [];
          for (const { e, t, notes } of rows) {
            out.push(
              await logFood(ctx.db, {
                name: e.name,
                meal: e.meal,
                calories: e.calories,
                proteinG: e.protein_g,
                carbsG: e.carbs_g,
                fatG: e.fat_g,
                notes,
                atMs: t.ms,
                timeZone: ctx.timeZone,
              }),
            );
          }
          await markAssistant(ctx.db, "food_entries", out);
          return out;
        });
        return { result: { saved: ids.length, entry_ids: ids }, rows: ids.map((id) => ({ op: "food" as const, table: "food_entries" as const, id })) };
      },
    };
  },
};

const logSavedMealTool: WriteTool = {
  definition: tool(
    "log_saved_meal",
    "Log one of the owner's saved meals (from list_saved_meals) in the food log, scaled by servings. The owner confirms first.",
    {
      saved_meal_id: { type: "string", description: "Id from list_saved_meals" },
      servings: { type: "number", description: "Servings eaten, e.g. 1 or 1.5" },
      meal: nullableMeal,
      day: { type: "string", description: DATE_DESC },
      time: nullableString(TIME_DESC),
    },
  ),
  async prepare(ctx, input) {
    const p = z.object({ saved_meal_id: z.string().min(1), servings: num(0.1, 20), meal: z.enum(MEALS).nullable(), day, time }).parse(input);
    logDay(ctx, p.day);
    const m = await getSavedMeal(ctx.db, p.saved_meal_id);
    if (!m) throw new Error(`No saved meal with id ${p.saved_meal_id}`);
    const meal = p.meal ?? m.meal;
    const t = when(ctx, p.day, p.time, meal);
    const scale = (v: number | null) => (v == null ? null : v * p.servings);
    return {
      tool: "log_saved_meal",
      summary: `Log ${m.name} (${plural(p.servings, "serving")})`,
      lines: [`${p.day} ${hhmm(t.ms, ctx.timeZone)}${meal ? ` ${meal}` : ""}: ${m.name}, ${kcal(scale(m.calories))}${macros(scale(m.proteinG), scale(m.carbsG), scale(m.fatG))}`],
      async apply() {
        const id = await logSavedMeal(ctx.db, m.id, { servings: p.servings, meal, atMs: t.ms, timeZone: ctx.timeZone });
        await markAssistant(ctx.db, "food_entries", [id]);
        return { result: { saved: 1, entry_id: id }, rows: [{ op: "food", table: "food_entries", id }] };
      },
    };
  },
};

/** The most recent photo the owner attached in this conversation, if the food log can keep it (JPEG or WebP). */
async function lastChatPhoto(ctx: ActionContext): Promise<PhotoInput | null> {
  const messages = await loadMessages(ctx.db, ctx.conversationId);
  for (const m of [...messages].reverse()) {
    if (m.role !== "user" || !Array.isArray(m.content)) continue;
    for (const b of [...m.content].reverse()) {
      if (b.type !== "image" || b.source.type !== "base64") continue;
      const mime = b.source.media_type;
      if (mime !== "image/jpeg" && mime !== "image/webp") return null;
      return { mime, dataB64: b.source.data, width: null, height: null };
    }
  }
  return null;
}

const saveMealTool: WriteTool = {
  definition: tool(
    "save_meal",
    "Save a meal as a favourite so the owner can log it again with one tap, optionally keeping the photo they sent in this chat. Values are per serving. The owner confirms first.",
    {
      name: { type: "string", description: "Meal name" },
      meal: nullableMeal,
      calories: nullableNumber("kcal per serving"),
      protein_g: nullableNumber("grams per serving"),
      carbs_g: nullableNumber("grams per serving"),
      fat_g: nullableNumber("grams per serving"),
      notes: nullableString("Portion or recipe notes"),
      use_chat_photo: { type: "boolean", description: "Keep the last photo the owner sent in this chat with the saved meal" },
    },
  ),
  async prepare(ctx, input) {
    const p = z
      .object({
        name: text(120),
        meal: z.enum(MEALS).nullable(),
        calories: optNum(0, 5000),
        protein_g: optNum(0, 500),
        carbs_g: optNum(0, 1000),
        fat_g: optNum(0, 500),
        notes: optText(500),
        use_chat_photo: z.boolean(),
      })
      .parse(input);
    let photo: PhotoInput | null = null;
    if (p.use_chat_photo) {
      photo = await lastChatPhoto(ctx);
      if (!photo) throw new Error("There is no JPEG or WebP photo in this chat to keep. Save it without a photo, or ask the owner to send one.");
      const bytes = Math.floor((photo.dataB64.length * 3) / 4);
      if (bytes > MAX_PHOTO_BYTES) throw new Error("The photo is too large to keep with a saved meal.");
    }
    return {
      tool: "save_meal",
      summary: `Save "${p.name}" as a favourite${photo ? " with the photo" : ""}`,
      lines: [`${p.name}${p.meal ? ` (${p.meal})` : ""}: ${kcal(p.calories)} per serving${macros(p.protein_g, p.carbs_g, p.fat_g)}${photo ? ", with photo" : ""}`],
      async apply() {
        const id = await saveMeal(ctx.db, { name: p.name, meal: p.meal, calories: p.calories, proteinG: p.protein_g, carbsG: p.carbs_g, fatG: p.fat_g, notes: p.notes, photo }, ctx.now);
        await markAssistant(ctx.db, "saved_meals", [id]);
        return { result: { saved: 1, saved_meal_id: id }, rows: [{ op: "saved_meal", table: "saved_meals", id }] };
      },
    };
  },
};

// ---- meal prep ------------------------------------------------------------------------------

const ingredient = z.object({ name: text(80), quantity: optNum(0.001, 100000), unit: optText(20) });

const createMealPrepTool: WriteTool = {
  definition: tool(
    "create_meal_prep",
    "Create a meal prep recipe: a dish cooked in bulk. Macros are per portion; ingredients are for one whole batch, so the shopping list adds up. Shelf life drives the app's stock and defrost plan. Tags group recipes (e.g. lunch, dinner, high protein). Create one recipe per dish; then add_recipe_to_shopping to put the ingredients on the list. The owner confirms first.",
    {
      name: { type: "string", description: "Dish name" },
      portions: { type: "integer", description: "Portions one batch makes" },
      fridge_days: { type: "integer", description: "Days a cooked or thawed portion keeps in the fridge (usually 3 or 4)" },
      freezer_days: { type: "integer", description: "Days of good quality in the freezer (usually 60 to 90)" },
      thaw_hours: { type: "integer", description: "Hours a frozen portion takes to defrost in the fridge (usually 12 to 24)" },
      calories: nullableNumber("kcal per portion"),
      protein_g: nullableNumber("grams per portion"),
      carbs_g: nullableNumber("grams per portion"),
      fat_g: nullableNumber("grams per portion"),
      tags: { type: "array", items: { type: "string" }, description: "Up to 8 tags" },
      ingredients: {
        type: "array",
        description: "For one batch",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["name", "quantity", "unit"],
          properties: { name: { type: "string" }, quantity: nullableNumber("Amount for the whole batch"), unit: nullableString("g, kg, ml, l, units, tbsp...") },
        },
      },
      notes: nullableString("Method, storage, reheating"),
    },
  ),
  async prepare(ctx, input) {
    const p = z
      .object({
        name: text(120),
        portions: int(1, 40),
        fridge_days: int(1, 7),
        freezer_days: int(1, 365),
        thaw_hours: int(0, 72),
        calories: optNum(0, 3000),
        protein_g: optNum(0, 300),
        carbs_g: optNum(0, 500),
        fat_g: optNum(0, 300),
        tags: z.array(text(30)).max(8),
        ingredients: z.array(ingredient).max(60),
        notes: optText(4000),
      })
      .parse(input);
    const existing = await listMealPreps(ctx.db);
    if (existing.some((r) => r.name.trim().toLowerCase() === p.name.toLowerCase())) {
      throw new Error(`A recipe called "${p.name}" already exists (see list_meal_preps). Use it, or pick another name.`);
    }
    return {
      tool: "create_meal_prep",
      summary: `Create meal prep "${p.name}" (${plural(p.portions, "portion")} per batch)`,
      lines: [
        `${p.name}: ${plural(p.portions, "portion")}, ${kcal(p.calories)}/portion${macros(p.protein_g, p.carbs_g, p.fat_g)}`,
        `Keeps ${p.fridge_days} days in the fridge, ${p.freezer_days} in the freezer, ${p.thaw_hours} h to defrost${p.tags.length ? `. Tags: ${p.tags.join(", ")}` : ""}`,
        `Ingredients: ${p.ingredients.map((i) => `${i.name}${i.quantity != null ? ` ${i.quantity}${i.unit ? ` ${i.unit}` : ""}` : ""}`).join(", ") || "none"}`,
      ],
      async apply() {
        const id = await saveMealPrep(
          ctx.db,
          {
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
            tags: p.tags,
            ingredients: p.ingredients.map((i) => ({ name: i.name, quantity: i.quantity, unit: i.unit })),
          },
          ctx.now,
        );
        await markAssistant(ctx.db, "meal_preps", [id]);
        return { result: { saved: 1, meal_prep_id: id }, rows: [{ op: "meal_prep", table: "meal_preps", id }] };
      },
    };
  },
};

const logCookedBatchTool: WriteTool = {
  definition: tool(
    "log_cooked_batch",
    "Record that the owner cooked a batch of a meal prep recipe, so its portions appear in stock (some can go straight into the freezer). The owner confirms first.",
    {
      meal_prep_id: { type: "string", description: "Recipe id from list_meal_preps" },
      portions: { type: ["integer", "null"], description: "Portions made, or null for the recipe's usual number" },
      frozen: { type: ["integer", "null"], description: "Portions that go straight into the freezer, or null for none" },
      day: { type: "string", description: DATE_DESC },
      time: nullableString(TIME_DESC),
      notes: nullableString("Optional note"),
    },
  ),
  async prepare(ctx, input) {
    const p = z.object({ meal_prep_id: z.string().min(1), portions: int(1, 40).nullable(), frozen: int(0, 40).nullable(), day, time, notes: optText(500) }).parse(input);
    logDay(ctx, p.day, 14);
    const recipe = (await listMealPreps(ctx.db)).find((r) => r.id === p.meal_prep_id);
    if (!recipe) throw new Error(`No meal prep recipe with id ${p.meal_prep_id}`);
    const portions = p.portions ?? recipe.portions;
    const frozen = p.frozen ?? 0;
    if (frozen > portions) throw new Error(`Only ${portions} portions were made, cannot freeze ${frozen}`);
    const t = when(ctx, p.day, p.time, "prep");
    return {
      tool: "log_cooked_batch",
      summary: `Log a cooked batch of ${recipe.name} (${plural(portions, "portion")})`,
      lines: [`${p.day} ${hhmm(t.ms, ctx.timeZone)}: ${recipe.name}, ${plural(portions, "portion")}${frozen ? `, ${frozen} straight to the freezer` : ", all in the fridge"}`],
      async apply() {
        const id = await logBatch(ctx.db, { mealPrepId: recipe.id, portions, frozen, cookedAtMs: t.ms, timeZone: ctx.timeZone, notes: p.notes });
        await markAssistant(ctx.db, "meal_prep_batches", [id]);
        return { result: { saved: 1, batch_id: id }, rows: [{ op: "batch", table: "meal_prep_batches", id }] };
      },
    };
  },
};

const prepPortionsTool: WriteTool = {
  definition: tool(
    "prep_portions",
    "Move portions of a cooked batch (from meal_prep_stock): eat (from the fridge; also logs the food with the recipe's macros), freeze (fridge to freezer), thaw (freezer to fridge), or discard (from the fridge or the freezer). The owner confirms first.",
    {
      batch_id: { type: "string", description: "Batch id from meal_prep_stock" },
      action: { type: "string", enum: ["eat", "freeze", "thaw", "discard"], description: "What happened to the portions" },
      portions: { type: "integer", description: "How many portions" },
      from: { type: ["string", "null"], enum: ["fridge", "freezer", null], description: "Only for discard: where they were; otherwise null" },
      day: { type: "string", description: DATE_DESC },
      time: nullableString(TIME_DESC),
    },
  ),
  async prepare(ctx, input) {
    const p = z
      .object({ batch_id: z.string().min(1), action: z.enum(["eat", "freeze", "thaw", "discard"]), portions: int(1, 40), from: z.enum(["fridge", "freezer"]).nullable(), day, time })
      .parse(input);
    logDay(ctx, p.day, 14);
    const [stock] = await loadStock(ctx.db, { batchId: p.batch_id, includeFinished: true });
    if (!stock) throw new Error(`No batch with id ${p.batch_id}`);
    const fromLoc = p.action === "thaw" ? "freezer" : p.action === "discard" ? (p.from ?? "fridge") : "fridge";
    const there = fromLoc === "freezer" ? stock.freezerCount : stock.fridgeCount;
    if (p.portions > there) throw new Error(`Only ${plural(there, "portion")} of ${stock.batch.name} in the ${fromLoc}`);
    const recipe = (await listMealPreps(ctx.db)).find((r) => r.id === stock.batch.mealPrepId);
    const t = when(ctx, p.day, p.time, p.action === "eat" ? "prep" : null);
    const verb = { eat: "Eat", freeze: "Freeze", thaw: "Defrost", discard: "Throw out" }[p.action];
    const food = p.action === "eat" && recipe ? `, logs ${kcal(recipe.calories == null ? null : recipe.calories * p.portions)}` : "";
    return {
      tool: "prep_portions",
      summary: `${verb} ${plural(p.portions, "portion")} of ${stock.batch.name}`,
      lines: [`${p.day} ${hhmm(t.ms, ctx.timeZone)}: ${verb.toLowerCase()} ${plural(p.portions, "portion")} of ${stock.batch.name} (cooked ${stock.batch.localDay}) from the ${fromLoc}${food}`],
      async apply() {
        const id = await addMove(ctx.db, { batchId: p.batch_id, kind: p.action, fromLoc, portions: p.portions, atMs: t.ms, timeZone: ctx.timeZone });
        const [move] = await ctx.db.all<{ food_entry_id: string | null }>("SELECT food_entry_id FROM meal_prep_moves WHERE id = ?", [id]);
        if (move?.food_entry_id) await markAssistant(ctx.db, "food_entries", [move.food_entry_id]);
        return { result: { saved: 1, move_id: id, food_entry_id: move?.food_entry_id ?? null }, rows: [{ op: "move", table: "meal_prep_moves", id }] };
      },
    };
  },
};

// ---- shopping list --------------------------------------------------------------------------

/** Run a shopping-list change and record exactly what it did, so undo can reverse a merge too. */
async function shoppingChange(db: SqlDriver, change: () => Promise<unknown>): Promise<ActionRow[]> {
  const snapshot = async () =>
    new Map(
      (await db.all<{ id: string; quantity: number | null }>("SELECT id, quantity FROM shopping_list_items WHERE deleted_at IS NULL")).map((r) => [r.id, r.quantity]),
    );
  const before = await snapshot();
  await change();
  const after = await snapshot();
  const rows: ActionRow[] = [];
  for (const [id, qty] of after) {
    if (!before.has(id)) rows.push({ op: "shopping_insert", table: "shopping_list_items", id });
    else if (before.get(id) !== qty) rows.push({ op: "shopping_quantity", table: "shopping_list_items", id, before: before.get(id) ?? null, after: qty });
  }
  const inserted = rows.filter((r) => r.op === "shopping_insert").map((r) => r.id);
  if (inserted.length) await markAssistant(db, "shopping_list_items", inserted);
  return rows;
}

const addShoppingItemsTool: WriteTool = {
  definition: tool(
    "add_shopping_items",
    "Put items on the shopping list. An item already on the list (same name and unit, not ticked) gets the quantities added. For a recipe's ingredients use add_recipe_to_shopping. The owner confirms first.",
    {
      items: {
        type: "array",
        description: "1 to 60 items",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["name", "quantity", "unit"],
          properties: { name: { type: "string" }, quantity: nullableNumber("Amount, or null"), unit: nullableString("g, kg, ml, l, units...") },
        },
      },
    },
  ),
  async prepare(ctx, input) {
    const p = z.object({ items: z.array(ingredient).min(1).max(60) }).parse(input);
    return {
      tool: "add_shopping_items",
      summary: `Add ${plural(p.items.length, "item")} to the shopping list`,
      lines: p.items.map((i) => `${i.name}${i.quantity != null ? `: ${i.quantity}${i.unit ? ` ${i.unit}` : ""}` : ""}`),
      async apply() {
        const rows = await inTransaction(ctx.db, () =>
          shoppingChange(ctx.db, async () => {
            for (const i of p.items) await addShoppingItem(ctx.db, { name: i.name, quantity: i.quantity, unit: i.unit }, ctx.now);
          }),
        );
        return { result: { saved: p.items.length, new_lines: rows.filter((r) => r.op === "shopping_insert").length }, rows };
      },
    };
  },
};

const addRecipeToShoppingTool: WriteTool = {
  definition: tool(
    "add_recipe_to_shopping",
    "Put the ingredients of meal prep recipes on the shopping list, scaled by the number of batches to cook. The owner confirms first.",
    {
      recipes: {
        type: "array",
        description: "1 to 10 recipes",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["meal_prep_id", "batches"],
          properties: { meal_prep_id: { type: "string", description: "Id from list_meal_preps" }, batches: { type: "integer", description: "Batches to cook" } },
        },
      },
    },
  ),
  async prepare(ctx, input) {
    const p = z.object({ recipes: z.array(z.object({ meal_prep_id: z.string().min(1), batches: int(1, 10) })).min(1).max(10) }).parse(input);
    const all = await listMealPreps(ctx.db);
    const picks = p.recipes.map((r) => {
      const recipe = all.find((x) => x.id === r.meal_prep_id);
      if (!recipe) throw new Error(`No meal prep recipe with id ${r.meal_prep_id}`);
      if (recipe.ingredients.length === 0) throw new Error(`"${recipe.name}" has no ingredients to add`);
      return { recipe, batches: r.batches };
    });
    return {
      tool: "add_recipe_to_shopping",
      summary: `Add the ingredients of ${plural(picks.length, "recipe")} to the shopping list`,
      lines: picks.map(({ recipe, batches }) => `${recipe.name} x${batches}: ${recipe.ingredients.map((i) => i.name).join(", ")}`),
      async apply() {
        // addRecipesToShopping runs its own transaction.
        const rows = await shoppingChange(ctx.db, () => addRecipesToShopping(ctx.db, picks.map(({ recipe, batches }) => ({ mealPrepId: recipe.id, batches })), ctx.now));
        return { result: { saved: true, lines_changed: rows.length }, rows };
      },
    };
  },
};

// ---- drinks, measurements, notes, goals -----------------------------------------------------

const logDrinkTool: WriteTool = {
  definition: tool("log_drink", "Add an alcoholic drink to the drink log. The owner confirms first.", {
    name: { type: "string", description: "e.g. 'Beer', 'Red wine'" },
    volume_ml: { type: "number", description: "Volume drunk in ml" },
    abv_percent: { type: "number", description: "Alcohol by volume, % (e.g. 5 for beer, 13 for wine)" },
    day: { type: "string", description: DATE_DESC },
    time: nullableString(TIME_DESC),
    notes: nullableString("Optional note"),
  }),
  async prepare(ctx, input) {
    const p = z.object({ name: text(120), volume_ml: num(1, 3000), abv_percent: num(0, 80), day, time, notes: optText(500) }).parse(input);
    logDay(ctx, p.day);
    const t = when(ctx, p.day, p.time, null);
    const grams = Math.round(alcoholGrams(p.volume_ml, p.abv_percent) * 10) / 10;
    return {
      tool: "log_drink",
      summary: `Log ${p.name}, ${p.volume_ml} ml at ${p.abv_percent}% (${grams} g alcohol)`,
      lines: [`${p.day} ${hhmm(t.ms, ctx.timeZone)}: ${p.name}, ${p.volume_ml} ml, ${p.abv_percent}% ABV, ${grams} g alcohol`],
      async apply() {
        const id = await insertDrinkEntry(ctx.db, { drunkAtMs: t.ms, offsetMin: t.offsetMin, name: p.name, volumeMl: p.volume_ml, abvPercent: p.abv_percent, notes: p.notes }, stamp(ctx));
        return { result: { saved: 1, entry_id: id, alcohol_g: grams }, rows: [{ op: "insert", table: "drink_entries", id }] };
      },
    };
  },
};

const logMeasurementTool: WriteTool = {
  definition: tool(
    "log_measurement",
    "Add a manual measurement: weight on another scale, blood pressure (value_num systolic, value_num2 diastolic), glucose, a supplement taken, a symptom. kind is lower_snake_case and should reuse an existing kind from list_metrics. The owner confirms first.",
    {
      kind: { type: "string", description: "e.g. weight, blood_pressure, glucose, supplement, symptom" },
      value_num: nullableNumber("Main value"),
      value_num2: nullableNumber("Second value of a pair (diastolic), or null"),
      value_text: nullableString("For non-numeric entries, e.g. supplement name or symptom"),
      unit: nullableString("e.g. kg, mmHg, mg/dL"),
      day: { type: "string", description: DATE_DESC },
      time: nullableString(TIME_DESC),
      notes: nullableString("Optional note"),
    },
  ),
  async prepare(ctx, input) {
    const p = z
      .object({
        kind: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/, "kind is lower_snake_case, up to 40 characters"),
        value_num: optNum(-1e6, 1e6),
        value_num2: optNum(-1e6, 1e6),
        value_text: optText(200),
        unit: optText(20),
        day,
        time,
        notes: optText(500),
      })
      .refine((v) => v.value_num != null || v.value_text, "give value_num or value_text")
      .parse(input);
    logDay(ctx, p.day);
    const t = when(ctx, p.day, p.time, null);
    const value = [p.value_num, p.value_num2].filter((v) => v != null).join("/") || p.value_text;
    return {
      tool: "log_measurement",
      summary: `Log ${p.kind}: ${value}${p.unit ? ` ${p.unit}` : ""}`,
      lines: [`${p.day} ${hhmm(t.ms, ctx.timeZone)}: ${p.kind} ${value}${p.unit ? ` ${p.unit}` : ""}${p.value_num != null && p.value_text ? ` (${p.value_text})` : ""}`],
      async apply() {
        const id = await insertMeasurement(
          ctx.db,
          { measuredAtMs: t.ms, offsetMin: t.offsetMin, kind: p.kind, valueNum: p.value_num, valueNum2: p.value_num2, valueText: p.value_text, unit: p.unit, notes: p.notes },
          stamp(ctx),
        );
        return { result: { saved: 1, entry_id: id }, rows: [{ op: "insert", table: "manual_measurements", id }] };
      },
    };
  },
};

const addDayNoteTool: WriteTool = {
  definition: tool(
    "add_day_note",
    "Create the daily check-in for a day (mood and energy 1 to 5, and a note in the owner's words). Only if that day has no note yet: existing notes are edited by the owner in the app. The owner confirms first.",
    {
      day: { type: "string", description: DATE_DESC },
      mood: { type: ["integer", "null"], description: "1 (very bad) to 5 (very good), or null" },
      energy: { type: ["integer", "null"], description: "1 to 5, or null" },
      note: { type: "string", description: "The note" },
    },
  ),
  async prepare(ctx, input) {
    const scale = int(1, 5).nullable();
    const p = z.object({ day, mood: scale, energy: scale, note: z.string().trim().max(4000) }).parse(input);
    logDay(ctx, p.day, 30);
    if (await dayNoteExists(ctx.db, p.day)) throw new Error(`${p.day} already has a note. The owner can edit it in the app.`);
    return {
      tool: "add_day_note",
      summary: `Add the note for ${p.day}`,
      lines: [`${p.day}: mood ${p.mood ?? "-"}, energy ${p.energy ?? "-"}. ${p.note}`],
      async apply() {
        const id = await insertDayNote(ctx.db, { localDay: p.day, mood: p.mood, energy: p.energy, body: p.note }, stamp(ctx));
        return { result: { saved: 1, note_id: id }, rows: [{ op: "insert", table: "day_notes", id }] };
      },
    };
  },
};

const createGoalTool: WriteTool = {
  definition: tool(
    "create_goal",
    "Create a goal. target_kind: sample (a synced metric, use its exact name), manual (a manual measurement kind), food (a food_entries column: calories, protein_g, carbs_g, fat_g), drink (metric alcohol_g), none (free text, no number). The daily calorie target is the owner's to set on the Food screen; do not create it here. The owner confirms first.",
    {
      title: { type: "string", description: "e.g. '10,000 steps a day'" },
      target_kind: { type: "string", enum: ["sample", "manual", "food", "drink", "none"], description: "Where the number comes from" },
      metric: nullableString("Metric, kind or column; null for none"),
      comparator: { type: ["string", "null"], enum: [">=", "<=", null], description: "null for none" },
      target_num: nullableNumber("Target value; null for none"),
      unit: nullableString("Unit of the target"),
      period: { type: "string", enum: ["day", "week", "month"], description: "Period the target applies to" },
      start_day: { type: "string", description: DATE_DESC },
      end_day: nullableString(`${DATE_DESC}, or null for open-ended`),
    },
  ),
  async prepare(ctx, input) {
    const p = z
      .object({
        title: text(120),
        target_kind: z.enum(["sample", "manual", "food", "drink", "none"]),
        metric: optText(80),
        comparator: z.enum([">=", "<="]).nullable(),
        target_num: optNum(-1e7, 1e7),
        unit: optText(20),
        period: z.enum(["day", "week", "month"]),
        start_day: day,
        end_day: day.nullable(),
      })
      .refine((g) => g.target_kind === "none" || (g.metric && g.comparator && g.target_num != null), "a measurable goal needs metric, comparator and target_num")
      .refine((g) => !g.end_day || g.end_day >= g.start_day, "end_day is before start_day")
      .refine((g) => !(g.target_kind === "food" && g.metric === "calories" && g.period === "day"), "the daily calorie target is set by the owner on the Food screen")
      .parse(input);
    const today = localDay(ctx.now, ctx.timeZone);
    if (p.start_day < addDays(today, -366) || p.start_day > addDays(today, 366)) throw new Error("start_day must be within a year of today");
    const target = p.target_kind === "none" ? "" : ` (${p.metric} ${p.comparator} ${p.target_num}${p.unit ? ` ${p.unit}` : ""} per ${p.period})`;
    return {
      tool: "create_goal",
      summary: `Create goal "${p.title}"`,
      lines: [`${p.title}${target}, from ${p.start_day}${p.end_day ? ` to ${p.end_day}` : ""}`],
      async apply() {
        const none = p.target_kind === "none";
        const id = await insertGoal(
          ctx.db,
          {
            title: p.title,
            targetKind: p.target_kind,
            metric: none ? null : p.metric,
            comparator: none ? null : p.comparator,
            targetNum: none ? null : p.target_num,
            unit: p.unit,
            period: p.period,
            startDay: p.start_day,
            endDay: p.end_day,
          },
          stamp(ctx),
        );
        return { result: { saved: 1, goal_id: id }, rows: [{ op: "insert", table: "goals", id }] };
      },
    };
  },
};

/** Fixed order (part of the cached prompt prefix). */
export const WRITE_TOOLS: WriteTool[] = [
  logFoodTool,
  logSavedMealTool,
  saveMealTool,
  createMealPrepTool,
  logCookedBatchTool,
  prepPortionsTool,
  addShoppingItemsTool,
  addRecipeToShoppingTool,
  logDrinkTool,
  logMeasurementTool,
  addDayNoteTool,
  createGoalTool,
];
export const WRITE_TOOLS_BY_NAME = new Map(WRITE_TOOLS.map((t) => [t.definition.name, t]));

// ---- action log and undo --------------------------------------------------------------------

export type ActionStatus = "applied" | "declined" | "failed" | "undone";

export async function logAgentAction(
  db: SqlDriver,
  a: {
    conversationId: string;
    tool: string;
    summary: string;
    input: unknown;
    status: Exclude<ActionStatus, "undone">;
    rows?: ActionRow[];
    error?: string;
    deviceId: string;
    now: number;
  },
): Promise<string> {
  const id = uuidv7(a.now);
  await db.run(
    `INSERT INTO agent_actions
       (id, conversation_id, tool_name, summary, input_json, status, rows_json, error, decided_at_ms, created_at, updated_at, origin_device_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, a.conversationId, a.tool, a.summary, JSON.stringify(a.input), a.status, a.rows ? JSON.stringify(a.rows) : null, a.error ?? null, a.now, a.now, a.now, a.deviceId],
  );
  return id;
}

export interface AgentAction {
  id: string;
  conversationId: string | null;
  tool: string;
  summary: string;
  status: ActionStatus;
  error: string | null;
  decidedAtMs: number;
  rows: ActionRow[];
}

/** For an "Assistant activity" list: what it did, what was declined, and what can be undone. */
export async function listAgentActions(db: SqlDriver, conversationId?: string): Promise<AgentAction[]> {
  const rows = await db.all<Record<string, string | number | null>>(
    `SELECT id, conversation_id, tool_name, summary, status, error, decided_at_ms, rows_json FROM agent_actions
     WHERE deleted_at IS NULL ${conversationId ? "AND conversation_id = ?" : ""} ORDER BY decided_at_ms DESC, rowid DESC`,
    conversationId ? [conversationId] : [],
  );
  return rows.map((r) => ({
    id: r.id as string,
    conversationId: r.conversation_id as string | null,
    tool: r.tool_name as string,
    summary: r.summary as string,
    status: r.status as ActionStatus,
    error: r.error as string | null,
    decidedAtMs: r.decided_at_ms as number,
    rows: r.rows_json ? (JSON.parse(r.rows_json as string) as ActionRow[]) : [],
  }));
}

/**
 * Reverse an applied action with the app's own undo for each kind of row (newest effect first):
 * food entries via deleteFood, recipes via deleteMealPrep, batches via deleteBatch, portion moves via
 * undoMove, saved meals via deleteSavedMeal, shopping lines removed or their quantity put back.
 * Every row is checked against OP_TABLES before anything is touched. Returns the number of rows.
 */
export async function undoAgentAction(db: SqlDriver, actionId: string, now: number = Date.now()): Promise<number> {
  const [a] = await db.all<{ status: string; rows_json: string | null }>("SELECT status, rows_json FROM agent_actions WHERE id = ?", [actionId]);
  if (!a) throw new Error("Unknown action");
  if (a.status !== "applied") throw new Error(`Only applied actions can be undone (this one is ${a.status})`);
  const rows = a.rows_json ? (JSON.parse(a.rows_json) as ActionRow[]) : [];
  for (const r of rows) {
    if (!OP_TABLES[r.op]?.includes(r.table)) throw new Error(`Refusing to undo ${r.op} on table ${r.table}`);
  }
  for (const r of rows) {
    if (r.op !== "shopping_quantity") continue;
    const [cur] = await db.all<{ quantity: number | null }>("SELECT quantity FROM shopping_list_items WHERE id = ? AND deleted_at IS NULL", [r.id]);
    if (!cur || cur.quantity !== r.after) throw new Error("The shopping list has changed since; undo the item there instead");
  }
  for (const r of [...rows].reverse()) {
    switch (r.op) {
      case "food":
        await deleteFood(db, r.id, now);
        break;
      case "saved_meal":
        await deleteSavedMeal(db, r.id, now);
        break;
      case "meal_prep":
        await deleteMealPrep(db, r.id, now);
        break;
      case "batch":
        await deleteBatch(db, r.id, now);
        break;
      case "move":
        await undoMove(db, r.id, now);
        break;
      case "insert":
      case "shopping_insert":
        await db.run(`UPDATE ${r.table} SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL`, [now, now, r.id]);
        break;
      case "shopping_quantity":
        await db.run("UPDATE shopping_list_items SET quantity = ?, updated_at = ? WHERE id = ?", [r.before, now, r.id]);
        break;
    }
  }
  await db.run("UPDATE agent_actions SET status = 'undone', updated_at = ? WHERE id = ?", [now, actionId]);
  return rows.length;
}
