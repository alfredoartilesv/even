import type { SqlDriver } from "../../db/driver";
import { addDays } from "../../core/tz";
import { sportOf, type SportId } from "./sports";

/**
 * Workouts from the activity_* samples, one row per session: from the Garmin sync, Apple Health,
 * the Garmin export, and freddy rows from before 26 Oct 2026.
 *
 * A session is the set of activity metrics sharing (source, external_id): the sync and the export
 * key them "activity:<id>", freddy "<day>#<n>" (the n-th activity of that day). freddy numbered each
 * metric on its own, so only metrics every session has (type, duration, distance, kcal, average
 * heart rate) are read: optional ones such as elevation skip indoor sessions and would shift the
 * numbering. The same watch sessions are stored once per source, so a day is read from one source
 * only, in the order of daily_metric_values (migration 0012): the Garmin sync, then freddy, then Apple
 * Health (Garmin Connect can copy the same sessions into it), then the export. Apple Health keys
 * its sessions "workout:<HealthKit id>".
 */

export interface Workout {
  key: string;
  source: string;
  day: string;
  /** Start time when the source has it (the sync and the export do; freddy gave the day only). */
  startMs: number | null;
  type: string | null;
  sport: SportId;
  durationS: number | null;
  distanceM: number | null;
  kcal: number | null;
  avgHr: number | null;
  /** Read from the Garmin sync, the export and Apple Health; freddy rows never have them. */
  maxHr: number | null;
  movingS: number | null;
  elevationM: number | null;
  steps: number | null;
  /** Garmin training effect, 0 to 5. */
  aerobicTe: number | null;
  anaerobicTe: number | null;
  vo2Max: number | null;
}

/** Metrics every session has: safe to read from freddy, which numbered each metric on its own. */
const CORE = {
  activity_activityType: "type",
  activity_durationInSeconds: "durationS",
  activity_distanceInMeters: "distanceM",
  activity_activeKilocalories: "kcal",
  activity_averageHeartRateInBeatsPerMinute: "avgHr",
} as const;

/** Optional metrics, keyed by the activity id: read from every source but freddy. */
const EXTRA = {
  activity_maxHeartRateInBeatsPerMinute: "maxHr",
  activity_movingDurationInSeconds: "movingS",
  activity_totalElevationGainInMeters: "elevationM",
  activity_steps: "steps",
  activity_aerobicTrainingEffect: "aerobicTe",
  activity_anaerobicTrainingEffect: "anaerobicTe",
  activity_vo2Max: "vo2Max",
} as const;

const METRICS = { ...CORE, ...EXTRA };

export async function listWorkouts(db: SqlDriver, from: string, to: string): Promise<Workout[]> {
  const rows = await db.all<{
    source: string;
    external_id: string;
    metric: keyof typeof METRICS;
    local_day: string;
    start_ms: number;
    value_num: number | null;
    value_text: string | null;
  }>(
    `SELECT h.source, h.external_id, h.metric, h.local_day, h.start_ms, h.value_num, h.value_text
     FROM health_samples h
     WHERE h.metric IN (${Object.keys(METRICS)
       .map(() => "?")
       .join(", ")}) AND h.local_day BETWEEN ? AND ?
       AND NOT (h.source = 'freddy' AND h.metric IN (${Object.keys(EXTRA)
         .map((m) => `'${m}'`)
         .join(", ")}))
       AND NOT (h.source = 'garmin_export' AND EXISTS (
         SELECT 1 FROM health_samples f WHERE f.metric = 'activity_activityType' AND f.local_day = h.local_day AND f.source <> 'garmin_export'))
       AND NOT (h.source = 'freddy' AND EXISTS (
         SELECT 1 FROM health_samples f WHERE f.metric = 'activity_activityType' AND f.local_day = h.local_day AND f.source = 'garmin'))
       AND NOT (h.source = 'apple_health' AND EXISTS (
         SELECT 1 FROM health_samples f WHERE f.metric = 'activity_activityType' AND f.local_day = h.local_day AND f.source IN ('garmin', 'freddy')))`,
    [...Object.keys(METRICS), from, to],
  );
  const by = new Map<string, Workout>();
  for (const r of rows) {
    const key = `${r.source}|${r.external_id}`;
    let w = by.get(key);
    if (!w) {
      // freddy rows start at local midnight: not a real start time.
      w = {
        key,
        source: r.source,
        day: r.local_day,
        startMs: r.source === "freddy" ? null : r.start_ms,
        type: null,
        sport: "other",
        durationS: null,
        distanceM: null,
        kcal: null,
        avgHr: null,
        maxHr: null,
        movingS: null,
        elevationM: null,
        steps: null,
        aerobicTe: null,
        anaerobicTe: null,
        vo2Max: null,
      };
      by.set(key, w);
    }
    const field = METRICS[r.metric];
    if (field === "type") {
      w.type = r.value_text;
      w.sport = sportOf(r.value_text);
    } else w[field] = r.value_num;
  }
  // A session needs at least a type or a duration to be worth showing.
  return [...by.values()]
    .filter((w) => w.type !== null || w.durationS !== null)
    .sort((a, b) => (a.day === b.day ? (b.startMs ?? 0) - (a.startMs ?? 0) || b.key.localeCompare(a.key) : a.day < b.day ? 1 : -1));
}

export interface SportTotal {
  sport: SportId;
  sessions: number;
  durationS: number;
  distanceM: number;
  kcal: number;
}

/** Sessions, time, distance and kcal per sport, most time first. */
export function sportTotals(workouts: Workout[]): SportTotal[] {
  const by = new Map<SportId, SportTotal>();
  for (const w of workouts) {
    const t = by.get(w.sport) ?? { sport: w.sport, sessions: 0, durationS: 0, distanceM: 0, kcal: 0 };
    t.sessions++;
    t.durationS += w.durationS ?? 0;
    t.distanceM += w.distanceM ?? 0;
    t.kcal += w.kcal ?? 0;
    by.set(w.sport, t);
  }
  return [...by.values()].sort((a, b) => b.durationS - a.durationS || b.sessions - a.sessions);
}

export interface WeekVolume {
  /** Monday of the week. */
  week: string;
  sessions: number;
  durationS: number;
  distanceM: number;
}

/** Monday of the week a day is in. */
export const weekOf = (day: string) => addDays(day, -((new Date(`${day}T12:00:00Z`).getUTCDay() + 6) % 7));

/** Sessions, time and distance per Monday week, oldest first, the last `weeks` weeks up to the one holding today (empty weeks included). */
export function weeklyVolume(workouts: Workout[], today: string, weeks = 12): WeekVolume[] {
  const last = weekOf(today);
  const out: WeekVolume[] = Array.from({ length: weeks }, (_, i) => ({ week: addDays(last, (i - weeks + 1) * 7), sessions: 0, durationS: 0, distanceM: 0 }));
  const by = new Map(out.map((w) => [w.week, w]));
  for (const w of workouts) {
    const v = by.get(weekOf(w.day));
    if (!v) continue;
    v.sessions++;
    v.durationS += w.durationS ?? 0;
    v.distanceM += w.distanceM ?? 0;
  }
  return out;
}

/** Sessions grouped by calendar month ("2026-10"), newest month first, in the list's own order. */
export function byMonth(workouts: Workout[]): { month: string; items: Workout[] }[] {
  const out: { month: string; items: Workout[] }[] = [];
  for (const w of workouts) {
    const m = w.day.slice(0, 7);
    if (out.at(-1)?.month !== m) out.push({ month: m, items: [] });
    out.at(-1)!.items.push(w);
  }
  return out;
}

/** "Recovery", "Base", "Tempo"... Garmin's words for an aerobic training effect, or null. */
export function trainingEffectLabel(te: number | null): string | null {
  if (te === null) return null;
  if (te < 1) return "No effect";
  if (te < 2) return "Minor";
  if (te < 3) return "Maintaining";
  if (te < 4) return "Improving";
  if (te < 5) return "Highly improving";
  return "Overreaching";
}

/** Per sport: the longest session by distance (when the sport has distance) and by time. */
export function personalBests(workouts: Workout[]): { sport: SportId; longestDistance: Workout | null; longestTime: Workout | null }[] {
  const out = new Map<SportId, { sport: SportId; longestDistance: Workout | null; longestTime: Workout | null }>();
  for (const w of workouts) {
    const b = out.get(w.sport) ?? { sport: w.sport, longestDistance: null, longestTime: null };
    if ((w.distanceM ?? 0) > 0 && (!b.longestDistance || w.distanceM! > b.longestDistance.distanceM!)) b.longestDistance = w;
    if ((w.durationS ?? 0) > 0 && (!b.longestTime || w.durationS! > b.longestTime.durationS!)) b.longestTime = w;
    out.set(w.sport, b);
  }
  return [...out.values()];
}

/** "1 h 05 min", "42 min", "50 s". */
export function fmtDuration(seconds: number): string {
  const s = Math.round(seconds);
  if (s < 60) return `${s} s`;
  const h = Math.floor(s / 3600);
  const m = Math.round((s % 3600) / 60);
  return h ? `${h} h ${String(m).padStart(2, "0")} min` : `${m} min`;
}

/** "10.2 km", "850 m". */
export const fmtDistance = (m: number) => (m >= 1000 ? `${(m / 1000).toFixed(m >= 100_000 ? 0 : 1)} km` : `${Math.round(m)} m`);

/** Running/walking pace as "6:58 /km", or null without both time and a real distance. */
export function fmtPace(durationS: number | null, distanceM: number | null): string | null {
  if (!durationS || !distanceM || distanceM < 100) return null;
  const perKm = Math.round(durationS / (distanceM / 1000));
  return `${Math.floor(perKm / 60)}:${String(perKm % 60).padStart(2, "0")} /km`;
}

/** Cycling speed as "24.3 km/h", or null. */
export function fmtSpeed(durationS: number | null, distanceM: number | null): string | null {
  if (!durationS || !distanceM) return null;
  return `${(distanceM / 1000 / (durationS / 3600)).toFixed(1)} km/h`;
}
