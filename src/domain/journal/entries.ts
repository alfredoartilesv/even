// zod/mini: this module is on the Dashboard's start-up path.
import { z } from "zod/mini";
import { createLogger } from "../../core/log";
import { addDays, tzOffsetMinutes } from "../../core/tz";
import { uuidv7 } from "../../core/uuidv7";
import type { SqlDriver } from "../../db/driver";
import { deviceId } from "../../db/settings";
import { withTransaction } from "../../db/tx";
import { insertMeasurement, type CreatedBy } from "./journal";

/**
 * The owner's journal on the phone: things measured by hand (weight on another scale, blood
 * pressure, glucose, a supplement, a symptom) and the daily check-in (mood, energy, a note).
 * The chat writes the same rows through journal.ts; the screens read, add, edit and delete here.
 */

const log = createLogger("journal.entries");

// ---- Measurements ----

/** How a kind is entered: one number, a pair (blood pressure), or words (a supplement taken). */
export type KindShape = "number" | "pair" | "text";

export interface KindPreset {
  kind: string;
  label: string;
  shape: KindShape;
  unit: string | null;
  /** Accepted range for the number(s); the second for value2 of a pair. */
  min?: number;
  max?: number;
  min2?: number;
  max2?: number;
  /** What the field asks for. */
  hint?: string;
}

/** The kinds offered first. Any lower_snake_case kind works (the chat may add others). */
export const KIND_PRESETS: KindPreset[] = [
  { kind: "weight", label: "Weight", shape: "number", unit: "kg", min: 20, max: 400 },
  { kind: "body_fat", label: "Body fat", shape: "number", unit: "%", min: 2, max: 75 },
  { kind: "waist", label: "Waist", shape: "number", unit: "cm", min: 30, max: 250 },
  { kind: "blood_pressure", label: "Blood pressure", shape: "pair", unit: "mmHg", min: 50, max: 260, min2: 30, max2: 160, hint: "Systolic / diastolic" },
  { kind: "resting_hr", label: "Resting heart rate", shape: "number", unit: "bpm", min: 25, max: 220 },
  { kind: "glucose", label: "Glucose", shape: "number", unit: "mmol/L", min: 1, max: 35 },
  { kind: "supplement", label: "Supplement", shape: "text", unit: null, hint: "e.g. Vitamin D 2000 IU" },
  { kind: "symptom", label: "Symptom", shape: "text", unit: null, hint: "e.g. Headache, mild" },
];

const PRESET = new Map(KIND_PRESETS.map((p) => [p.kind, p]));

/** "blood_pressure" -> its preset, or a plain-number kind labelled "Blood pressure". */
export function presetFor(kind: string): KindPreset {
  return PRESET.get(kind) ?? { kind, label: kindLabel(kind), shape: "number", unit: null };
}

export const kindLabel = (kind: string) => PRESET.get(kind)?.label ?? (kind.charAt(0).toUpperCase() + kind.slice(1)).replace(/_/g, " ");

export interface Measurement {
  id: string;
  kind: string;
  day: string;
  atMs: number;
  value: number | null;
  value2: number | null;
  text: string | null;
  unit: string | null;
  notes: string | null;
  createdBy: CreatedBy;
}

/** "81.4 kg", "128/82 mmHg", "Vitamin D 2000 IU". */
export function fmtMeasurement(m: Pick<Measurement, "value" | "value2" | "text" | "unit">): string {
  const n = (v: number) => v.toLocaleString(undefined, { maximumFractionDigits: 1 });
  const num = m.value === null ? null : m.value2 !== null ? `${n(m.value)}/${n(m.value2)}` : n(m.value);
  const unit = m.unit ? (m.unit === "%" ? "%" : ` ${m.unit}`) : "";
  return [num && `${num}${unit}`, m.text].filter(Boolean).join(" · ") || "–";
}

export interface NewMeasurement {
  kind: string;
  value?: number | null;
  value2?: number | null;
  text?: string | null;
  unit?: string | null;
  notes?: string | null;
  atMs?: number;
  timeZone: string;
}

const KIND_RE = /^[a-z][a-z0-9_]{0,39}$/;

/** Checks the input against its kind (shape and range) and saves it. Throws a message safe to show. */
export async function addMeasurement(db: SqlDriver, m: NewMeasurement, by: CreatedBy = "user", nowMs: number = Date.now()): Promise<string> {
  if (!KIND_RE.test(m.kind)) throw new Error("The kind is lower case words joined by _ (e.g. blood_pressure)");
  const p = presetFor(m.kind);
  const value = m.value ?? null;
  const value2 = m.value2 ?? null;
  const text = m.text?.trim() || null;
  const inRange = (v: number | null, lo = -Infinity, hi = Infinity) => v === null || (Number.isFinite(v) && v >= lo && v <= hi);
  if (p.shape === "text") {
    if (!text) throw new Error(`Write what the ${p.label.toLowerCase()} was`);
    if (text.length > 200) throw new Error("At most 200 characters");
  } else {
    if (value === null || !Number.isFinite(value)) throw new Error(`Enter the ${p.label.toLowerCase()}`);
    if (!inRange(value, p.min, p.max)) throw new Error(`${p.label} must be between ${p.min} and ${p.max}${p.unit ? ` ${p.unit}` : ""}`);
    if (p.shape === "pair") {
      if (value2 === null || !Number.isFinite(value2)) throw new Error("Enter both numbers");
      if (!inRange(value2, p.min2, p.max2)) throw new Error(`The second number must be between ${p.min2} and ${p.max2}`);
      if (value2 >= value) throw new Error("The second number (diastolic) is lower than the first");
    }
  }
  const at = m.atMs ?? nowMs;
  if (at > nowMs + 5 * 60_000) throw new Error("That time is in the future");
  const id = await insertMeasurement(
    db,
    {
      measuredAtMs: at,
      offsetMin: tzOffsetMinutes(at, m.timeZone),
      kind: m.kind,
      valueNum: p.shape === "text" ? null : value,
      valueNum2: p.shape === "pair" ? value2 : null,
      valueText: text,
      unit: m.unit ?? p.unit,
      notes: m.notes?.trim() || null,
    },
    { deviceId: await deviceId(db), createdBy: by, now: nowMs },
  );
  return id;
}

interface MeasurementRow {
  id: string;
  kind: string;
  local_day: string;
  measured_at_ms: number;
  value_num: number | null;
  value_num2: number | null;
  value_text: string | null;
  unit: string | null;
  notes: string | null;
  created_by: CreatedBy;
}

const toMeasurement = (r: MeasurementRow): Measurement => ({
  id: r.id,
  kind: r.kind,
  day: r.local_day,
  atMs: r.measured_at_ms,
  value: r.value_num,
  value2: r.value_num2,
  text: r.value_text,
  unit: r.unit,
  notes: r.notes,
  createdBy: r.created_by,
});

/** Newest first, between two local days (inclusive), optionally one kind. */
export async function listMeasurements(db: SqlDriver, from: string, to: string, kind?: string | null): Promise<Measurement[]> {
  const rows = await db.all<MeasurementRow>(
    `SELECT id, kind, local_day, measured_at_ms, value_num, value_num2, value_text, unit, notes, created_by FROM manual_measurements
     WHERE deleted_at IS NULL AND local_day BETWEEN ? AND ? AND (? IS NULL OR kind = ?)
     ORDER BY measured_at_ms DESC, id DESC`,
    [from, to, kind ?? null, kind ?? null],
  );
  return rows.map(toMeasurement);
}

export interface KindSummary {
  kind: string;
  count: number;
  latest: Measurement;
}

/** Every kind logged, the most recently used first, with its latest entry. */
export async function measurementKinds(db: SqlDriver): Promise<KindSummary[]> {
  const rows = await db.all<MeasurementRow & { n: number }>(
    `SELECT m.id, m.kind, m.local_day, m.measured_at_ms, m.value_num, m.value_num2, m.value_text, m.unit, m.notes, m.created_by,
            (SELECT COUNT(*) FROM manual_measurements c WHERE c.kind = m.kind AND c.deleted_at IS NULL) AS n
     FROM manual_measurements m
     WHERE m.deleted_at IS NULL AND m.id = (SELECT l.id FROM manual_measurements l WHERE l.kind = m.kind AND l.deleted_at IS NULL
                                             ORDER BY l.measured_at_ms DESC, l.id DESC LIMIT 1)
     ORDER BY m.measured_at_ms DESC`,
  );
  return rows.map((r) => ({ kind: r.kind, count: r.n, latest: toMeasurement(r) }));
}

/** One point per day (the day's last entry) for a numeric kind, from..to inclusive, nulls where nothing was logged. */
export async function measurementSeries(
  db: SqlDriver,
  kind: string,
  from: string,
  to: string,
): Promise<{ days: string[]; values: (number | null)[]; values2: (number | null)[] }> {
  const rows = (await listMeasurements(db, from, to, kind)).filter((m) => m.value !== null);
  const last = new Map<string, Measurement>();
  for (const m of rows) if (!last.has(m.day)) last.set(m.day, m); // rows are newest first
  const days: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) days.push(d);
  return { days, values: days.map((d) => last.get(d)?.value ?? null), values2: days.map((d) => last.get(d)?.value2 ?? null) };
}

export async function deleteMeasurement(db: SqlDriver, id: string, nowMs: number = Date.now()): Promise<void> {
  await db.run("UPDATE manual_measurements SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL", [nowMs, nowMs, id]);
  log.info("measurement deleted", { id });
}

/** Puts back a measurement deleted by mistake (the screen's Undo). */
export async function restoreMeasurement(db: SqlDriver, id: string, nowMs: number = Date.now()): Promise<void> {
  await db.run("UPDATE manual_measurements SET deleted_at = NULL, updated_at = ? WHERE id = ?", [nowMs, id]);
  log.info("measurement restored", { id });
}

// ---- Day notes ----

export interface DayNote {
  id: string;
  day: string;
  mood: number | null;
  energy: number | null;
  body: string;
  createdBy: CreatedBy;
  updatedAtMs: number;
}

/** Words for the 1-5 scale, so a rating is never a bare number or a face alone. */
export const SCALE = ["Very low", "Low", "OK", "Good", "Very good"] as const;

const noteSchema = z.object({
  day: z.string().check(z.regex(/^\d{4}-\d{2}-\d{2}$/, "Pick a day")),
  mood: z.nullable(z.int().check(z.minimum(1), z.maximum(5))),
  energy: z.nullable(z.int().check(z.minimum(1), z.maximum(5))),
  body: z.string().check(z.maxLength(4000, "At most 4,000 characters")),
});

interface NoteRow {
  id: string;
  local_day: string;
  mood: number | null;
  energy: number | null;
  body: string;
  created_by: CreatedBy;
  updated_at: number;
}

const toNote = (r: NoteRow): DayNote => ({
  id: r.id,
  day: r.local_day,
  mood: r.mood,
  energy: r.energy,
  body: r.body,
  createdBy: r.created_by,
  updatedAtMs: r.updated_at,
});

export async function getDayNote(db: SqlDriver, day: string): Promise<DayNote | null> {
  const [r] = await db.all<NoteRow>(
    "SELECT id, local_day, mood, energy, body, created_by, updated_at FROM day_notes WHERE local_day = ? AND deleted_at IS NULL",
    [day],
  );
  return r ? toNote(r) : null;
}

/** Newest day first, between two days (inclusive). */
export async function listDayNotes(db: SqlDriver, from: string, to: string): Promise<DayNote[]> {
  const rows = await db.all<NoteRow>(
    "SELECT id, local_day, mood, energy, body, created_by, updated_at FROM day_notes WHERE deleted_at IS NULL AND local_day BETWEEN ? AND ? ORDER BY local_day DESC",
    [from, to],
  );
  return rows.map(toNote);
}

/**
 * Creates the day's note or updates it (one live note per day). Saving one with nothing in it
 * (no ratings, empty text) deletes it instead. Days in the future are refused.
 */
export async function saveDayNote(
  db: SqlDriver,
  input: { day: string; mood: number | null; energy: number | null; body: string },
  today: string,
  nowMs: number = Date.now(),
): Promise<DayNote | null> {
  const n = noteSchema.parse({ ...input, body: input.body.trim() });
  if (n.day > today) throw new Error("That day has not happened yet");
  const existing = await getDayNote(db, n.day);
  if (n.mood === null && n.energy === null && !n.body) {
    if (existing) await deleteDayNote(db, existing.id, nowMs);
    return null;
  }
  await withTransaction(db, async () => {
    if (existing) {
      await db.run("UPDATE day_notes SET mood = ?, energy = ?, body = ?, updated_at = ? WHERE id = ?", [n.mood, n.energy, n.body, nowMs, existing.id]);
    } else {
      await db.run(
        `INSERT INTO day_notes (id, local_day, mood, energy, body, created_by, created_at, updated_at, origin_device_id)
         VALUES (?, ?, ?, ?, ?, 'user', ?, ?, ?)`,
        [uuidv7(nowMs), n.day, n.mood, n.energy, n.body, nowMs, nowMs, await deviceId(db, nowMs)],
      );
    }
  });
  log.info(existing ? "day note updated" : "day note added", { hasMood: n.mood !== null, hasEnergy: n.energy !== null, chars: n.body.length });
  return getDayNote(db, n.day);
}

export async function deleteDayNote(db: SqlDriver, id: string, nowMs: number = Date.now()): Promise<void> {
  await db.run("UPDATE day_notes SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL", [nowMs, nowMs, id]);
  log.info("day note deleted", { id });
}
