import type { SqlDriver } from "../../db/driver";

/**
 * What is stored on this phone, in words the owner recognises, for the privacy page.
 * Counts live rows only (soft-deleted rows are left out).
 */

export interface InventoryRow {
  label: string;
  count: number;
  /** First and last local day, where the data has days. */
  from: string | null;
  to: string | null;
}

const ITEMS: { label: string; table: string; live: boolean; day?: string }[] = [
  { label: "Health readings (synced and imported)", table: "health_samples", live: false, day: "local_day" },
  { label: "Food log entries", table: "food_entries", live: true, day: "local_day" },
  { label: "Meal photos", table: "food_photos", live: true },
  { label: "Drinks logged", table: "drink_entries", live: true, day: "local_day" },
  { label: "Measurements (weight, blood pressure...)", table: "manual_measurements", live: true, day: "local_day" },
  { label: "Day notes", table: "day_notes", live: true, day: "local_day" },
  { label: "Meal prep recipes", table: "meal_preps", live: true },
  { label: "Supermarket shops (what you paid)", table: "shopping_trips", live: true, day: "local_day" },
  { label: "Claude chats", table: "chat_conversations", live: true },
  { label: "Data sent to Claude (records)", table: "ai_disclosures", live: true },
];

export async function dataInventory(db: SqlDriver): Promise<InventoryRow[]> {
  const out: InventoryRow[] = [];
  for (const it of ITEMS) {
    const where = it.live ? "WHERE deleted_at IS NULL" : "";
    const range = it.day ? `, MIN(${it.day}) AS f, MAX(${it.day}) AS t` : ", NULL AS f, NULL AS t";
    try {
      const [r] = await db.all<{ n: number; f: string | null; t: string | null }>(`SELECT COUNT(*) AS n${range} FROM ${it.table} ${where}`);
      out.push({ label: it.label, count: r.n, from: r.f, to: r.t });
    } catch (err) {
      // A table not in this schema version yet: nothing stored. Anything else is a bug.
      if (!/no such table/i.test(String((err as Error)?.message))) throw err;
      out.push({ label: it.label, count: 0, from: null, to: null });
    }
  }
  return out;
}
