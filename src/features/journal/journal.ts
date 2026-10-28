import { uuidv7 } from "../../core/uuidv7";
import type { SqlDriver } from "../../db/driver";
import { createLogger } from "../../core/log";

const log = createLogger("journal");

/**
 * Inserts for the logs that have no module of their own yet: drinks, manual measurements,
 * day notes and goals. Food is in food.ts, meal prep in mealPrep.ts. Used by the chat agent
 * (insert only, after the owner confirms) and available to the screens. Times are UTC ms +
 * offset; local_day is derived here the same way as migration 0002's backfill.
 */
export type CreatedBy = "user" | "assistant";

export interface Stamp {
  deviceId: string;
  createdBy: CreatedBy;
  now?: number;
}

function localDayOf(ms: number, offsetMin: number): string {
  return new Date(ms + offsetMin * 60_000).toISOString().slice(0, 10);
}

export interface MeasurementInput {
  measuredAtMs: number;
  offsetMin: number;
  kind: string;
  valueNum?: number | null;
  valueNum2?: number | null;
  valueText?: string | null;
  unit?: string | null;
  notes?: string | null;
}

export async function insertMeasurement(db: SqlDriver, m: MeasurementInput, s: Stamp): Promise<string> {
  const now = s.now ?? Date.now();
  const id = uuidv7(now);
  await db.run(
    `INSERT INTO manual_measurements
       (id, measured_at_ms, offset_min, local_day, kind, value_num, value_num2, value_text, unit, notes,
        created_by, created_at, updated_at, origin_device_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      m.measuredAtMs,
      m.offsetMin,
      localDayOf(m.measuredAtMs, m.offsetMin),
      m.kind,
      m.valueNum ?? null,
      m.valueNum2 ?? null,
      m.valueText ?? null,
      m.unit ?? null,
      m.notes ?? null,
      s.createdBy,
      now,
      now,
      s.deviceId,
    ],
  );
  log.info("measurement logged", { id, kind: m.kind, by: s.createdBy });
  return id;
}

export interface DayNoteInput {
  localDay: string;
  mood?: number | null;
  energy?: number | null;
  body: string;
}

/** Fails (UNIQUE) if the day already has a live note: notes are edited by the owner, not overwritten. */
export async function insertDayNote(db: SqlDriver, n: DayNoteInput, s: Stamp): Promise<string> {
  const now = s.now ?? Date.now();
  const id = uuidv7(now);
  await db.run(
    `INSERT INTO day_notes (id, local_day, mood, energy, body, created_by, created_at, updated_at, origin_device_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, n.localDay, n.mood ?? null, n.energy ?? null, n.body, s.createdBy, now, now, s.deviceId],
  );
  log.info("day note added", { id, by: s.createdBy });
  return id;
}

export async function dayNoteExists(db: SqlDriver, localDay: string): Promise<boolean> {
  const rows = await db.all("SELECT 1 FROM day_notes WHERE local_day = ? AND deleted_at IS NULL", [localDay]);
  return rows.length > 0;
}

export interface GoalInput {
  title: string;
  targetKind: "sample" | "manual" | "food" | "drink" | "none";
  metric?: string | null;
  comparator?: ">=" | "<=" | null;
  targetNum?: number | null;
  unit?: string | null;
  period: "day" | "week" | "month";
  startDay: string;
  endDay?: string | null;
  notes?: string | null;
}

export async function insertGoal(db: SqlDriver, g: GoalInput, s: Stamp): Promise<string> {
  const now = s.now ?? Date.now();
  const id = uuidv7(now);
  await db.run(
    `INSERT INTO goals
       (id, title, target_kind, metric, comparator, target_num, unit, period, start_day, end_day, notes,
        created_by, created_at, updated_at, origin_device_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      g.title,
      g.targetKind,
      g.metric ?? null,
      g.comparator ?? null,
      g.targetNum ?? null,
      g.unit ?? null,
      g.period,
      g.startDay,
      g.endDay ?? null,
      g.notes ?? null,
      s.createdBy,
      now,
      now,
      s.deviceId,
    ],
  );
  log.info("goal created", { id, kind: g.targetKind, by: s.createdBy });
  return id;
}
