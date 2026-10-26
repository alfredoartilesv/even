import type { SqlDriver } from "../../db/driver";
import { sportOf, type SportId } from "./sports";

/**
 * Workouts from the activity_* samples, one row per session, from freddy and the Garmin export.
 *
 * A session is the set of activity metrics sharing (source, external_id): the export keys them
 * "activity:<id>", freddy "<day>#<n>" (the n-th activity of that day). freddy numbers each metric
 * on its own, so only metrics every session has (type, duration, distance, kcal, average heart
 * rate) are read: optional ones such as elevation skip indoor sessions and would shift the
 * numbering. On a day freddy has sessions, the export's copies of that day are left out
 * (the same watch sessions twice, as in daily_metric_values).
 */

export interface Workout {
  key: string;
  source: string;
  day: string;
  /** Start time when the source has it (the export does; freddy gives the day only). */
  startMs: number | null;
  type: string | null;
  sport: SportId;
  durationS: number | null;
  distanceM: number | null;
  kcal: number | null;
  avgHr: number | null;
}

const METRICS = {
  activity_activityType: "type",
  activity_durationInSeconds: "durationS",
  activity_distanceInMeters: "distanceM",
  activity_activeKilocalories: "kcal",
  activity_averageHeartRateInBeatsPerMinute: "avgHr",
} as const;

export async function listWorkouts(db: SqlDriver, from: string, to: string): Promise<Workout[]> {
  const rows = await db.all<{ source: string; external_id: string; metric: keyof typeof METRICS; local_day: string; start_ms: number; value_num: number | null; value_text: string | null }>(
    `SELECT h.source, h.external_id, h.metric, h.local_day, h.start_ms, h.value_num, h.value_text
     FROM health_samples h
     WHERE h.metric IN (${Object.keys(METRICS).map(() => "?").join(", ")}) AND h.local_day BETWEEN ? AND ?
       AND NOT (h.source = 'garmin_export' AND EXISTS (
         SELECT 1 FROM health_samples f WHERE f.metric = 'activity_activityType' AND f.local_day = h.local_day AND f.source <> 'garmin_export'))`,
    [...Object.keys(METRICS), from, to],
  );
  const by = new Map<string, Workout>();
  for (const r of rows) {
    const key = `${r.source}|${r.external_id}`;
    let w = by.get(key);
    if (!w) {
      // freddy rows start at local midnight: not a real start time.
      w = { key, source: r.source, day: r.local_day, startMs: r.source === "garmin_export" ? r.start_ms : null, type: null, sport: "other", durationS: null, distanceM: null, kcal: null, avgHr: null };
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
