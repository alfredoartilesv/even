import test from "node:test";
import assert from "node:assert/strict";
import { TOOLS_BY_NAME } from "../src/features/chat/tools";
import { logFood } from "../src/features/food/food";
import { insertGoal, insertMeasurement } from "../src/features/journal/journal";
import { fmtGoalValue, GOAL_TEMPLATES } from "../src/features/me/goalTemplates";
import { deleteGoal, evaluate, goalProgress, listGoals, periodStart, type Goal } from "../src/features/me/goals";
import { activityLabel, sportOf } from "../src/features/me/sports";
import { fmtDistance, fmtDuration, listWorkouts, personalBests, sportTotals } from "../src/features/me/workouts";
import { upsertCatalog } from "../src/features/metrics/catalog";
import { upsertSamples } from "../src/features/metrics/samples";
import { loadProfile, loadProfilePhoto, saveProfile, saveProfilePhoto } from "../src/features/settings/profile";
import type { SampleInput } from "../src/features/sync/types";
import { migratedDb } from "./helpers";

const TZ = "Europe/Madrid";
const TODAY = "2026-10-26"; // a Monday
const stamp = { createdBy: "user" as const, deviceId: "dev" };
const midnight = (day: string) => Date.parse(`${day}T00:00:00Z`) - 60 * 60_000; // CET, after the DST change
const sample = (p: Partial<SampleInput> & Pick<SampleInput, "source" | "externalId" | "metric">, day: string): SampleInput => ({
  device: "Garmin",
  startMs: midnight(day),
  endMs: midnight(day) + 86_400_000,
  offsetMin: 60,
  ...p,
});

test("sports: Garmin activity types map onto the owner's sports", () => {
  assert.equal(sportOf("TREADMILL_RUNNING"), "running");
  assert.equal(sportOf("trail_running"), "running");
  assert.equal(sportOf("lap_swimming"), "swimming");
  assert.equal(sportOf("road_biking"), "cycling");
  assert.equal(sportOf("strength_training"), "strength");
  assert.equal(sportOf("padel"), "team");
  assert.equal(sportOf("something_new"), "other");
  assert.equal(sportOf(null), "other");
  assert.equal(activityLabel("TREADMILL_RUNNING"), "Treadmill running");
  assert.equal(activityLabel(null), "Workout");
});

test("workouts: one row per session; freddy wins the days it has; totals and bests", async () => {
  const { db } = await migratedDb();
  const ex = (id: number, day: string, type: string, dur: number, dist: number | null): SampleInput[] => {
    const at = { startMs: midnight(day) + 8 * 3_600_000, endMs: midnight(day) + 9 * 3_600_000 };
    return [
      sample({ source: "garmin_export", externalId: `activity:${id}`, metric: "activity_activityType", valueText: type, ...at }, day),
      sample({ source: "garmin_export", externalId: `activity:${id}`, metric: "activity_durationInSeconds", valueNum: dur, ...at }, day),
      ...(dist === null ? [] : [sample({ source: "garmin_export", externalId: `activity:${id}`, metric: "activity_distanceInMeters", valueNum: dist, ...at }, day)]),
    ];
  };
  await upsertSamples(db, [
    ...ex(1, "2026-09-01", "running", 3000, 10000),
    ...ex(2, "2026-10-20", "running", 1800, 6000), // also in freddy: left out
    ...ex(3, "2026-10-10", "strength_training", 2700, null),
    // freddy: two sessions on 10-20, numbered per metric
    sample({ source: "freddy", externalId: "2026-10-20#0", metric: "activity_activityType", valueText: "RUNNING" }, "2026-10-20"),
    sample({ source: "freddy", externalId: "2026-10-20#0", metric: "activity_durationInSeconds", valueNum: 1810 }, "2026-10-20"),
    sample({ source: "freddy", externalId: "2026-10-20#0", metric: "activity_distanceInMeters", valueNum: 6020 }, "2026-10-20"),
    sample({ source: "freddy", externalId: "2026-10-20#1", metric: "activity_activityType", valueText: "WALKING" }, "2026-10-20"),
    sample({ source: "freddy", externalId: "2026-10-20#1", metric: "activity_durationInSeconds", valueNum: 1200 }, "2026-10-20"),
  ]);
  const ws = await listWorkouts(db, "2026-01-01", TODAY);
  assert.deepEqual(
    ws.map((w) => [w.day, w.source, w.sport]),
    [
      ["2026-10-20", "freddy", "walking"],
      ["2026-10-20", "freddy", "running"],
      ["2026-10-10", "garmin_export", "strength"],
      ["2026-09-01", "garmin_export", "running"],
    ],
  );
  assert.equal(ws.find((w) => w.source === "garmin_export" && w.sport === "running")!.startMs !== null, true, "the export has start times");
  assert.equal(ws.find((w) => w.source === "freddy")!.startMs, null, "freddy gives the day only");

  const totals = sportTotals(ws);
  assert.deepEqual(totals.map((t) => [t.sport, t.sessions, t.durationS, t.distanceM]), [
    ["running", 2, 4810, 16020],
    ["strength", 1, 2700, 0],
    ["walking", 1, 1200, 0],
  ]);
  const run = personalBests(ws).find((b) => b.sport === "running")!;
  assert.equal(run.longestDistance!.distanceM, 10000);
  assert.equal(personalBests(ws).find((b) => b.sport === "strength")!.longestDistance, null);
  assert.deepEqual([fmtDuration(50), fmtDuration(2520), fmtDuration(3900), fmtDistance(850), fmtDistance(10234)], ["50 s", "42 min", "1 h 05 min", "850 m", "10.2 km"]);
});

test("goal progress: day goals with last 7 days and streak", () => {
  const g = { comparator: ">=" as const, targetNum: 10000, period: "day" as const };
  const v = new Map([
    ["2026-10-26", 4000],
    ["2026-10-25", 12000],
    ["2026-10-24", 11000],
    ["2026-10-23", 9000],
    ["2026-10-22", 15000],
  ]);
  const p = evaluate(g, v, "sum", TODAY);
  assert.equal(p.status, "behind", "today is not over: not yet, not failed");
  assert.equal(p.current, 4000);
  assert.equal(p.fraction, 0.4);
  assert.deepEqual(p.last7, { met: 3, withData: 5 });
  assert.equal(p.streak, 2, "today not met yet: the streak runs to yesterday");
  v.set(TODAY, 10500);
  assert.equal(evaluate(g, v, "sum", TODAY).streak, 3);
  assert.equal(evaluate(g, v, "sum", TODAY).status, "met");

  const limit = evaluate({ comparator: "<=", targetNum: 2200, period: "day" }, new Map([[TODAY, 2500]]), "sum", TODAY);
  assert.equal(limit.status, "missed");
  assert.equal(limit.fraction, null, "a limit has no fill to reach");
  assert.equal(evaluate(g, new Map(), "sum", TODAY).status, "no_data");
  assert.equal(evaluate({ comparator: null, targetNum: null, period: "day" }, v, "sum", TODAY).status, "no_data");
});

test("goal progress: weeks and months sum amounts, average levels, take the last measurement", () => {
  assert.equal(periodStart("week", "2026-10-29"), "2026-10-26");
  assert.equal(periodStart("week", "2026-10-26"), "2026-10-26");
  assert.equal(periodStart("month", "2026-10-29"), "2026-10-01");
  const days = new Map([
    ["2026-10-25", 99], // last week: not counted
    ["2026-10-26", 30],
    ["2026-10-27", 25],
  ]);
  const weekLimit = { comparator: "<=" as const, targetNum: 70, period: "week" as const };
  assert.deepEqual([evaluate(weekLimit, days, "sum", "2026-10-27").current, evaluate(weekLimit, days, "sum", "2026-10-27").status], [55, "on_track"]);
  days.set("2026-10-28", 20);
  assert.equal(evaluate(weekLimit, days, "sum", "2026-10-28").status, "missed");
  assert.equal(evaluate({ ...weekLimit, comparator: ">=" }, days, "avg", "2026-10-28").current, 25);
  assert.equal(evaluate({ comparator: "<=", targetNum: 80, period: "week" }, days, "last", "2026-10-28").status, "met", "the latest measurement counts");
});

test("goals: added, listed with progress from each source, ended and deleted ones hidden", async () => {
  const { db } = await migratedDb();
  const steps = GOAL_TEMPLATES.find((t) => t.id === "steps")!;
  const protein = GOAL_TEMPLATES.find((t) => t.id === "protein")!;
  const alcohol = GOAL_TEMPLATES.find((t) => t.id === "alcohol")!;
  await insertGoal(db, steps.build(10000, "2026-10-01"), stamp);
  await insertGoal(db, protein.build(120, "2026-10-01"), stamp);
  await insertGoal(db, alcohol.build(70, "2026-10-01"), stamp);
  await insertGoal(db, { title: "Weigh 80 kg", targetKind: "manual", metric: "weight", comparator: "<=", targetNum: 80, unit: "kg", period: "week", startDay: "2026-10-01" }, stamp);
  await insertGoal(db, { title: "Run a half marathon", targetKind: "none", period: "day", startDay: "2026-10-01" }, stamp);
  await insertGoal(db, { title: "Old", targetKind: "none", period: "day", startDay: "2026-01-01", endDay: "2026-02-01" }, stamp);

  await upsertCatalog(db, "freddy", [{ metric: "daily_steps" }], 1);
  await db.run("UPDATE metric_catalog SET daily_agg = 'sum' WHERE metric = 'daily_steps'");
  await upsertSamples(db, [sample({ source: "freddy", device: "", externalId: `${TODAY}#0`, metric: "daily_steps", valueNum: 12000 }, TODAY)]);
  await logFood(db, { name: "Lunch", meal: "lunch", calories: 700, proteinG: 50, carbsG: null, fatG: null, atMs: midnight(TODAY) + 13 * 3_600_000, timeZone: TZ });
  await insertMeasurement(db, { measuredAtMs: midnight(TODAY) + 7 * 3_600_000, offsetMin: 60, kind: "weight", valueNum: 81.2, unit: "kg" }, stamp);

  const goals = await listGoals(db, TODAY);
  assert.deepEqual(goals.map((g) => g.title), ["10,000 steps a day", "120 g protein a day", "At most 70 g alcohol a week", "Weigh 80 kg", "Run a half marathon"]);
  const progress = await Promise.all(goals.map((g) => goalProgress(db, g, TODAY)));
  assert.deepEqual(progress.map((p) => p && [p.current, p.status]), [[12000, "met"], [50, "behind"], [null, "no_data"], [81.2, "behind"], null]);

  await deleteGoal(db, goals[0].id);
  assert.equal((await listGoals(db, TODAY)).length, 4);

  const tool = await TOOLS_BY_NAME.get("list_goals")!.run(db, {});
  const listed = (tool.result as { goals: { title: string; progress: { status: string } | null }[] }).goals;
  assert.ok(listed.some((g) => g.title === "Run a half marathon" && g.progress === null));
});

test("goal values read in the owner's units", () => {
  const g = (metric: string, unit: string) => ({ metric, unit }) as Pick<Goal, "metric" | "unit">;
  assert.equal(fmtGoalValue(g("sleep_durationInSeconds", "seconds"), 27000), "7 h 30 min");
  assert.equal(fmtGoalValue(g("body_weightInGrams", "grams"), 80500), "80.5 kg");
  assert.equal(fmtGoalValue(g("daily_steps", "steps"), 12000), "12,000 steps");
  assert.equal(fmtGoalValue(g("protein_g", "g"), 120), "120 g");
  assert.equal(fmtGoalValue(g("alcohol_g", "g"), 13.4), "13.4 g");
  const sleep = GOAL_TEMPLATES.find((t) => t.id === "sleep")!.build(7.5, TODAY);
  assert.deepEqual([sleep.metric, sleep.targetNum, sleep.unit, sleep.period], ["sleep_durationInSeconds", 27000, "seconds", "day"]);
  const weight = GOAL_TEMPLATES.find((t) => t.id === "weight")!.build(79.5, TODAY);
  assert.deepEqual([weight.metric, weight.comparator, weight.targetNum], ["body_weightInGrams", "<=", 79500]);
});

test("profile: sports are kept in order, the picture must be a small JPEG", async () => {
  const { db } = await migratedDb();
  await saveProfile(db, { heightCm: 178, sports: ["cycling", "running"] }, TODAY);
  assert.deepEqual((await loadProfile(db)).sports, ["cycling", "running"]);
  await assert.rejects(saveProfile(db, { sports: ["chess"] }, TODAY));
  const p = await loadProfile(db);
  assert.deepEqual((await saveProfile(db, { ...p, name: "Sam" }, TODAY)).sports, ["cycling", "running"], "editing the profile keeps the sports");

  assert.equal(await loadProfilePhoto(db), null);
  await saveProfilePhoto(db, "data:image/jpeg;base64,AAAA");
  assert.equal(await loadProfilePhoto(db), "data:image/jpeg;base64,AAAA");
  await assert.rejects(saveProfilePhoto(db, "data:image/png;base64,AAAA"), /JPEG/);
  await assert.rejects(saveProfilePhoto(db, `data:image/jpeg;base64,${"A".repeat(300_000)}`), /too large/);
  await saveProfilePhoto(db, null);
  assert.equal(await loadProfilePhoto(db), null);
});

test("workouts: the Garmin sync keeps start times and wins its days over freddy and the export", async () => {
  const { db } = await migratedDb();
  const day = "2026-10-24";
  const run = (source: string, externalId: string, h: number) => {
    const at = { startMs: midnight(day) + h * 3_600_000, endMs: midnight(day) + (h + 1) * 3_600_000 };
    return [
      sample({ source, externalId, metric: "activity_activityType", valueText: "running", ...at }, day),
      sample({ source, externalId, metric: "activity_durationInSeconds", valueNum: 1800, ...at }, day),
    ];
  };
  await upsertSamples(db, [
    ...run("garmin", "activity:777", 8),
    ...run("garmin", "activity:778", 18),
    ...run("garmin_export", "activity:777", 8), // the same session, from the export
    ...run("freddy", `${day}#0`, 0), // and from freddy
  ], 1);

  const ws = await listWorkouts(db, day, day);
  assert.deepEqual(ws.map((w) => [w.source, w.key.split("|")[1]]), [["garmin", "activity:778"], ["garmin", "activity:777"]], "latest first, each once");
  assert.equal(ws[1].startMs, midnight(day) + 8 * 3_600_000, "the sync has real start times");
});
