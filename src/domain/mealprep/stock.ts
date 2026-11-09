import { addDays, localDay } from "../../core/tz.js";

/**
 * Meal prep stock, folded from a batch and its portion moves, plus the defrost planner.
 * Pure functions: the data layer (./mealPrep.ts) loads rows and calls these.
 */

export type MoveKind = "freeze" | "thaw" | "eat" | "discard";
export type Location = "fridge" | "freezer";

export interface BatchInfo {
  id: string;
  mealPrepId: string;
  name: string;
  tags: string[];
  cookedAtMs: number;
  /** Local day the batch was cooked. */
  localDay: string;
  portions: number;
  fridgeDays: number;
  freezerDays: number;
  thawHours: number;
}

export interface Move {
  id: string;
  batchId: string;
  atMs: number;
  localDay: string;
  kind: MoveKind;
  fromLoc: Location;
  portions: number;
}

export interface FridgeLot {
  portions: number;
  /** When the lot can be eaten: cooking time, or thaw start + thaw_hours. */
  readyAtMs: number;
  /** Last local day the lot is good to eat. */
  eatBy: string;
  thawed: boolean;
}

export interface FreezerLot {
  portions: number;
  frozenDay: string;
  /** Last local day of good quality in the freezer. */
  bestBefore: string;
}

export interface BatchStock {
  batch: BatchInfo;
  fridge: FridgeLot[];
  freezer: FreezerLot[];
  fridgeCount: number;
  freezerCount: number;
  eaten: number;
  discarded: number;
  /** Portions still in the fridge or the freezer. */
  left: number;
  /** Portions moves asked for that were not in stock (only possible after a merge of two devices). */
  overdrawn: number;
}

/** Whole days a portion takes to thaw, rounded up. */
const thawDays = (thawHours: number) => Math.ceil(thawHours / 24);

const byEatBy = (a: FridgeLot, b: FridgeLot) => (a.eatBy < b.eatBy ? -1 : a.eatBy > b.eatBy ? 1 : a.readyAtMs - b.readyAtMs);
const byFrozen = (a: FreezerLot, b: FreezerLot) => (a.frozenDay < b.frozenDay ? -1 : a.frozenDay > b.frozenDay ? 1 : 0);

/** Take n portions out of lots in the given order, mutating them. Returns how many were missing. */
function take<L extends { portions: number }>(lots: L[], n: number, order: (a: L, b: L) => number, pick?: (l: L) => boolean): { taken: L[]; missing: number } {
  const taken: L[] = [];
  let need = n;
  for (const lot of [...lots].sort(order)) {
    if (need === 0) break;
    if (lot.portions === 0 || (pick && !pick(lot))) continue;
    const k = Math.min(lot.portions, need);
    lot.portions -= k;
    need -= k;
    taken.push({ ...lot, portions: k });
  }
  return { taken, missing: need };
}

/**
 * Replay the moves of one batch. All portions start in the fridge on the cooking day.
 * Portions always leave in the order that wastes least: the fridge lot that goes off first,
 * the oldest freezer lot. Eating prefers lots that are ready (already defrosted).
 */
export function foldBatch(batch: BatchInfo, moves: Move[]): BatchStock {
  let fridge: FridgeLot[] = [{ portions: batch.portions, readyAtMs: batch.cookedAtMs, eatBy: addDays(batch.localDay, batch.fridgeDays), thawed: false }];
  let freezer: FreezerLot[] = [];
  let eaten = 0;
  let discarded = 0;
  let overdrawn = 0;

  const ordered = moves.filter((m) => m.batchId === batch.id).sort((a, b) => a.atMs - b.atMs || (a.id < b.id ? -1 : 1));
  for (const m of ordered) {
    if (m.kind === "freeze") {
      const { taken, missing } = take(fridge, m.portions, byEatBy);
      const n = m.portions - missing;
      overdrawn += missing;
      if (n > 0 && taken.length) {
        freezer.push({ portions: n, frozenDay: m.localDay, bestBefore: addDays(m.localDay, batch.freezerDays) });
      }
    } else if (m.kind === "thaw") {
      const { missing } = take(freezer, m.portions, byFrozen);
      const n = m.portions - missing;
      overdrawn += missing;
      if (n > 0) {
        fridge.push({
          portions: n,
          readyAtMs: m.atMs + batch.thawHours * 3_600_000,
          eatBy: addDays(m.localDay, thawDays(batch.thawHours) + batch.fridgeDays),
          thawed: true,
        });
      }
    } else if (m.kind === "eat") {
      let { missing } = take(fridge, m.portions, byEatBy, (l) => l.readyAtMs <= m.atMs);
      if (missing) missing = take(fridge, missing, byEatBy).missing; // eaten half-thawed: still gone
      eaten += m.portions - missing;
      overdrawn += missing;
    } else {
      const { missing } = m.fromLoc === "freezer" ? take(freezer, m.portions, byFrozen) : take(fridge, m.portions, byEatBy);
      discarded += m.portions - missing;
      overdrawn += missing;
    }
    fridge = fridge.filter((l) => l.portions > 0);
    freezer = freezer.filter((l) => l.portions > 0);
  }

  const fridgeCount = fridge.reduce((s, l) => s + l.portions, 0);
  const freezerCount = freezer.reduce((s, l) => s + l.portions, 0);
  return {
    batch,
    fridge: fridge.sort(byEatBy),
    freezer: freezer.sort(byFrozen),
    fridgeCount,
    freezerCount,
    eaten,
    discarded,
    left: fridgeCount + freezerCount,
    overdrawn,
  };
}

/** How many portions a move can take right now. Moves beyond this are refused before writing. */
export function available(stock: BatchStock, kind: MoveKind, fromLoc: Location): number {
  if (kind === "thaw" || (kind === "discard" && fromLoc === "freezer")) return stock.freezerCount;
  return stock.fridgeCount;
}

export type Alert =
  | { kind: "expired"; batchId: string; name: string; portions: number; eatBy: string }
  | { kind: "eat_soon"; batchId: string; name: string; portions: number; eatBy: string }
  | { kind: "freezer_old"; batchId: string; name: string; portions: number; bestBefore: string }
  | { kind: "thawing"; batchId: string; name: string; portions: number; readyAtMs: number };

/** Things to act on now: food past its eat-by day, due today or tomorrow, old in the freezer, or still defrosting. */
export function stockAlerts(stocks: BatchStock[], today: string, nowMs: number): Alert[] {
  const out: Alert[] = [];
  const tomorrow = addDays(today, 1);
  for (const s of stocks) {
    const { id: batchId, name } = s.batch;
    for (const l of s.fridge) {
      if (l.eatBy < today) out.push({ kind: "expired", batchId, name, portions: l.portions, eatBy: l.eatBy });
      else if (l.eatBy <= tomorrow) out.push({ kind: "eat_soon", batchId, name, portions: l.portions, eatBy: l.eatBy });
      if (l.readyAtMs > nowMs) out.push({ kind: "thawing", batchId, name, portions: l.portions, readyAtMs: l.readyAtMs });
    }
    for (const l of s.freezer) {
      if (l.bestBefore < today) out.push({ kind: "freezer_old", batchId, name, portions: l.portions, bestBefore: l.bestBefore });
    }
  }
  const rank = { expired: 0, eat_soon: 1, thawing: 2, freezer_old: 3 };
  return out.sort((a, b) => rank[a.kind] - rank[b.kind]);
}

export interface ThawAdvice {
  /** Day to take the portions out of the freezer and put them in the fridge. */
  day: string;
  /** The day they are for. */
  forDay: string;
  batchId: string;
  name: string;
  portions: number;
  /** The right day to start was already past: defrost now, they will be ready late. */
  late: boolean;
}

export interface WasteRisk {
  batchId: string;
  name: string;
  portions: number;
  eatBy: string;
}

/** A planned meal: which batch is eaten that day, and where it comes from. */
export interface PlannedMeal {
  day: string;
  batchId: string;
  name: string;
  portions: number;
  /** "fridge": cooked and kept in the fridge. "thawed": out of the freezer for this day. */
  from: "fridge" | "thawed";
  /** Fridge: the last day it is good to eat. Thawed: the day it comes out of the freezer. */
  eatBy: string | null;
  thawDay: string | null;
}

export interface Plan {
  thaw: ThawAdvice[];
  /** Day by day, what the plan eats, in the order it is eaten. */
  meals: PlannedMeal[];
  /** Days in the horizon when fridge and freezer together cannot cover the planned portions. */
  short: { day: string; missing: number }[];
  /** Last day of the unbroken run (from today) that is fully covered, or null if today is short. */
  coveredThrough: string | null;
  /** Fridge portions the plan will not reach before their eat-by day: freeze them now or eat extra. */
  waste: WasteRisk[];
  /** Fridge portions ready to eat now and portions in the freezer. */
  fridgeNow: number;
  freezerNow: number;
}

export interface PlanOptions {
  today: string;
  nowMs: number;
  timeZone: string;
  /** Prep portions eaten per day, for example 1 for dinners or 2 for lunch and dinner. */
  portionsPerDay: number;
  /** Portions already eaten today, subtracted from today's need. */
  eatenToday?: number;
  /**
   * Tuppers not eaten on a day (./skips.ts): skipped by hand, or a meal they are for logged as
   * something else (eaten out). Subtracted from that day's need, so the rest move on a day.
   */
  skips?: Map<string, number>;
  horizonDays?: number;
}

/**
 * Simulate the next days, eating portionsPerDay a day from the fridge (the lot that goes off
 * first), and when the fridge cannot cover a day, defrost just enough from the freezer
 * (the lot that is oldest in quality terms), starting thaw_hours before that day.
 */
export function planDefrost(stocks: BatchStock[], opts: PlanOptions): Plan {
  const horizon = opts.horizonDays ?? 7;
  const perDay = Math.max(0, Math.trunc(opts.portionsPerDay));
  type FLot = { batch: BatchInfo; portions: number; readyDay: string; eatBy: string; thawed: boolean };
  type ZLot = { batch: BatchInfo; portions: number; bestBefore: string; frozenDay: string };

  const fridge: FLot[] = [];
  const freezer: ZLot[] = [];
  for (const s of stocks) {
    for (const l of s.fridge) {
      // Ready during the day counts for that day (meals are later than the thaw finishing, usually).
      const readyDay = l.readyAtMs <= opts.nowMs ? opts.today : localDay(l.readyAtMs, opts.timeZone);
      fridge.push({ batch: s.batch, portions: l.portions, readyDay, eatBy: l.eatBy, thawed: l.thawed });
    }
    for (const l of s.freezer) freezer.push({ batch: s.batch, portions: l.portions, bestBefore: l.bestBefore, frozenDay: l.frozenDay });
  }
  fridge.sort((a, b) => (a.eatBy < b.eatBy ? -1 : a.eatBy > b.eatBy ? 1 : 0));
  freezer.sort((a, b) => (a.bestBefore < b.bestBefore ? -1 : a.bestBefore > b.bestBefore ? 1 : a.frozenDay < b.frozenDay ? -1 : 1));

  const plan: Plan = {
    thaw: [],
    meals: [],
    short: [],
    coveredThrough: null,
    waste: [],
    fridgeNow: fridge.filter((l) => l.readyDay === opts.today && l.eatBy >= opts.today).reduce((s, l) => s + l.portions, 0),
    freezerNow: freezer.reduce((s, l) => s + l.portions, 0),
  };
  let unbroken = true;

  for (let i = 0; i < horizon; i++) {
    const day = addDays(opts.today, i);
    let need = Math.max(0, perDay - (i === 0 ? (opts.eatenToday ?? 0) : 0) - (opts.skips?.get(day) ?? 0));

    for (const l of fridge) {
      if (need === 0) break;
      if (l.portions === 0 || l.readyDay > day || l.eatBy < day) continue;
      const k = Math.min(l.portions, need);
      l.portions -= k;
      need -= k;
      plan.meals.push({ day, batchId: l.batch.id, name: l.batch.name, portions: k, from: l.thawed ? "thawed" : "fridge", eatBy: l.eatBy, thawDay: null });
    }

    for (const z of freezer) {
      if (need === 0) break;
      if (z.portions === 0) continue;
      const k = Math.min(z.portions, need);
      z.portions -= k;
      need -= k;
      const ideal = addDays(day, -thawDays(z.batch.thawHours));
      const late = ideal < opts.today;
      const start = late ? opts.today : ideal;
      plan.meals.push({ day, batchId: z.batch.id, name: z.batch.name, portions: k, from: "thawed", eatBy: null, thawDay: start });
      const same = plan.thaw.find((t) => t.day === start && t.forDay === day && t.batchId === z.batch.id);
      if (same) same.portions += k;
      else plan.thaw.push({ day: start, forDay: day, batchId: z.batch.id, name: z.batch.name, portions: k, late });
    }

    if (need > 0) {
      plan.short.push({ day, missing: need });
      unbroken = false;
    } else if (unbroken) {
      plan.coveredThrough = day;
    }

    // Lots already past their day before the plan started are alerts (stockAlerts), not waste risks.
    for (const l of fridge) {
      if (l.portions > 0 && l.eatBy === day) {
        plan.waste.push({ batchId: l.batch.id, name: l.batch.name, portions: l.portions, eatBy: l.eatBy });
        l.portions = 0;
      }
    }
  }
  plan.thaw.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
  return plan;
}
