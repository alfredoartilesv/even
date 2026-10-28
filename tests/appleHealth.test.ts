import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AggregatedSample, HealthSample, QueryAggregatedOptions, QueryOptions, QueryWorkoutsOptions, Workout } from "@capgo/capacitor-health";
import { localDayStart } from "../src/core/tz";
import { listWorkouts } from "../src/domain/me/workouts";
import { upsertSamples } from "../src/domain/metrics/samples";
import { APPLE_HEALTH_SOURCE, AppleHealthSource, appleHealthEnabled, setAppleHealthEnabled, type HealthStore } from "../src/domain/sync/appleHealth";
import { runSync } from "../src/domain/sync/runSync";
import type { SampleInput } from "../src/domain/sync/types";
import { migratedDb } from "./helpers";

const TZ = "Europe/Madrid";
const NOW = Date.parse("2026-10-27T10:00:00Z"); // 11:00 in Madrid, Tuesday 27 October
const midnight = (day: string) => localDayStart(day, TZ).startMs;
const iso = (ms: number) => new Date(ms).toISOString();
/** Wall-clock time in Madrid (25 October had 25 hours, so not midnight + h). */
const at = (day: string, hh: number, mm = 0) => midnight(day) + (hh * 60 + mm) * 60_000 + (localDayStart(day, TZ).offsetMin - offsetAt(day, hh)) * 60_000;
const offsetAt = (day: string, hh: number) => (day === "2026-10-25" && hh >= 3 ? 60 : localDayStart(day, TZ).offsetMin);

/** A HealthKit stand-in: daily statistics per type, raw samples per type, workouts in pages. */
function fakeStore(data: {
  daily?: Record<string, Record<string, Partial<Record<"sum" | "average" | "min" | "max", number>>>>;
  samples?: Record<string, HealthSample[]>;
  workouts?: Workout[][];
  deny?: string[];
}) {
  const calls: { aggregated: QueryAggregatedOptions[]; samples: QueryOptions[]; workouts: QueryWorkoutsOptions[] } = {
    aggregated: [],
    samples: [],
    workouts: [],
  };
  const store: HealthStore = {
    async queryAggregated(o) {
      calls.aggregated.push(o);
      if (data.deny?.includes(o.dataType)) throw new Error("Authorization not determined");
      const days = data.daily?.[o.dataType] ?? {};
      const samples: AggregatedSample[] = Object.entries(days).map(([day, values]) => ({
        startDate: iso(midnight(day)),
        endDate: iso(midnight(day) + 86_400_000),
        value: Object.values(values)[0] ?? 0,
        values,
        unit: "count",
      }));
      return { samples };
    },
    async readSamples(o) {
      calls.samples.push(o);
      if (data.deny?.includes(o.dataType)) throw new Error("Authorization not determined");
      return { samples: data.samples?.[o.dataType] ?? [] };
    },
    async queryWorkouts(o) {
      calls.workouts.push(o);
      const pages = data.workouts ?? [[]];
      const i = o.anchor ? Number(o.anchor) : 0;
      return { workouts: pages[i] ?? [], ...(i + 1 < pages.length ? { anchor: String(i + 1) } : {}) };
    },
  };
  return { store, calls };
}

const source = (store: HealthStore) => new AppleHealthSource({ store, timeZone: TZ, now: () => NOW });
const pick = (samples: SampleInput[], metric: string, externalId?: string) =>
  samples.filter((s) => s.metric === metric && (externalId === undefined || s.externalId === externalId)).map((s) => s.valueNum ?? s.valueText);

test("daily statistics become the Garmin metrics, per local day, with total = active + resting", async () => {
  const { store } = fakeStore({
    daily: {
      steps: { "2026-10-26": { sum: 8123.6 }, "2026-10-27": { sum: 2400 } },
      distance: { "2026-10-26": { sum: 6100.4 } },
      calories: { "2026-10-26": { sum: 512.4 } },
      basalCalories: { "2026-10-26": { sum: 1690.2 } },
      restingHeartRate: { "2026-10-26": { average: 52.6 } },
      heartRate: { "2026-10-26": { min: 48, max: 161 } },
      heartRateVariability: { "2026-10-26": { average: 41.2 } },
      oxygenSaturation: { "2026-10-26": { average: 0.968, min: 0.92 } },
    },
  });
  const res = await source(store).fetchSince(null);
  const d = "2026-10-26#0";
  assert.deepEqual(pick(res.samples, "daily_steps", d), [8124]);
  assert.deepEqual(pick(res.samples, "daily_steps", "2026-10-27#0"), [2400]);
  assert.deepEqual(pick(res.samples, "daily_distanceInMeters", d), [6100]);
  assert.deepEqual(pick(res.samples, "daily_activeKilocalories", d), [512]);
  assert.deepEqual(pick(res.samples, "daily_bmrKilocalories", d), [1690]);
  assert.deepEqual(pick(res.samples, "daily_totalKilocalories", d), [2202]);
  assert.deepEqual(pick(res.samples, "daily_restingHeartRateInBeatsPerMinute", d), [53]);
  assert.deepEqual(pick(res.samples, "daily_minHeartRateInBeatsPerMinute", d), [48]);
  assert.deepEqual(pick(res.samples, "daily_maxHeartRateInBeatsPerMinute", d), [161]);
  assert.deepEqual(pick(res.samples, "hrv_sdnnAvg", d), [41], "SDNN in its own metric, not Garmin's RMSSD series");
  assert.deepEqual(pick(res.samples, "hrv_lastNightAvg"), []);
  assert.deepEqual(pick(res.samples, "pulseOx_avgSpo2InPercent", d), [97], "HealthKit's fraction as percent");
  assert.deepEqual(pick(res.samples, "pulseOx_minSpo2InPercent", d), [92]);

  const steps = res.samples.find((s) => s.metric === "daily_steps" && s.externalId === d)!;
  assert.equal(steps.source, APPLE_HEALTH_SOURCE);
  assert.equal(steps.startMs, midnight("2026-10-26"));
  assert.equal(steps.endMs, midnight("2026-10-27"));
  assert.equal(steps.offsetMin, 60, "CET after the clocks went back on 25 October");
  assert.ok(res.catalog?.some((c) => c.metric === "daily_steps"));
});

test("impossible values and empty sums are skipped, not stored", async () => {
  const { store } = fakeStore({
    daily: {
      steps: { "2026-10-25": { sum: 0 }, "2026-10-26": { sum: 900_000 } },
      restingHeartRate: { "2026-10-26": { average: 5 } },
      oxygenSaturation: { "2026-10-26": { average: 0.2 } },
      calories: { "2026-10-26": { sum: 300 } },
    },
  });
  const res = await source(store).fetchSince(null);
  assert.deepEqual(pick(res.samples, "daily_steps"), []);
  assert.deepEqual(pick(res.samples, "daily_restingHeartRateInBeatsPerMinute"), []);
  assert.deepEqual(pick(res.samples, "pulseOx_avgSpo2InPercent"), []);
  assert.deepEqual(pick(res.samples, "daily_totalKilocalories"), [], "no total without the resting part");
});

test("the first sync reads 30 local days, later ones start at the cursor and end today", async () => {
  const { store, calls } = fakeStore({});
  const first = await source(store).fetchSince(null);
  assert.equal(calls.aggregated[0].startDate, iso(midnight("2026-09-28")));
  assert.equal(calls.aggregated[0].endDate, iso(midnight("2026-10-28")));
  assert.equal(calls.aggregated[0].bucket, "day");
  assert.equal(first.nextCursor, "2026-10-26", "yesterday is read again next time");

  const { store: s2, calls: c2 } = fakeStore({});
  await source(s2).fetchSince("2026-10-26");
  assert.equal(c2.aggregated[0].startDate, iso(midnight("2026-10-26")));
  assert.equal(c2.samples.find((o) => o.dataType === "sleep")!.startDate, iso(midnight("2026-10-26") - 12 * 3_600_000), "sleep from the evening before");
});

const stage = (state: HealthSample["sleepState"], from: number, to: number, device: string): HealthSample => ({
  dataType: "sleep",
  value: (to - from) / 60_000,
  unit: "minute",
  startDate: iso(from),
  endDate: iso(to),
  sourceId: device,
  sourceName: device,
  sleepState: state,
});

test("sleep: a night goes to the wake-up day and is read from the device that recorded the most", async () => {
  const watch = "com.apple.health.watch";
  const phone = "com.apple.health.iphone";
  const { store } = fakeStore({
    samples: {
      sleep: [
        // Night of 25 to 26 October, Watch stages.
        stage("light", at("2026-10-25", 23, 30), at("2026-10-26", 1, 0), watch),
        stage("deep", at("2026-10-26", 1, 0), at("2026-10-26", 2, 30), watch),
        stage("rem", at("2026-10-26", 2, 30), at("2026-10-26", 4, 0), watch),
        stage("awake", at("2026-10-26", 4, 0), at("2026-10-26", 4, 10), watch),
        stage("light", at("2026-10-26", 4, 10), at("2026-10-26", 7, 0), watch),
        // The iPhone's own guess for the same night: fewer hours, must not be added.
        stage("inBed", at("2026-10-25", 23, 0), at("2026-10-26", 7, 30), phone),
        stage("asleep", at("2026-10-26", 0, 0), at("2026-10-26", 6, 0), phone),
        // A nap on the 26th, iPhone only.
        stage("asleep", at("2026-10-26", 15, 0), at("2026-10-26", 15, 40), phone),
      ],
    },
  });
  const res = await source(store).fetchSince(null);
  const n = "2026-10-26#0";
  // Watch: light 1.5 h + 2 h 50, deep 1.5 h, rem 1.5 h = 7 h 20 asleep; the phone had 6 h 40 (+ nap).
  assert.deepEqual(pick(res.samples, "sleep_durationInSeconds", n), [7 * 3600 + 20 * 60]);
  assert.deepEqual(pick(res.samples, "sleep_deepSleepDurationInSeconds", n), [5400]);
  assert.deepEqual(pick(res.samples, "sleep_lightSleepDurationInSeconds", n), [1.5 * 3600 + 170 * 60]);
  assert.deepEqual(pick(res.samples, "sleep_remSleepInSeconds", n), [5400]);
  assert.deepEqual(pick(res.samples, "sleep_awakeDurationInSeconds", n), [600]);
  assert.deepEqual(pick(res.samples, "sleep_durationInSeconds", "2026-10-25#0"), [], "23:30 belongs to the next day");
});

test("sleep: sessions that carry their stages, and nights with only time in bed", async () => {
  const session: HealthSample = {
    ...stage("asleep", at("2026-10-26", 23, 0), at("2026-10-27", 6, 0), "ring"),
    sleepState: undefined,
    stages: [
      { stage: "deep", startDate: iso(at("2026-10-26", 23, 0)), endDate: iso(at("2026-10-27", 1, 0)), durationMinutes: 120 },
      { stage: "light", startDate: iso(at("2026-10-27", 1, 0)), endDate: iso(at("2026-10-27", 6, 0)), durationMinutes: 300 },
    ],
  };
  const { store } = fakeStore({ samples: { sleep: [session, stage("inBed", at("2026-10-25", 23, 0), at("2026-10-26", 6, 0), "phone")] } });
  const res = await source(store).fetchSince(null);
  assert.deepEqual(pick(res.samples, "sleep_durationInSeconds"), [7 * 3600]);
  assert.deepEqual(pick(res.samples, "sleep_durationInSeconds", "2026-10-27#0"), [7 * 3600]);
  assert.deepEqual(pick(res.samples, "sleep_durationInSeconds", "2026-10-26#0"), [], "in bed is not sleep");
});

test("weigh-ins in grams at their time; workouts with Garmin-style type keys, all pages", async () => {
  const weigh = at("2026-10-26", 7, 45);
  const w = (id: string, type: string, start: number, extra: Partial<Workout> = {}): Workout => ({
    workoutType: type as Workout["workoutType"],
    duration: 1800,
    startDate: iso(start),
    endDate: iso(start + 1_800_000),
    platformId: id,
    sourceName: "Apple Watch",
    ...extra,
  });
  const { store, calls } = fakeStore({
    samples: { weight: [{ dataType: "weight", value: 78.43, unit: "kilogram", startDate: iso(weigh), endDate: iso(weigh), platformId: "W1" }] },
    workouts: [
      [w("A", "running", at("2026-10-25", 8), { totalDistance: 5012.3, totalEnergyBurned: 401.2 })],
      [w("B", "traditionalStrengthTraining", at("2026-10-26", 19), { sourceName: "Garmin Connect" })],
    ],
  });
  const res = await source(store).fetchSince(null);
  const weight = res.samples.find((s) => s.metric === "body_weightInGrams")!;
  assert.equal(weight.valueNum, 78_430);
  assert.equal(weight.externalId, "weight:W1");
  assert.equal(weight.startMs, weigh);

  assert.equal(calls.workouts.length, 2, "followed the anchor to the second page");
  assert.deepEqual(pick(res.samples, "activity_activityType"), ["running", "traditional_strength_training"]);
  assert.deepEqual(pick(res.samples, "activity_distanceInMeters", "workout:A"), [5012]);
  assert.deepEqual(pick(res.samples, "activity_activeKilocalories", "workout:A"), [401]);
  assert.deepEqual(pick(res.samples, "activity_durationInSeconds", "workout:B"), [1800]);
  assert.deepEqual(pick(res.samples, "activity_distanceInMeters", "workout:B"), [], "no distance for strength");
  const b = res.samples.find((s) => s.externalId === "workout:B" && s.metric === "activity_activityType")!;
  assert.deepEqual(b.raw, { recordedBy: "Garmin Connect" });
});

test("a type the owner did not allow is a warning; everything else is still read", async () => {
  const { store } = fakeStore({ deny: ["heartRate", "sleep"], daily: { steps: { "2026-10-26": { sum: 5000 } } } });
  const res = await source(store).fetchSince(null);
  assert.deepEqual(pick(res.samples, "daily_steps"), [5000]);
  assert.equal(res.warnings?.length, 2);
  assert.match(res.warnings![0], /^heartRate: not read/);
});

test("runSync stores Apple Health and a re-sync adds nothing new", async () => {
  const { db } = await migratedDb();
  const { store } = fakeStore({ daily: { steps: { "2026-10-26": { sum: 8000 } } } });
  const first = await runSync(db, source(store), () => NOW);
  assert.equal(first.status, "ok");
  assert.equal(first.cursorAfter, "2026-10-26");
  await runSync(db, source(store), () => NOW);
  const rows = await db.all<{ n: number }>("SELECT COUNT(*) AS n FROM health_samples WHERE source = ?", [APPLE_HEALTH_SOURCE]);
  assert.equal(rows[0].n, 1);
});

const sample = (from: string, metric: string, day: string, v: number, externalId = `${day}#0`): SampleInput => ({
  source: from,
  device: from,
  externalId,
  metric,
  startMs: midnight(day),
  endMs: midnight(day) + 86_400_000,
  offsetMin: localDayStart(day, TZ).offsetMin,
  valueNum: v,
});
async function shown(db: Awaited<ReturnType<typeof migratedDb>>["db"], metric: string, day: string) {
  const r = await db.all<{ source: string }>("SELECT source FROM daily_metric_values WHERE metric = ? AND local_day = ? ORDER BY source", [metric, day]);
  return r.map((x) => x.source);
}

test("priority per metric and day: Garmin, then freddy, then Apple Health, then the export", async () => {
  const { db } = await migratedDb();
  await upsertSamples(db, [
    // 24th: all four. 25th: Apple Health and the export. 26th: export only. 23rd: freddy and Apple Health.
    sample("garmin", "daily_steps", "2026-10-24", 9000),
    sample("freddy", "daily_steps", "2026-10-24", 8900),
    sample("apple_health", "daily_steps", "2026-10-24", 11000),
    sample("garmin_export", "daily_steps", "2026-10-24", 9000),
    sample("apple_health", "daily_steps", "2026-10-25", 7000),
    sample("garmin_export", "daily_steps", "2026-10-25", 6800),
    sample("garmin_export", "daily_steps", "2026-10-26", 4000),
    sample("freddy", "daily_steps", "2026-10-23", 5000),
    sample("apple_health", "daily_steps", "2026-10-23", 5200),
    // Apple Health's own HRV metric is shown even on a Garmin day: Garmin has no SDNN.
    sample("garmin", "hrv_lastNightAvg", "2026-10-24", 45),
    sample("apple_health", "hrv_sdnnAvg", "2026-10-24", 38),
    // A source outside the list is never hidden and hides only the export.
    sample("manual", "body_weightInGrams", "2026-10-24", 78_000),
    sample("apple_health", "body_weightInGrams", "2026-10-24", 78_200),
    sample("garmin_export", "body_weightInGrams", "2026-10-24", 78_100),
  ]);
  assert.deepEqual(await shown(db, "daily_steps", "2026-10-24"), ["garmin"]);
  assert.deepEqual(await shown(db, "daily_steps", "2026-10-25"), ["apple_health"]);
  assert.deepEqual(await shown(db, "daily_steps", "2026-10-26"), ["garmin_export"]);
  assert.deepEqual(await shown(db, "daily_steps", "2026-10-23"), ["freddy"]);
  assert.deepEqual(await shown(db, "hrv_sdnnAvg", "2026-10-24"), ["apple_health"]);
  assert.deepEqual(await shown(db, "body_weightInGrams", "2026-10-24"), ["apple_health", "manual"]);
});

test("workouts: an Apple Health day gives way to a Garmin day, and beats the export", async () => {
  const { db } = await migratedDb();
  const session = (src: string, day: string, id: string, type: string): SampleInput[] => [
    { ...sample(src, "activity_activityType", day, 0, id), valueNum: undefined, valueText: type },
    sample(src, "activity_durationInSeconds", day, 1800, id),
  ];
  await upsertSamples(db, [
    ...session("garmin", "2026-10-24", "activity:1", "running"),
    ...session("apple_health", "2026-10-24", "workout:X", "running"),
    ...session("apple_health", "2026-10-25", "workout:Y", "walking"),
    ...session("garmin_export", "2026-10-25", "activity:2", "walking"),
  ]);
  const list = await listWorkouts(db, "2026-10-20", "2026-10-27");
  assert.deepEqual(
    list.map((w) => `${w.day} ${w.source}`),
    ["2026-10-25 apple_health", "2026-10-24 garmin"],
  );
});

test("connecting is remembered in settings (HealthKit never says whether reading was allowed)", async () => {
  const { db } = await migratedDb();
  assert.equal(await appleHealthEnabled(db), false);
  await setAppleHealthEnabled(db, true);
  assert.equal(await appleHealthEnabled(db), true);
  await setAppleHealthEnabled(db, false);
  assert.equal(await appleHealthEnabled(db), false);
});

test("the HealthKit plugin stays out of Android; every other native plugin is still in", () => {
  const root = join(import.meta.dirname, "..");
  const config = JSON.parse(readFileSync(join(root, "capacitor.config.json"), "utf8"));
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const nativePlugins = Object.keys(pkg.dependencies).filter(
    (d) => existsSync(join(root, "node_modules", d, "android")) && !["@capacitor/android", "@capacitor/core", "@capacitor/ios"].includes(d),
  );
  assert.ok(nativePlugins.includes("@capgo/capacitor-health"));
  assert.deepEqual([...config.android.includePlugins].sort(), nativePlugins.filter((d) => d !== "@capgo/capacitor-health").sort());
  assert.equal(config.ios?.includePlugins, undefined, "iOS gets every plugin");
  assert.equal(pkg.dependencies["@capgo/capacitor-health"], "8.11.11", "pinned: it reads health data");
});
