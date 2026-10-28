import { localDayStart, addDays } from "../../core/tz";
import { sampleCollector, type CatalogEntry, type SampleInput } from "../sync/types";

/**
 * Garmin account export ("Export Your Data" ZIP) -> health samples. Pure: no I/O, so it runs in
 * Node (scripts/garmin-import.ts) and could run in the app.
 *
 * What is read (units checked against a real export, 26 Oct 2026):
 * - DI-Connect-Aggregator/UDSFile_*.json: one record per day. Distances in metres, kcal, bpm,
 *   intensity minutes; the day's UTC offset from wellnessStartTimeLocal - wellnessStartTimeGmt.
 * - DI-Connect-Wellness/*_sleepData.json: one record per night, stage durations in seconds.
 * - DI-Connect-Wellness/*_userBioMetrics.json: weight in grams. sourceType USER_SETTING is the
 *   profile weight, not a weigh-in, so it is skipped. Height is a profile value: skipped.
 * - DI-Connect-Metrics/MetricsMaxMetData_*.json: VO2 max per sport and fitness age.
 * - DI-Connect-Fitness/*_summarizedActivities.json: activities. distance in CENTIMETRES, duration
 *   in MILLISECONDS, elevation in CENTIMETRES, calories in KILOJOULES (exactly 4.184x the Personal
 *   API kcal for the same activities, checked 26 Oct 2026); avgSpeed is (m/s)/10 and is not used.
 * Not read: hydration (only activity sweat estimates), nutrition (only calorie goals), uploaded FIT
 * files, routes and locations, social, profile images, workouts, gear, personal records.
 *
 * Privacy: activity names, locations and coordinates are not imported.
 * Metric names are the ones the Personal API sync (src/domain/sync/garmin.ts) uses for the same
 * Garmin values, so the history and the synced days form one series per metric. They are stored
 * under their own source, so neither overwrites the other; where both have a metric on the same day,
 * daily_metric_values shows the sync's value only (migrations 0008 and 0009: the Personal API, then
 * freddy rows from before the switch, then the export).
 */

export const GARMIN_EXPORT_SOURCE = "garmin_export";
const DEVICE = "Garmin";

/** One JSON file from the export, by its path inside the ZIP. */
export interface GarminFile {
  path: string;
  json: unknown;
}

export type GarminKind = "daily" | "sleep" | "biometrics" | "vo2max" | "activities";

/** Which export files hold what. Paths are matched on their tail: some file names start with the account email. */
export const GARMIN_FILES: Record<GarminKind, RegExp> = {
  daily: /DI-Connect-Aggregator\/UDSFile_[^/]*\.json$/,
  sleep: /DI-Connect-Wellness\/[^/]*_sleepData\.json$/,
  biometrics: /DI-Connect-Wellness\/[^/]*_userBioMetrics\.json$/,
  vo2max: /DI-Connect-Metrics\/MetricsMaxMetData_[^/]*\.json$/,
  activities: /DI-Connect-Fitness\/[^/]*_summarizedActivities\.json$/,
};

export function garminKind(path: string): GarminKind | null {
  for (const [kind, re] of Object.entries(GARMIN_FILES) as [GarminKind, RegExp][]) if (re.test(path)) return kind;
  return null;
}

export interface KindReport {
  files: number;
  records: number;
  imported: number;
  skipped: number;
  firstDay: string | null;
  lastDay: string | null;
}

export interface GarminImport {
  samples: SampleInput[];
  catalog: CatalogEntry[];
  report: Record<GarminKind, KindReport> & { weightProfileValuesSkipped: number };
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
/** A finite number, or null (Garmin uses null, missing fields and sometimes -1/-2 for "no data"). */
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const inRange = (v: number | null, min: number, max: number) => (v !== null && v >= min && v <= max ? v : null);
const DAY = /^\d{4}-\d{2}-\d{2}$/;
/** The local day of a Garmin date field: "2024-05-09" or, in some files, "2024-05-09T08:12:00.0". */
const dayOf = (v: unknown): string | null => {
  if (typeof v !== "string") return null;
  const d = v.slice(0, 10);
  return DAY.test(d) && (v.length === 10 || v[10] === "T" || v[10] === " ") ? d : null;
};

/** "2024-05-09T00:00:00.0" (no zone) read as if UTC, to subtract local from GMT. */
const naiveMs = (s: unknown): number | null => {
  if (typeof s !== "string") return null;
  const ms = Date.parse(`${s.replace(" ", "T").replace(/Z$/, "")}Z`);
  return Number.isFinite(ms) ? ms : null;
};

function dayBounds(day: string, offsetMin: number | null, timeZone: string): { startMs: number; endMs: number; offsetMin: number } {
  if (offsetMin === null) {
    const s = localDayStart(day, timeZone);
    return { startMs: s.startMs, endMs: localDayStart(addDays(day, 1), timeZone).startMs, offsetMin: s.offsetMin };
  }
  const startMs = Date.parse(`${day}T00:00:00Z`) - offsetMin * 60_000;
  return { startMs, endMs: startMs + 86_400_000, offsetMin };
}

function newReport(): KindReport {
  return { files: 0, records: 0, imported: 0, skipped: 0, firstDay: null, lastDay: null };
}

function seeDay(r: KindReport, day: string) {
  if (!r.firstDay || day < r.firstDay) r.firstDay = day;
  if (!r.lastDay || day > r.lastDay) r.lastDay = day;
}

export function parseGarminExport(files: GarminFile[], opts: { timeZone: string }): GarminImport {
  const report = {
    daily: newReport(),
    sleep: newReport(),
    biometrics: newReport(),
    vo2max: newReport(),
    activities: newReport(),
    weightProfileValuesSkipped: 0,
  };
  const { samples, add } = sampleCollector(GARMIN_EXPORT_SOURCE, DEVICE);
  /** Day offsets from the daily files, reused for sleep and weight on the same day. */
  const offsets = new Map<string, number>();

  const byKind = (k: GarminKind) => files.filter((f) => garminKind(f.path) === k);

  // Daily summaries first: they give the UTC offset of each day.
  for (const f of byKind("daily")) {
    report.daily.files++;
    for (const r of arr(f.json)) {
      report.daily.records++;
      const day = isObj(r) ? dayOf(r.calendarDate) : null;
      if (!isObj(r) || !day) {
        report.daily.skipped++;
        continue;
      }
      const local = naiveMs(r.wellnessStartTimeLocal);
      const gmt = naiveMs(r.wellnessStartTimeGmt);
      const offset = local !== null && gmt !== null ? Math.round((local - gmt) / 60_000) : null;
      if (offset !== null && Math.abs(offset) <= 14 * 60) offsets.set(day, offset);
      const at = dayBounds(day, offsets.get(day) ?? null, opts.timeZone);
      const id = `${day}#0`;
      const stress = arr(isObj(r.allDayStress) ? r.allDayStress.aggregatorList : []).find((a) => isObj(a) && a.type === "TOTAL") as Obj | undefined;
      const bb = isObj(r.bodyBattery) ? r.bodyBattery : null;
      const bbStat = (type: string) => {
        const s = arr(bb?.bodyBatteryStatList).find((x) => isObj(x) && x.bodyBatteryStatType === type) as Obj | undefined;
        return inRange(num(s?.statsValue), 0, 100);
      };
      const resp = isObj(r.respiration) ? r.respiration : null;
      const minutes = (v: unknown) => {
        const n = num(v);
        return n === null || n < 0 ? null : n * 60;
      };
      let n = 0;
      n += add("daily_steps", inRange(num(r.totalSteps), 0, 200_000), null, at, id);
      n += add("daily_distanceInMeters", inRange(num(r.totalDistanceMeters), 0, 500_000), "meters", at, id);
      n += add("daily_totalKilocalories", inRange(num(r.totalKilocalories), 0, 20_000), "kcal", at, id);
      n += add("daily_activeKilocalories", inRange(num(r.activeKilocalories), 0, 20_000), "kcal", at, id);
      n += add("daily_bmrKilocalories", inRange(num(r.bmrKilocalories), 0, 10_000), "kcal", at, id);
      // restingHeartRate is Garmin's 7-day average; the day's own value, as the Personal API gives it, is this one.
      n += add("daily_restingHeartRateInBeatsPerMinute", inRange(num(r.currentDayRestingHeartRate), 20, 200), "bpm", at, id);
      n += add("daily_minHeartRateInBeatsPerMinute", inRange(num(r.minHeartRate), 20, 250), "bpm", at, id);
      n += add("daily_maxHeartRateInBeatsPerMinute", inRange(num(r.maxHeartRate), 20, 250), "bpm", at, id);
      n += add("daily_moderateIntensityDurationInSeconds", minutes(r.moderateIntensityMinutes), "seconds", at, id);
      n += add("daily_vigorousIntensityDurationInSeconds", minutes(r.vigorousIntensityMinutes), "seconds", at, id);
      n += add("daily_activeTimeInSeconds", inRange(num(r.activeSeconds), 0, 86_400), "seconds", at, id);
      n += add("daily_highlyActiveDurationInSeconds", inRange(num(r.highlyActiveSeconds), 0, 86_400), "seconds", at, id);
      n += add("daily_averageStressLevel", inRange(num(stress?.averageStressLevel), 0, 100), null, at, id);
      n += add("daily_maxStressLevel", inRange(num(stress?.maxStressLevel), 0, 100), null, at, id);
      n += add("daily_stressDurationInSeconds", inRange(num(stress?.stressDuration), 0, 86_400), "seconds", at, id);
      n += add("daily_restStressDurationInSeconds", inRange(num(stress?.restDuration), 0, 86_400), "seconds", at, id);
      n += add("dailyBodyBattery_highestValue", bbStat("HIGHEST"), null, at, id);
      n += add("dailyBodyBattery_lowestValue", bbStat("LOWEST"), null, at, id);
      n += add("dailyBodyBattery_chargedValue", inRange(num(bb?.chargedValue), 0, 200), null, at, id);
      n += add("dailyBodyBattery_drainedValue", inRange(num(bb?.drainedValue), 0, 200), null, at, id);
      n += add("pulseOx_avgSpo2InPercent", inRange(num(r.averageSpo2Value), 50, 100), "%", at, id);
      n += add("pulseOx_minSpo2InPercent", inRange(num(r.lowestSpo2Value), 50, 100), "%", at, id);
      n += add("respiration_avgWakingBreathsPerMinute", inRange(num(resp?.avgWakingRespirationValue), 3, 60), "brpm", at, id);
      if (n > 0) {
        report.daily.imported++;
        seeDay(report.daily, day);
      } else report.daily.skipped++; // a day without any wellness data (watch not worn)
    }
  }

  for (const f of byKind("sleep")) {
    report.sleep.files++;
    for (const r of arr(f.json)) {
      report.sleep.records++;
      const day = isObj(r) ? dayOf(r.calendarDate) : null;
      if (!isObj(r) || !day) {
        report.sleep.skipped++;
        continue;
      }
      const at = dayBounds(day, offsets.get(day) ?? null, opts.timeZone);
      const id = `${day}#0`;
      const sec = (v: unknown) => inRange(num(v), 0, 86_400);
      const deep = sec(r.deepSleepSeconds);
      const light = sec(r.lightSleepSeconds);
      const rem = sec(r.remSleepSeconds);
      const total = deep === null && light === null && rem === null ? null : (deep ?? 0) + (light ?? 0) + (rem ?? 0);
      const spo2 = isObj(r.spo2SleepSummary) ? r.spo2SleepSummary : null;
      let n = 0;
      n += add("sleep_durationInSeconds", total && total > 0 ? total : null, "seconds", at, id);
      n += add("sleep_deepSleepDurationInSeconds", deep, "seconds", at, id);
      n += add("sleep_lightSleepDurationInSeconds", light, "seconds", at, id);
      n += add("sleep_remSleepInSeconds", rem, "seconds", at, id);
      n += add("sleep_awakeDurationInSeconds", sec(r.awakeSleepSeconds), "seconds", at, id);
      n += add("sleep_averageSpO2", inRange(num(spo2?.averageSPO2), 50, 100), "%", at, id);
      n += add("sleep_averageHeartRateInBeatsPerMinute", inRange(num(spo2?.averageHR), 20, 200), "bpm", at, id);
      n += add("sleep_averageRespiration", inRange(num(r.averageRespiration), 3, 60), "brpm", at, id);
      if (n > 0) {
        report.sleep.imported++;
        seeDay(report.sleep, day);
      } else report.sleep.skipped++;
    }
  }

  for (const f of byKind("biometrics")) {
    report.biometrics.files++;
    for (const r of arr(f.json)) {
      // Most biometrics rows carry height or activity class only: not weigh-ins, not counted.
      const w = isObj(r) && isObj(r.weight) && r.weight.weight != null ? r.weight : null;
      if (!w) continue;
      report.biometrics.records++;
      const meta = isObj(r) && isObj(r.metaData) ? r.metaData : null;
      const day = dayOf(meta?.calendarDate);
      if (!meta || !day) {
        report.biometrics.skipped++;
        continue;
      }
      if (w.sourceType === "USER_SETTING") {
        report.weightProfileValuesSkipped++;
        report.biometrics.skipped++;
        continue;
      }
      const at = dayBounds(day, offsets.get(day) ?? null, opts.timeZone);
      const seq = num(meta.sequence) ?? 0;
      if (add("body_weightInGrams", inRange(num(w.weight), 20_000, 400_000), "grams", at, `${day}#${seq}`)) {
        report.biometrics.imported++;
        seeDay(report.biometrics, day);
      } else report.biometrics.skipped++;
    }
  }

  // VO2 max: several rows per day and sport; keep the most recently updated one.
  const vo2 = new Map<string, { metric: string; day: string; value: number; updated: string }>();
  for (const f of byKind("vo2max")) {
    report.vo2max.files++;
    for (const r of arr(f.json)) {
      report.vo2max.records++;
      const day = isObj(r) ? dayOf(r.calendarDate) : null;
      if (!isObj(r) || !day) {
        report.vo2max.skipped++;
        continue;
      }
      const sport = typeof r.sport === "string" && r.sport ? r.sport.toUpperCase() : "";
      const metric =
        sport === "RUNNING"
          ? "userMetrics_vo2MaxRunning"
          : sport === "WALKING"
            ? "userMetrics_vo2MaxWalking"
            : sport === "CYCLING"
              ? "userMetrics_vo2MaxCycling"
              : "userMetrics_vo2Max";
      const updated = typeof r.updateTimestamp === "string" ? r.updateTimestamp : "";
      let used = false;
      const value = inRange(num(r.vo2MaxValue), 10, 100);
      if (value !== null) {
        const key = `${metric}|${day}`;
        const prev = vo2.get(key);
        if (!prev || updated >= prev.updated) vo2.set(key, { metric, day, value, updated });
        used = true;
      }
      const age = inRange(typeof r.fitnessAge === "string" ? Number(r.fitnessAge) : num(r.fitnessAge), 5, 120);
      if (age !== null) {
        const key = `userMetrics_fitnessAge|${day}`;
        const prev = vo2.get(key);
        if (!prev || updated >= prev.updated) vo2.set(key, { metric: "userMetrics_fitnessAge", day, value: age, updated });
        used = true;
      }
      if (used) seeDay(report.vo2max, day);
      else report.vo2max.skipped++;
    }
  }
  for (const v of vo2.values()) {
    const at = dayBounds(v.day, offsets.get(v.day) ?? null, opts.timeZone);
    report.vo2max.imported += add(v.metric, v.value, v.metric === "userMetrics_fitnessAge" ? "years" : "ml/kg/min", at, `${v.day}#0`);
  }

  for (const f of byKind("activities")) {
    report.activities.files++;
    const list = arr(f.json).flatMap((x) => (isObj(x) ? arr(x.summarizedActivitiesExport) : []));
    for (const a of list) {
      report.activities.records++;
      const id = isObj(a) ? num(a.activityId) : null;
      const gmt = isObj(a) ? (num(a.startTimeGmt) ?? num(a.beginTimestamp)) : null;
      if (!isObj(a) || id === null || gmt === null) {
        report.activities.skipped++;
        continue;
      }
      const local = num(a.startTimeLocal);
      const offsetMin = local !== null ? Math.round((local - gmt) / 60_000) : 0;
      const durationMs = inRange(num(a.duration), 0, 7 * 86_400_000);
      const at = { startMs: gmt, endMs: gmt + (durationMs ?? 0), offsetMin: Math.abs(offsetMin) <= 840 ? offsetMin : 0 };
      const ext = `activity:${id}`;
      const cm = (v: unknown, max: number) => {
        const n = inRange(num(v), 0, max * 100);
        return n === null ? null : Math.round(n) / 100;
      };
      if (typeof a.activityType === "string" && a.activityType) {
        samples.push({
          source: GARMIN_EXPORT_SOURCE,
          device: DEVICE,
          externalId: ext,
          metric: "activity_activityType",
          startMs: at.startMs,
          endMs: at.endMs,
          offsetMin: at.offsetMin,
          valueText: a.activityType,
        });
      }
      add("activity_durationInSeconds", durationMs === null ? null : Math.round(durationMs / 1000), "seconds", at, ext);
      add(
        "activity_movingDurationInSeconds",
        (() => {
          const m = inRange(num(a.movingDuration), 0, 7 * 86_400_000);
          return m === null ? null : Math.round(m / 1000);
        })(),
        "seconds",
        at,
        ext,
      );
      add("activity_distanceInMeters", cm(a.distance, 1_000_000), "meters", at, ext);
      add("activity_totalElevationGainInMeters", cm(a.elevationGain, 20_000), "meters", at, ext);
      add(
        "activity_activeKilocalories",
        (() => {
          const kj = inRange(num(a.calories), 0, 80_000);
          return kj === null ? null : Math.round(kj / 4.184);
        })(),
        "kcal",
        at,
        ext,
      );
      add("activity_averageHeartRateInBeatsPerMinute", inRange(num(a.avgHr), 20, 250), "bpm", at, ext);
      add("activity_maxHeartRateInBeatsPerMinute", inRange(num(a.maxHr), 20, 250), "bpm", at, ext);
      add("activity_steps", inRange(num(a.steps), 0, 200_000), null, at, ext);
      add("activity_aerobicTrainingEffect", inRange(num(a.aerobicTrainingEffect), 0, 5), null, at, ext);
      add("activity_anaerobicTrainingEffect", inRange(num(a.anaerobicTrainingEffect), 0, 5), null, at, ext);
      add("activity_vo2Max", inRange(num(a.vO2MaxValue), 10, 100), "ml/kg/min", at, ext);
      report.activities.imported++;
      seeDay(report.activities, new Date(at.startMs + at.offsetMin * 60_000).toISOString().slice(0, 10));
    }
  }

  return { samples, catalog: catalogFor(samples), report };
}

/** Catalog rows for what was imported: unit, first and last day, number of readings. */
export function catalogFor(samples: SampleInput[]): CatalogEntry[] {
  const by = new Map<string, CatalogEntry>();
  for (const s of samples) {
    const day = new Date(s.startMs + s.offsetMin * 60_000).toISOString().slice(0, 10);
    const e = by.get(s.metric) ?? { metric: s.metric, unit: s.unit, device: s.device, firstDay: day, lastDay: day, records: 0 };
    e.records = (e.records ?? 0) + 1;
    if (day < e.firstDay!) e.firstDay = day;
    if (day > e.lastDay!) e.lastDay = day;
    by.set(s.metric, e);
  }
  return [...by.values()].sort((a, b) => a.metric.localeCompare(b.metric));
}
