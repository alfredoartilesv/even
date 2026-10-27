import { addDays, localDay, localDayStart } from "../../core/tz";
import type { AggregationType, HealthDataType, HealthPlugin, HealthSample, SleepState, Workout } from "@capgo/capacitor-health";
import type { SqlDriver } from "../../db/driver";
import { getSetting, setSetting } from "../../db/settings";
import { createLogger } from "../../core/log";
import { catalogFor } from "../import/garmin";
import type { SampleInput, Source, SyncResult } from "./types";

const log = createLogger("sync.appleHealth");

/**
 * Apple Health (HealthKit) on the iPhone, read-only, through @capgo/capacitor-health
 * (src/platform/health.ts). Nothing leaves the phone: HealthKit is read on the device and the
 * values go straight into the local database.
 *
 * Metric names are the Garmin ones, so the dashboard, charts and Claude read Apple Health days with
 * no change, and where both sources have a metric for a day, Garmin's value is the one shown
 * (migration 0012). Garmin Connect can itself write into Apple Health, so counting both would add the
 * same steps twice.
 *
 * - Daily totals and averages come from HealthKit's statistics queries, which merge the iPhone and
 *   an Apple Watch the way the Health app does (no double counting between devices).
 * - Sleep: HealthKit keeps one record per stage per device. A night goes to the day you wake up
 *   (a stage counts for the day of its start plus 6 h, so 23:30 is the next day and a 14:00 nap
 *   is today), and each night is read from the one device that recorded the most sleep.
 * - HRV: HealthKit's is SDNN, Garmin's overnight value is RMSSD. Different measures, so Apple's has
 *   its own metric (hrv_sdnnAvg) instead of joining Garmin's series.
 */

export const APPLE_HEALTH_SOURCE = "apple_health";
const DEVICE = "Apple Health";
/** Sleep stages starting before 18:00 count for that day, later ones for the next. */
const SLEEP_DAY_SHIFT_MS = 6 * 3_600_000;
const READ_LIMIT = 10_000;
const WORKOUT_PAGE = 200;

/** The parts of the HealthKit plugin this source uses, in the plugin's own types (injected for tests). */
export type HealthStore = Pick<HealthPlugin, "queryAggregated" | "readSamples" | "queryWorkouts">;
type Aggregation = AggregationType;

/** What the source asks HealthKit to read (the permission sheet lists these). */
export const APPLE_HEALTH_READ: HealthDataType[] = ["steps", "distance", "calories", "basalCalories", "heartRate", "restingHeartRate", "heartRateVariability", "oxygenSaturation", "sleep", "weight", "workouts"];

/** One daily HealthKit statistic -> one Garmin-named metric. */
const DAILY: { dataType: HealthDataType; aggregation: Aggregation; metric: string; unit: string | null; min: number; max: number; scale?: (v: number) => number }[] = [
  { dataType: "steps", aggregation: "sum", metric: "daily_steps", unit: null, min: 0, max: 200_000, scale: Math.round },
  { dataType: "distance", aggregation: "sum", metric: "daily_distanceInMeters", unit: "meters", min: 0, max: 500_000, scale: Math.round },
  { dataType: "calories", aggregation: "sum", metric: "daily_activeKilocalories", unit: "kcal", min: 0, max: 20_000, scale: Math.round },
  { dataType: "basalCalories", aggregation: "sum", metric: "daily_bmrKilocalories", unit: "kcal", min: 0, max: 10_000, scale: Math.round },
  { dataType: "restingHeartRate", aggregation: "average", metric: "daily_restingHeartRateInBeatsPerMinute", unit: "bpm", min: 20, max: 200, scale: Math.round },
  { dataType: "heartRate", aggregation: "min", metric: "daily_minHeartRateInBeatsPerMinute", unit: "bpm", min: 20, max: 250, scale: Math.round },
  { dataType: "heartRate", aggregation: "max", metric: "daily_maxHeartRateInBeatsPerMinute", unit: "bpm", min: 20, max: 250, scale: Math.round },
  { dataType: "heartRateVariability", aggregation: "average", metric: "hrv_sdnnAvg", unit: "ms", min: 1, max: 300, scale: Math.round },
  // HealthKit percent is a fraction (0.97); some readers already give 97.
  { dataType: "oxygenSaturation", aggregation: "average", metric: "pulseOx_avgSpo2InPercent", unit: "%", min: 50, max: 100, scale: (v) => Math.round(v <= 1.5 ? v * 100 : v) },
  { dataType: "oxygenSaturation", aggregation: "min", metric: "pulseOx_minSpo2InPercent", unit: "%", min: 50, max: 100, scale: (v) => Math.round(v <= 1.5 ? v * 100 : v) },
];

const SLEEP_METRIC: Partial<Record<SleepState, string>> = {
  deep: "sleep_deepSleepDurationInSeconds",
  light: "sleep_lightSleepDurationInSeconds",
  rem: "sleep_remSleepInSeconds",
  awake: "sleep_awakeDurationInSeconds",
};
const ASLEEP: SleepState[] = ["asleep", "deep", "light", "rem"];

export interface AppleHealthOptions {
  store: HealthStore;
  /** The phone's time zone, for local days. */
  timeZone?: string;
  /** How far back the first sync reads. HealthKit keeps everything, so this only bounds the first run. */
  firstSyncDays?: number;
  now?: () => number;
}

const ms = (iso: string) => Date.parse(iso);
const inRange = (v: number | undefined, min: number, max: number) => (typeof v === "number" && Number.isFinite(v) && v >= min && v <= max ? v : null);
/** "traditionalStrengthTraining" -> "traditional_strength_training", Garmin's typeKey style. */
const typeKey = (t: string) => t.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();

export class AppleHealthSource implements Source {
  readonly id = APPLE_HEALTH_SOURCE;
  private readonly opts: Required<AppleHealthOptions>;

  constructor(opts: AppleHealthOptions) {
    this.opts = { timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, firstSyncDays: 30, now: Date.now, ...opts };
  }

  async fetchSince(cursor: string | null): Promise<SyncResult> {
    const { store, timeZone: tz, now, firstSyncDays } = this.opts;
    const today = localDay(now(), tz);
    const start = cursor ? (cursor < today ? cursor : today) : addDays(today, -(firstSyncDays - 1));
    const from = new Date(localDayStart(start, tz).startMs).toISOString();
    const to = new Date(localDayStart(addDays(today, 1), tz).startMs).toISOString();
    log.debug("window", { start, end: today, firstSync: !cursor, tz });

    const samples: SampleInput[] = [];
    const warnings: string[] = [];
    const dayAt = (day: string) => {
      const s = localDayStart(day, tz);
      return { startMs: s.startMs, endMs: localDayStart(addDays(day, 1), tz).startMs, offsetMin: s.offsetMin };
    };
    const offsetAt = (t: number) => localDayStart(localDay(t, tz), tz).offsetMin;
    const push = (s: Omit<SampleInput, "source" | "device">) => samples.push({ source: APPLE_HEALTH_SOURCE, device: DEVICE, ...s });
    /** A type the owner did not allow, or the phone does not record, is a warning, not a failed sync. */
    const tryRead = async <T>(what: string, read: () => Promise<T>): Promise<T | null> => {
      try {
        return await read();
      } catch (e) {
        warnings.push(`${what}: not read (${(e as Error).message || e})`);
        return null;
      }
    };

    // Daily statistics, grouped so each HealthKit type is asked once.
    const byType = new Map<HealthDataType, typeof DAILY>();
    for (const d of DAILY) byType.set(d.dataType, [...(byType.get(d.dataType) ?? []), d]);
    for (const [dataType, defs] of byType) {
      const res = await tryRead(dataType, () => store.queryAggregated({ dataType, startDate: from, endDate: to, bucket: "day", aggregation: [...new Set(defs.map((d) => d.aggregation))] }));
      for (const b of res?.samples ?? []) {
        const day = localDay(ms(b.startDate), tz);
        if (day < start || day > today) continue;
        for (const d of defs) {
          const raw = b.values[d.aggregation];
          const v = inRange(raw === undefined ? undefined : d.scale ? d.scale(raw) : raw, d.min, d.max);
          // A day with no reading of a sum type can come back as 0: not a measurement.
          if (v === null || (v === 0 && d.aggregation === "sum")) continue;
          push({ externalId: `${day}#0`, metric: d.metric, ...dayAt(day), valueNum: v, ...(d.unit ? { unit: d.unit } : {}) });
        }
      }
    }
    // Garmin's total is active plus resting; HealthKit has no stored total.
    const perDay = (metric: string) => new Map(samples.filter((s) => s.metric === metric).map((s) => [s.externalId, s]));
    const basal = perDay("daily_bmrKilocalories");
    for (const [id, a] of perDay("daily_activeKilocalories")) {
      const b = basal.get(id);
      if (b) push({ externalId: id, metric: "daily_totalKilocalories", startMs: a.startMs, endMs: a.endMs, offsetMin: a.offsetMin, valueNum: (a.valueNum ?? 0) + (b.valueNum ?? 0), unit: "kcal" });
    }

    // Sleep: from noon the day before the window, so the first night is whole.
    const sleep = await tryRead("sleep", () => store.readSamples({ dataType: "sleep", startDate: new Date(ms(from) - 12 * 3_600_000).toISOString(), endDate: to, limit: READ_LIMIT, ascending: true }));
    this.addSleep(sleep?.samples ?? [], start, today, dayAt, push);

    const weights = await tryRead("weight", () => store.readSamples({ dataType: "weight", startDate: from, endDate: to, limit: READ_LIMIT, ascending: true }));
    for (const w of weights?.samples ?? []) {
      const t = ms(w.startDate);
      const grams = inRange(Math.round(w.value * 1000), 20_000, 400_000);
      if (grams === null || !Number.isFinite(t)) continue;
      push({ externalId: `weight:${w.platformId ?? t}`, metric: "body_weightInGrams", startMs: t, endMs: t, offsetMin: offsetAt(t), valueNum: grams, unit: "grams" });
    }

    let anchor: string | undefined;
    for (let page = 0; page < 50; page++) {
      const res = await tryRead("workouts", () => store.queryWorkouts({ startDate: from, endDate: to, limit: WORKOUT_PAGE, ascending: true, ...(anchor ? { anchor } : {}) }));
      for (const w of res?.workouts ?? []) this.addWorkout(w, offsetAt, push);
      anchor = res?.anchor || undefined;
      if (!res || !anchor || res.workouts.length === 0) break;
    }

    log.debug("fetched", { samples: samples.length, warnings: warnings.length });
    // Re-read yesterday next time: the Watch may sync it late.
    return { samples, catalog: catalogFor(samples), nextCursor: addDays(today, -1), warnings };
  }

  private addSleep(
    raw: HealthSample[],
    start: string,
    today: string,
    dayAt: (day: string) => { startMs: number; endMs: number; offsetMin: number },
    push: (s: Omit<SampleInput, "source" | "device">) => void,
  ) {
    const { timeZone: tz } = this.opts;
    // Every stage segment, whether the plugin gives one record per stage or a session with stages.
    const segments = raw.flatMap((s) =>
      s.stages?.length
        ? s.stages.map((g) => ({ state: g.stage, startMs: ms(g.startDate), endMs: ms(g.endDate), device: s.sourceId ?? s.sourceName ?? "" }))
        : s.sleepState
          ? [{ state: s.sleepState, startMs: ms(s.startDate), endMs: ms(s.endDate), device: s.sourceId ?? s.sourceName ?? "" }]
          : [],
    );
    // night -> device -> state -> seconds
    const nights = new Map<string, Map<string, Map<SleepState, number>>>();
    for (const g of segments) {
      const sec = Math.round((g.endMs - g.startMs) / 1000);
      if (!(sec > 0) || sec > 86_400) continue;
      const day = localDay(g.startMs + SLEEP_DAY_SHIFT_MS, tz);
      if (day < start || day > today) continue;
      const devices = nights.get(day) ?? new Map<string, Map<SleepState, number>>();
      const states = devices.get(g.device) ?? new Map<SleepState, number>();
      states.set(g.state, (states.get(g.state) ?? 0) + sec);
      devices.set(g.device, states);
      nights.set(day, devices);
    }
    const asleep = (st: Map<SleepState, number>) => ASLEEP.reduce((t, s) => t + (st.get(s) ?? 0), 0);
    for (const [day, devices] of nights) {
      const best = [...devices.values()].sort((a, b) => asleep(b) - asleep(a))[0];
      const total = asleep(best);
      if (total <= 0) continue; // only "in bed": no sleep measured
      const at = dayAt(day);
      push({ externalId: `${day}#0`, metric: "sleep_durationInSeconds", ...at, valueNum: total, unit: "seconds" });
      for (const [state, metric] of Object.entries(SLEEP_METRIC) as [SleepState, string][]) {
        const v = best.get(state);
        if (v) push({ externalId: `${day}#0`, metric, ...at, valueNum: v, unit: "seconds" });
      }
    }
  }

  private addWorkout(w: Workout, offsetAt: (t: number) => number, push: (s: Omit<SampleInput, "source" | "device">) => void) {
    const startMs = ms(w.startDate);
    const endMs = ms(w.endDate);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return;
    const at = { startMs, endMs, offsetMin: offsetAt(startMs) };
    const externalId = `workout:${w.platformId ?? startMs}`;
    // Which app recorded it (Garmin Connect, Strava, the Watch): kept for checking duplicates later.
    const raw = w.sourceName ? { recordedBy: w.sourceName } : undefined;
    push({ externalId, metric: "activity_activityType", ...at, valueText: typeKey(w.workoutType || "other"), ...(raw ? { raw } : {}) });
    const add = (metric: string, v: number | null, unit: string) => {
      if (v !== null) push({ externalId, metric, ...at, valueNum: Math.round(v), unit });
    };
    add("activity_durationInSeconds", inRange(w.duration, 0, 7 * 86_400), "seconds");
    add("activity_distanceInMeters", inRange(w.totalDistance, 0.5, 1_000_000), "meters");
    add("activity_activeKilocalories", inRange(w.totalEnergyBurned, 0.5, 20_000), "kcal");
  }
}

/** Whether the owner connected Apple Health. HealthKit never says whether reading was allowed (Apple hides it), so the app remembers the choice. */
export const APPLE_HEALTH_ENABLED_KEY = "appleHealth.enabled";

export async function appleHealthEnabled(db: SqlDriver): Promise<boolean> {
  return (await getSetting(db, APPLE_HEALTH_ENABLED_KEY)) === "1";
}

export async function setAppleHealthEnabled(db: SqlDriver, on: boolean): Promise<void> {
  await setSetting(db, APPLE_HEALTH_ENABLED_KEY, on ? "1" : "0");
}
