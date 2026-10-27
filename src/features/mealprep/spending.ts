import { withTransaction } from "../../db/tx";
import { localDateTimeToMs, localDay, tzOffsetMinutes } from "../../core/tz";
import { uuidv7 } from "../../core/uuidv7";
import type { SqlDriver } from "../../db/driver";
import { deviceId } from "../../db/settings";
import { createLogger } from "../../core/log";

const log = createLogger("mealprep.spending");

/**
 * Supermarket spending (shopping_trips, schema 0011): what each shop cost and where, summed per
 * month and per supermarket. Amounts are in the app currency (getCurrency in alcohol.ts).
 */

export interface Trip {
  id: string;
  shop: string;
  amount: number;
  day: string;
  atMs: number;
  items: number | null;
  notes: string | null;
  createdBy: "user" | "assistant";
}

export interface NewTrip {
  shop: string;
  amount: number | null;
  /** Local day it was paid; today by default. */
  day?: string;
  timeZone: string;
  notes?: string | null;
  /** Clear the ticked shopping list items and count them on the trip. */
  clearTicked?: boolean;
}

export const MAX_AMOUNT = 10_000;

/** Save a shop. A past day is stored at noon (the time is not asked); today at the current time. Returns its id. */
export async function addTrip(db: SqlDriver, t: NewTrip, by: "user" | "assistant" = "user", nowMs: number = Date.now()): Promise<string> {
  const shop = t.shop.trim().replace(/\s+/g, " ");
  if (!shop) throw new Error("Which supermarket?");
  if (shop.length > 60) throw new Error("The supermarket name is at most 60 characters");
  if (t.amount === null || !Number.isFinite(t.amount) || t.amount <= 0) throw new Error("Enter what you paid");
  if (t.amount > MAX_AMOUNT) throw new Error(`What you paid must be at most ${MAX_AMOUNT.toLocaleString()}`);
  const today = localDay(nowMs, t.timeZone);
  const day = t.day ?? today;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error("Pick a day");
  if (day > today) throw new Error("That day has not happened yet");
  const at = day === today ? nowMs : localDateTimeToMs(day, "12:00", t.timeZone).ms;
  const amount = Math.round(t.amount * 100) / 100;
  const id = uuidv7(nowMs);
  const dev = await deviceId(db, nowMs);

  await withTransaction(db, async () => {
    let items: number | null = null;
    if (t.clearTicked) {
      const [r] = await db.all<{ n: number }>("SELECT COUNT(*) AS n FROM shopping_list_items WHERE deleted_at IS NULL AND checked = 1");
      items = r.n;
      await db.run("UPDATE shopping_list_items SET deleted_at = ?, updated_at = ? WHERE deleted_at IS NULL AND checked = 1", [nowMs, nowMs]);
    }
    await db.run(
      `INSERT INTO shopping_trips (id, shop, amount, paid_at_ms, offset_min, local_day, items, notes, created_by, created_at, updated_at, origin_device_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, shop, amount, at, tzOffsetMinutes(at, t.timeZone), day, items, t.notes?.trim() || null, by, nowMs, nowMs, dev],
    );
  });
  log.info("shop logged", { by, clearedItems: Boolean(t.clearTicked) });
  return id;
}

interface TripRow {
  id: string;
  shop: string;
  amount: number;
  local_day: string;
  paid_at_ms: number;
  items: number | null;
  notes: string | null;
  created_by: "user" | "assistant";
}

/** Shops paid between two local days, newest first. */
export async function listTrips(db: SqlDriver, from: string, to: string): Promise<Trip[]> {
  const rows = await db.all<TripRow>(
    `SELECT id, shop, amount, local_day, paid_at_ms, items, notes, created_by FROM shopping_trips
     WHERE deleted_at IS NULL AND local_day BETWEEN ? AND ? ORDER BY paid_at_ms DESC, id DESC`,
    [from, to],
  );
  return rows.map((r) => ({
    id: r.id,
    shop: r.shop,
    amount: r.amount,
    day: r.local_day,
    atMs: r.paid_at_ms,
    items: r.items,
    notes: r.notes,
    createdBy: r.created_by,
  }));
}

export async function deleteTrip(db: SqlDriver, id: string, nowMs: number = Date.now()): Promise<void> {
  await db.run("UPDATE shopping_trips SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL", [nowMs, nowMs, id]);
}

/** Undo a delete. The shopping list items a trip cleared stay cleared. */
export async function restoreTrip(db: SqlDriver, id: string, nowMs: number = Date.now()): Promise<void> {
  await db.run("UPDATE shopping_trips SET deleted_at = NULL, updated_at = ? WHERE id = ? AND deleted_at IS NOT NULL", [nowMs, id]);
}

/** Supermarkets used before, most recent first, in their latest spelling (for one-tap picking). */
export async function knownShops(db: SqlDriver, limit = 8): Promise<string[]> {
  const rows = await db.all<{ shop: string }>(
    `SELECT shop FROM shopping_trips t
     WHERE deleted_at IS NULL AND paid_at_ms = (
       SELECT MAX(paid_at_ms) FROM shopping_trips u WHERE u.deleted_at IS NULL AND lower(u.shop) = lower(t.shop))
     GROUP BY lower(shop) ORDER BY MAX(paid_at_ms) DESC LIMIT ?`,
    [limit],
  );
  return rows.map((r) => r.shop);
}

export interface ShopTotal {
  shop: string;
  total: number;
  trips: number;
}

export interface Spending {
  total: number;
  trips: number;
  /** Per supermarket (case-insensitive, latest spelling), biggest first. */
  shops: ShopTotal[];
}

export async function spending(db: SqlDriver, from: string, to: string): Promise<Spending> {
  const trips = await listTrips(db, from, to);
  const by = new Map<string, ShopTotal>();
  for (const t of trips) {
    // Newest first, so the first spelling seen is the latest.
    const k = t.shop.toLowerCase();
    const s = by.get(k) ?? by.set(k, { shop: t.shop, total: 0, trips: 0 }).get(k)!;
    s.total += t.amount;
    s.trips++;
  }
  const cents = (n: number) => Math.round(n * 100) / 100;
  return {
    total: cents(trips.reduce((s, t) => s + t.amount, 0)),
    trips: trips.length,
    shops: [...by.values()].map((s) => ({ ...s, total: cents(s.total) })).sort((a, b) => b.total - a.total || a.shop.localeCompare(b.shop)),
  };
}

// ---- Months ("2026-10") ----

export const monthOf = (day: string) => day.slice(0, 7);

export function addMonths(month: string, n: number): string {
  const [y, m] = month.split("-").map(Number);
  const i = y * 12 + (m - 1) + n;
  return `${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, "0")}`;
}

/** First and last local day of a month. */
export function monthRange(month: string): { from: string; to: string } {
  const [y, m] = month.split("-").map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from: `${month}-01`, to: `${month}-${String(last).padStart(2, "0")}` };
}

/** Total paid per month, oldest first, for the n months ending with the given one. */
export async function monthlySpending(db: SqlDriver, lastMonth: string, n: number): Promise<{ month: string; total: number }[]> {
  const first = addMonths(lastMonth, -(n - 1));
  const rows = await db.all<{ month: string; total: number }>(
    `SELECT substr(local_day, 1, 7) AS month, SUM(amount) AS total FROM shopping_trips
     WHERE deleted_at IS NULL AND local_day BETWEEN ? AND ? GROUP BY month`,
    [monthRange(first).from, monthRange(lastMonth).to],
  );
  const by = new Map(rows.map((r) => [r.month, Math.round(r.total * 100) / 100]));
  return Array.from({ length: n }, (_, i) => addMonths(first, i)).map((month) => ({ month, total: by.get(month) ?? 0 }));
}
