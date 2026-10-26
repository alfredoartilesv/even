import { uuidv7 } from "../../core/uuidv7";
import type { SqlDriver } from "../../db/driver";
import { deviceId } from "../../db/settings";

/** The supermarket list (shopping_list_items, schema 0003). */

export interface ShoppingItem {
  id: string;
  name: string;
  quantity: number | null;
  unit: string | null;
  checked: boolean;
}

/** Units folded into one base unit so "500 g" and "1 kg" add up. Anything else is kept as typed. */
const UNITS: Record<string, [base: string, factor: number]> = {
  g: ["g", 1],
  gr: ["g", 1],
  gram: ["g", 1],
  grams: ["g", 1],
  kg: ["g", 1000],
  ml: ["ml", 1],
  cl: ["ml", 10],
  dl: ["ml", 100],
  l: ["ml", 1000],
  litre: ["ml", 1000],
  liter: ["ml", 1000],
};

/** Base unit and scaled quantity. Unknown units are trimmed and lower-cased. */
export function normalizeUnit(quantity: number | null, unit: string | null): { quantity: number | null; unit: string | null } {
  const u = unit?.trim().toLowerCase() || null;
  if (!u) return { quantity, unit: null };
  const known = UNITS[u];
  if (!known) return { quantity, unit: u };
  return { quantity: quantity === null ? null : quantity * known[1], unit: known[0] };
}

const round = (n: number) => Math.round(n * 100) / 100;

/** "1500 g" -> "1.5 kg", "250 ml" stays. No quantity -> "". */
export function formatQuantity(quantity: number | null, unit: string | null): string {
  if (quantity === null) return unit ?? "";
  if (unit === "g" && quantity >= 1000) return `${round(quantity / 1000)} kg`;
  if (unit === "ml" && quantity >= 1000) return `${round(quantity / 1000)} l`;
  return unit ? `${round(quantity)} ${unit}` : `${round(quantity)}`;
}

/** Plain text for the share sheet or the clipboard: open items only. */
export function listAsText(items: ShoppingItem[]): string {
  return items
    .filter((i) => !i.checked)
    .map((i) => {
      const q = formatQuantity(i.quantity, i.unit);
      return q ? `- ${i.name} (${q})` : `- ${i.name}`;
    })
    .join("\n");
}

export async function listShopping(db: SqlDriver): Promise<ShoppingItem[]> {
  const rows = await db.all<{ id: string; name: string; quantity: number | null; unit: string | null; checked: number }>(
    `SELECT id, name, quantity, unit, checked FROM shopping_list_items
     WHERE deleted_at IS NULL ORDER BY checked, name COLLATE NOCASE, unit`,
  );
  return rows.map((r) => ({ ...r, checked: r.checked === 1 }));
}

/**
 * Add an item, merging into an open (unchecked) item with the same name and unit.
 * Quantities add up; an item without a quantity just stays on the list.
 */
export async function addShoppingItem(
  db: SqlDriver,
  item: { name: string; quantity: number | null; unit: string | null; mealPrepId?: string | null },
  nowMs: number = Date.now(),
): Promise<void> {
  const name = item.name.trim();
  if (!name) throw new Error("Give the item a name");
  if (item.quantity !== null && !(item.quantity > 0)) throw new Error("Quantity must be more than 0");
  const { quantity, unit } = normalizeUnit(item.quantity, item.unit);

  const [open] = await db.all<{ id: string; quantity: number | null }>(
    `SELECT id, quantity FROM shopping_list_items
     WHERE deleted_at IS NULL AND checked = 0 AND lower(name) = lower(?) AND unit IS ?
     ORDER BY created_at LIMIT 1`,
    [name, unit],
  );
  if (open) {
    const sum = open.quantity === null ? quantity : quantity === null ? open.quantity : open.quantity + quantity;
    await db.run("UPDATE shopping_list_items SET quantity = ?, updated_at = ? WHERE id = ?", [sum, nowMs, open.id]);
    return;
  }
  await db.run(
    `INSERT INTO shopping_list_items (id, name, quantity, unit, checked, meal_prep_id, created_at, updated_at, origin_device_id)
     VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?)`,
    [uuidv7(nowMs), name, quantity, unit, item.mealPrepId ?? null, nowMs, nowMs, await deviceId(db, nowMs)],
  );
}

/**
 * Put the ingredients of recipes on the list, scaled by the number of batches to cook.
 * Returns how many ingredient lines were added or merged.
 */
export async function addRecipesToShopping(
  db: SqlDriver,
  picks: { mealPrepId: string; batches: number }[],
  nowMs: number = Date.now(),
): Promise<number> {
  let lines = 0;
  await db.exec("BEGIN");
  try {
    for (const { mealPrepId, batches } of picks) {
      if (!(batches > 0)) continue;
      const rows = await db.all<{ name: string; quantity: number | null; unit: string | null }>(
        `SELECT i.name, i.quantity, i.unit FROM meal_prep_ingredients i
         JOIN meal_preps p ON p.id = i.meal_prep_id AND p.deleted_at IS NULL
         WHERE i.meal_prep_id = ? AND i.deleted_at IS NULL ORDER BY i.sort_order`,
        [mealPrepId],
      );
      for (const r of rows) {
        await addShoppingItem(db, { ...r, quantity: r.quantity === null ? null : r.quantity * batches, mealPrepId }, nowMs);
        lines++;
      }
    }
    await db.exec("COMMIT");
  } catch (err) {
    await db.exec("ROLLBACK");
    throw err;
  }
  return lines;
}

export async function setShoppingChecked(db: SqlDriver, id: string, checked: boolean, nowMs: number = Date.now()): Promise<void> {
  await db.run("UPDATE shopping_list_items SET checked = ?, updated_at = ? WHERE id = ?", [checked ? 1 : 0, nowMs, id]);
}

export async function removeShoppingItem(db: SqlDriver, id: string, nowMs: number = Date.now()): Promise<void> {
  await db.run("UPDATE shopping_list_items SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL", [nowMs, nowMs, id]);
}

/** Remove the ticked items, or everything with all = true. */
export async function clearShopping(db: SqlDriver, opts: { all?: boolean } = {}, nowMs: number = Date.now()): Promise<void> {
  await db.run(
    `UPDATE shopping_list_items SET deleted_at = ?, updated_at = ? WHERE deleted_at IS NULL AND (? = 1 OR checked = 1)`,
    [nowMs, nowMs, opts.all ? 1 : 0],
  );
}
