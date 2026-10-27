import test from "node:test";
import assert from "node:assert/strict";
import { strToU8, zipSync } from "fflate";
import { GARMIN_EXPORT_SOURCE, garminKind, parseGarminExport } from "../src/features/import/garmin";
import { garminExportCoverage, importGarminZip, readGarminZip } from "../src/features/import/garminImport";
import { dailySeries, dayValues } from "../src/features/metrics/queries";
import { upsertSamples } from "../src/features/metrics/samples";
import { memoryDriver, migratedDb, realMigrations } from "./helpers";
import { migrate } from "../src/db/migrate";

// Synthetic export in the real export's shapes (field names and units checked against one, 26 Oct 2026).
// Values are invented.
const TZ = "Europe/Madrid";
const uds = (day: string, over: Record<string, unknown> = {}) => ({
  userProfilePK: 1,
  calendarDate: day,
  totalSteps: 9000,
  totalDistanceMeters: 7000,
  totalKilocalories: 2500,
  activeKilocalories: 600,
  bmrKilocalories: 1900,
  restingHeartRate: 52, // Garmin's 7-day average: not imported
  currentDayRestingHeartRate: 49,
  minHeartRate: 48,
  maxHeartRate: 160,
  moderateIntensityMinutes: 20,
  vigorousIntensityMinutes: 10,
  activeSeconds: 5000,
  highlyActiveSeconds: 1200,
  wellnessStartTimeGmt: `${day}T22:00:00.0`.replace(day, prevDay(day)),
  wellnessStartTimeLocal: `${day}T00:00:00.0`,
  includesWellnessData: true,
  allDayStress: {
    aggregatorList: [
      { type: "TOTAL", averageStressLevel: 30, maxStressLevel: 90, stressDuration: 20000, restDuration: 30000 },
      { type: "AWAKE", averageStressLevel: 40, maxStressLevel: 90 },
    ],
  },
  bodyBattery: {
    chargedValue: 60,
    drainedValue: 55,
    bodyBatteryStatList: [
      { bodyBatteryStatType: "HIGHEST", statsValue: 85 },
      { bodyBatteryStatType: "LOWEST", statsValue: 20 },
    ],
  },
  averageSpo2Value: 95,
  lowestSpo2Value: 88,
  respiration: { avgWakingRespirationValue: 14 },
  ...over,
});
function prevDay(day: string) {
  return new Date(Date.parse(`${day}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
}

function exportZip() {
  const json = (o: unknown) => strToU8(JSON.stringify(o));
  return zipSync({
    "customer_data/customer.json": json({ email: "someone@example.com" }),
    "DI_CONNECT/DI-Connect-Aggregator/UDSFile_2026-10-01_2026-12-31.json": json([
      uds("2026-10-24"),
      uds("2026-10-25", { averageSpo2Value: null, allDayStress: { aggregatorList: [{ type: "TOTAL", averageStressLevel: -1, maxStressLevel: -2 }] } }),
      { calendarDate: "2026-10-26", includesWellnessData: false, totalSteps: null },
      { calendarDate: "not a day" },
    ]),
    "DI_CONNECT/DI-Connect-Wellness/2026-10-01_2026-12-31_123_sleepData.json": json([
      { calendarDate: "2026-10-24", deepSleepSeconds: 5400, lightSleepSeconds: 14400, remSleepSeconds: 6000, awakeSleepSeconds: 900, averageRespiration: 13, spo2SleepSummary: { averageSPO2: 94, averageHR: 50 } },
    ]),
    "DI_CONNECT/DI-Connect-Wellness/123_userBioMetrics.json": json([
      { metaData: { calendarDate: "2026-10-24", sequence: 1 }, weight: { weight: 80500, sourceType: "MANUAL" } },
      { metaData: { calendarDate: "2026-10-24T19:30:00.0", sequence: 2 }, weight: { weight: 80100, sourceType: "UNKNOWN" } }, // date-time, as in the real file
      { metaData: { calendarDate: "2026-10-23T07:00:00.123", sequence: 1 }, weight: { weight: null, sourceType: "MANUAL" } },
      { metaData: { calendarDate: "2026-10-20", sequence: 1 }, weight: { weight: 82000, sourceType: "USER_SETTING" } },
      { metaData: { calendarDate: "2026-10-21", sequence: 1 }, height: 180 },
    ]),
    "DI_CONNECT/DI-Connect-Metrics/MetricsMaxMetData_1_2_3.json": json([
      { calendarDate: "2026-10-24", sport: "RUNNING", vo2MaxValue: 50, fitnessAge: "30", updateTimestamp: "2026-10-24T08:00:00.0" },
      { calendarDate: "2026-10-24", sport: "RUNNING", vo2MaxValue: 51, fitnessAge: "29", updateTimestamp: "2026-10-24T20:00:00.0" },
      { calendarDate: "2026-10-24", sport: "WALKING", vo2MaxValue: 45, updateTimestamp: "2026-10-24T20:00:00.0" },
    ]),
    "DI_CONNECT/DI-Connect-Fitness/someone@example.com_1_summarizedActivities.json": json([
      {
        summarizedActivitiesExport: [
          {
            activityId: 777,
            activityType: "running",
            name: "Morning Run in Some Park",
            locationName: "Some City",
            startLatitude: 40.4,
            startTimeGmt: Date.UTC(2026, 9, 24, 6, 0),
            startTimeLocal: Date.UTC(2026, 9, 24, 8, 0),
            duration: 1_800_000, // ms
            movingDuration: 1_750_000,
            distance: 600_000, // cm = 6 km
            elevationGain: 4_500, // cm = 45 m
            avgSpeed: 0.333, // (m/s)/10, not used
            calories: 1757, // kJ = 420 kcal
            avgHr: 150,
            maxHr: 175,
            steps: 5200,
            aerobicTrainingEffect: 3.2,
            anaerobicTrainingEffect: 1.1,
            vO2MaxValue: 51,
          },
          { activityType: "walking" }, // no id: skipped
        ],
      },
    ]),
    "DI_CONNECT/DI-Connect-Fitness/someone@example.com_gear.json": json([{ gearDTOs: [] }]),
    "DI_CONNECT/DI-Connect-Uploaded-Files/UploadedFiles_0-_Part1.zip": new Uint8Array([1, 2, 3]),
  });
}

test("only the five data files are picked, whatever the account email in their names", () => {
  assert.equal(garminKind("DI_CONNECT/DI-Connect-Fitness/a.b+c@mail.co.uk_3_summarizedActivities.json"), "activities");
  assert.equal(garminKind("DI_CONNECT/DI-Connect-Fitness/x@y.com_gear.json"), null);
  assert.equal(garminKind("DI_CONNECT/DI-Connect-Aggregator/HydrationLogFile_2025-01-01_2025-04-01.json"), null);
  const files = readGarminZip(exportZip());
  assert.deepEqual(files.map((f) => garminKind(f.path)).sort(), ["activities", "biometrics", "daily", "sleep", "vo2max"]);
  assert.throws(() => readGarminZip(zipSync({ "other.json": strToU8("{}") })), /No Garmin Connect data/);
  assert.throws(() => readGarminZip(new Uint8Array([1, 2, 3])), /not a readable ZIP/);
});

test("units are converted and the day's offset comes from the export", () => {
  const { samples, report } = parseGarminExport(readGarminZip(exportZip()), { timeZone: TZ });
  const get = (metric: string, ext = "2026-10-24#0") => samples.find((s) => s.metric === metric && s.externalId === ext);

  const steps = get("daily_steps")!;
  assert.equal(steps.source, GARMIN_EXPORT_SOURCE);
  assert.equal(steps.valueNum, 9000);
  assert.equal(steps.offsetMin, 120); // local 00:00 vs GMT 22:00 the day before
  assert.equal(steps.startMs, Date.UTC(2026, 9, 23, 22, 0));
  assert.equal(get("daily_moderateIntensityDurationInSeconds")!.valueNum, 1200); // minutes -> seconds
  assert.equal(get("dailyBodyBattery_highestValue")!.valueNum, 85);
  assert.equal(get("daily_averageStressLevel")!.valueNum, 30);
  assert.equal(get("daily_restingHeartRateInBeatsPerMinute")!.valueNum, 49, "the day's own value, as the Personal API has it");

  // Garmin's "no data" markers (-1, -2, null) are dropped, not imported as numbers.
  assert.equal(get("daily_averageStressLevel", "2026-10-25#0"), undefined);
  assert.equal(get("pulseOx_avgSpo2InPercent", "2026-10-25#0"), undefined);
  assert.equal(get("daily_steps", "2026-10-25#0")!.valueNum, 9000);

  assert.equal(get("sleep_durationInSeconds")!.valueNum, 5400 + 14400 + 6000);
  assert.equal(get("sleep_durationInSeconds")!.offsetMin, 120, "sleep reuses the day's offset");
  assert.equal(get("sleep_deepSleepDurationInSeconds")!.valueNum, 5400, "the sync's name");

  assert.deepEqual(samples.filter((s) => s.metric === "body_weightInGrams").map((s) => s.valueNum), [80500, 80100]);
  assert.equal(report.weightProfileValuesSkipped, 1);

  assert.equal(get("userMetrics_vo2MaxRunning")!.valueNum, 51, "latest update of the day wins");
  assert.equal(get("userMetrics_fitnessAge")!.valueNum, 29);
  assert.equal(get("userMetrics_vo2MaxWalking")!.valueNum, 45);

  const act = (metric: string) => get(metric, "activity:777")!;
  assert.equal(act("activity_distanceInMeters").valueNum, 6000); // cm -> m
  assert.equal(act("activity_activeKilocalories").valueNum, 420); // kJ -> kcal
  assert.equal(act("activity_durationInSeconds").valueNum, 1800); // ms -> s
  assert.equal(act("activity_totalElevationGainInMeters").valueNum, 45); // cm -> m
  assert.equal(act("activity_activityType").valueText, "running");
  assert.equal(act("activity_distanceInMeters").offsetMin, 120);
  assert.equal(act("activity_distanceInMeters").endMs! - act("activity_distanceInMeters").startMs, 1_800_000);

  // Privacy: names, places and coordinates never become samples.
  const text = JSON.stringify(samples);
  for (const secret of ["Some Park", "Some City", "40.4", "someone@example.com"]) assert.ok(!text.includes(secret), secret);

  assert.deepEqual(
    { days: report.daily.imported, skipped: report.daily.skipped, first: report.daily.firstDay, last: report.daily.lastDay },
    { days: 2, skipped: 2, first: "2026-10-24", last: "2026-10-25" },
  );
  assert.equal(report.activities.imported, 1);
  assert.equal(report.activities.skipped, 1);
});

test("stored as its own source with sensible daily aggregation; re-import adds nothing and keeps the owner's choices", async () => {
  const { db } = await migratedDb();
  assert.deepEqual(await garminExportCoverage(db), { readings: 0, from: null, to: null }, "nothing imported yet");
  const zip = exportZip();
  const first = await importGarminZip(db, zip, { timeZone: TZ, nowMs: 1_000 });
  assert.ok(first.written > 30);
  const count = async () => (await db.all<{ n: number }>("SELECT COUNT(*) AS n FROM health_samples"))[0].n;
  const n1 = await count();
  const covered = await garminExportCoverage(db);
  assert.equal(covered.readings, n1, "what Connections shows as imported");
  assert.ok(covered.from! <= "2026-10-24" && covered.to! >= "2026-10-24");

  const agg = async (m: string) => (await db.all<{ daily_agg: string }>("SELECT daily_agg FROM metric_catalog WHERE source = ? AND metric = ?", [GARMIN_EXPORT_SOURCE, m]))[0]?.daily_agg;
  assert.equal(await agg("daily_steps"), "sum");
  assert.equal(await agg("daily_maxHeartRateInBeatsPerMinute"), "max");
  assert.equal(await agg("activity_aerobicTrainingEffect"), "max");
  assert.equal(await agg("body_weightInGrams"), "last");

  // The owner prefers another aggregation; a re-import must not undo it, nor duplicate rows.
  await db.run("UPDATE metric_catalog SET daily_agg = 'avg' WHERE source = ? AND metric = 'daily_maxHeartRateInBeatsPerMinute'", [GARMIN_EXPORT_SOURCE]);
  await importGarminZip(db, zip, { timeZone: TZ, nowMs: 2_000 });
  assert.equal(await count(), n1);
  assert.equal(await agg("daily_maxHeartRateInBeatsPerMinute"), "avg");

  // Shows up in the app's day view like synced data, weight aggregated as the day's last weigh-in.
  const day = await dayValues(db, "2026-10-24");
  assert.equal(day.find((v) => v.metric === "daily_steps")!.value, 9000);
  assert.equal(day.find((v) => v.metric === "body_weightInGrams")!.value, 80100);
});

test("where freddy has the same metric on the same day, only freddy's value is shown", async () => {
  const { db } = await migratedDb();
  await importGarminZip(db, exportZip(), { timeZone: TZ, nowMs: 1_000 });
  // freddy synced 2026-10-24 (the same watch, so the same steps), not 2026-10-25.
  const day = Date.UTC(2026, 9, 23, 22, 0);
  await upsertSamples(db, [
    { source: "freddy", device: "", externalId: "2026-10-24#0", metric: "daily_steps", startMs: day, endMs: day + 86_400_000, offsetMin: 120, valueNum: 9000 },
  ], 2_000);

  const steps = (await dayValues(db, "2026-10-24")).filter((v) => v.metric === "daily_steps");
  assert.equal(steps.length, 1, "not counted twice");
  assert.equal(steps[0].device, "", "freddy's row");
  assert.equal((await dayValues(db, "2026-10-24")).filter((v) => v.metric === "sleep_durationInSeconds").length, 1, "metrics freddy lacks still come from the export");

  const series = await dailySeries(db, "daily_steps", "2026-10-24", "2026-10-25");
  assert.deepEqual(series.map((s) => [s.source, s.points.map((p) => p.day)]), [["freddy", ["2026-10-24"]], [GARMIN_EXPORT_SOURCE, ["2026-10-25"]]]);
  const kept = await db.all<{ n: number }>("SELECT COUNT(*) AS n FROM health_samples WHERE metric = 'daily_steps' AND local_day = '2026-10-24'");
  assert.equal(kept[0].n, 2, "both rows are kept, only the view picks one");
});

test("migration 0008 renames metrics an earlier import stored under the old names", async () => {
  const { db } = memoryDriver();
  const all = realMigrations();
  await migrate(db, all.filter((m) => m.version < 8));
  await db.run(
    `INSERT INTO health_samples (id, source, device, external_id, metric, start_ms, end_ms, offset_min, value_num, local_day, created_at, updated_at)
     VALUES ('a', 'garmin_export', 'Garmin', '2026-10-24#0', 'sleep_deepDurationInSeconds', 0, 1, 0, 5400, '2026-10-24', 0, 0),
            ('b', 'freddy', '', '2026-10-24#0', 'sleep_deepDurationInSeconds', 0, 1, 0, 5400, '2026-10-24', 0, 0)`,
  );
  await db.run("INSERT INTO metric_catalog (source, metric, updated_at) VALUES ('garmin_export', 'pulseOx_lowestSpO2', 0)");
  await migrate(db, all);
  const rows = await db.all<{ source: string; metric: string }>("SELECT source, metric FROM health_samples ORDER BY id");
  assert.deepEqual(rows, [
    { source: "garmin_export", metric: "sleep_deepSleepDurationInSeconds" },
    { source: "freddy", metric: "sleep_deepDurationInSeconds" },
  ], "only the import's rows");
  const cat = await db.all<{ metric: string }>("SELECT metric FROM metric_catalog WHERE source = 'garmin_export'");
  assert.deepEqual(cat.map((c) => c.metric), ["pulseOx_minSpo2InPercent"]);
});

test("migration 0009 turns activity calories an earlier import stored in kJ into kcal, and nothing else", async () => {
  const { db } = memoryDriver();
  const all = realMigrations();
  await migrate(db, all.filter((m) => m.version < 9));
  await db.run(
    `INSERT INTO health_samples (id, source, device, external_id, metric, start_ms, end_ms, offset_min, value_num, local_day, created_at, updated_at)
     VALUES ('a', 'garmin_export', 'Garmin', 'activity:1', 'activity_activeKilocalories', 0, 1, 0, 1757, '2026-10-24', 0, 0),
            ('b', 'freddy', '', '2026-10-24#0', 'activity_activeKilocalories', 0, 1, 0, 420, '2026-10-24', 0, 0),
            ('c', 'garmin_export', 'Garmin', '2026-10-24#0', 'daily_activeKilocalories', 0, 1, 0, 600, '2026-10-24', 0, 0)`,
  );
  await migrate(db, all);
  const rows = await db.all<{ id: string; value_num: number }>("SELECT id, value_num FROM health_samples ORDER BY id");
  assert.deepEqual(rows, [{ id: "a", value_num: 420 }, { id: "b", value_num: 420 }, { id: "c", value_num: 600 }]);
});
