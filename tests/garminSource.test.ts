import test from "node:test";
import assert from "node:assert/strict";
import { strToU8, zipSync } from "fflate";
import { GARMIN_SOURCE, GarminApi, GarminApiError, GarminSource, parseTokenReply } from "../src/features/sync/garmin";
import { GARMIN_EXPORT_SOURCE } from "../src/features/import/garmin";
import { importGarminZip } from "../src/features/import/garminImport";
import { dailySeries, dayValues } from "../src/features/metrics/queries";
import { loadCursor, upsertSamples } from "../src/features/metrics/samples";
import { runSync } from "../src/features/sync/runSync";
import { migratedDb } from "./helpers";

// Responses in the shapes of Garmin's Personal API OpenAPI document (read 26 Oct 2026). Values are invented.
// 25 Oct 2026, 20:00 in Madrid (18:00 UTC).
const NOW = Date.UTC(2026, 9, 25, 18, 0, 0);
const KEY = "test-personal-api-key-0123456789";
const TOKEN = "eyJhbGciOiJIUzI1NiJ9.test-token.signature";

const daily = (day: string, prev: string, over: Record<string, unknown> = {}) => ({
  calendarDate: day,
  includesWellnessData: true,
  wellnessChronology: { startTimestampGmt: `${prev}T22:00:00.0`, startTimestampLocal: `${day}T00:00:00.0` },
  movement: { steps: { goal: 8000, value: 9000, distanceInMeters: 7000 } },
  calories: { burnedResting: 1900, burnedActive: 600, burnedTotal: 2500 },
  heartRate: { minValue: 48, maxValue: 160, restingValue: 49 },
  intensityMinutes: { goal: 150, moderate: 20, vigorous: 10 },
  stress: {
    avgLevel: 30,
    maxLevel: 90,
    restDurationInMillis: 30_000_000,
    lowStressDurationInMillis: 10_000_000,
    mediumStressDurationInMillis: 6_000_000,
    highStressDurationInMillis: 4_000_000,
  },
  bodyBattery: { minValue: 20, maxValue: 85, chargedValue: 60, drainedValue: 55 },
  pulseOx: { avgValue: 95, minValue: 88 },
  ...over,
});

const ACTIVITY = {
  activityId: 777,
  activityName: "Morning Run in Some Park",
  locationName: "Some City",
  startLatitude: 40.4,
  startTimeLocal: "2026-10-24 08:00:00",
  startTimeGMT: "2026-10-24 06:00:00",
  beginTimestamp: Date.UTC(2026, 9, 24, 6, 0),
  activityType: { typeId: 1, typeKey: "running", parentTypeId: 17 },
  distance: 6000, // metres
  duration: 1800, // seconds
  movingDuration: 1750,
  elevationGain: 45,
  calories: 420,
  averageHR: 150,
  maxHR: 175,
  steps: 5200,
  aerobicTrainingEffect: 3.2,
  anaerobicTrainingEffect: 1.1,
  vO2MaxValue: 51,
};

type Route = (url: URL) => { status?: number; body: unknown } | undefined;

interface Fake {
  fetch: typeof fetch;
  calls: Array<{ method: string; url: URL; auth: string | null }>;
}

function fakeGarmin(over: { token?: { status?: number; body: unknown }; routes?: Route; activities?: unknown[] } = {}): Fake {
  const calls: Fake["calls"] = [];
  const doFetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const auth = new Headers(init?.headers).get("authorization");
    calls.push({ method: init?.method ?? "GET", url, auth });
    const reply = (status: number, body: unknown) => new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
    if (url.pathname.endsWith("/personal-api-key/token")) {
      if (auth !== `ApiKey ${KEY}`) return reply(401, { error: "bad key" });
      // As the real endpoint: a JSON Accept header is refused, the token is plain text.
      if (new Headers(init?.headers).get("accept") === "application/json") return reply(406, "");
      const t = over.token ?? { body: TOKEN };
      return reply(t.status ?? 200, t.body);
    }
    if (auth !== `Bearer ${TOKEN}`) return reply(401, "");
    const custom = over.routes?.(url);
    if (custom) return reply(custom.status ?? 200, custom.body);
    const q = url.searchParams;
    switch (true) {
      case url.pathname === "/userprofile-service/userprofile/settings":
        return reply(200, { displayName: "x", timeZone: "Europe/Madrid" });
      case url.pathname === "/usersummary-service/v2/dailysummaries":
        return reply(200, {
          data:
            q.get("startDate")! <= "2026-10-24" && q.get("endDate")! >= "2026-10-24" ? [daily("2026-10-24", "2026-10-23"), { calendarDate: "not a day" }] : [],
        });
      case url.pathname === "/sleep-service/sleep/dailySleepSummariesByDate":
        return reply(200, [
          {
            calendarDate: "2026-10-24",
            sleepTimeSeconds: 25800,
            deepSleepSeconds: 5400,
            lightSleepSeconds: 14400,
            remSleepSeconds: 6000,
            awakeSleepSeconds: 900,
            averageSpO2Value: 94,
            averageSpO2HRSleep: 50,
            averageRespirationValue: 13,
            sleepScores: { overall: { value: 82, qualifierKey: "GOOD" } },
          },
        ]);
      case url.pathname.startsWith("/hrv-service/hrv/daily/"):
        return reply(200, { hrvSummaries: [{ calendarDate: "2026-10-24", weeklyAvg: 55, lastNightAvg: 58, lastNight5MinHigh: 80, status: "BALANCED" }] });
      case url.pathname.startsWith("/weight-service/weight/all/"):
        return reply(400, ""); // as the real endpoint
      case url.pathname.startsWith("/weight-service/weight/range/"): {
        // Grams in practice, though documented as kilograms.
        const at = (h: number, w: number, pk: number, sourceType = "MANUAL") => ({
          samplePk: pk,
          calendarDate: "2026-10-24",
          weight: w,
          sourceType,
          timestampGMT: Date.UTC(2026, 9, 24, h, 30),
          date: Date.UTC(2026, 9, 24, h + 2, 30),
        });
        const all = [at(5, 80_100, 11), at(19, 80_500, 12), at(20, 82_000, 13, "USER_SETTING")];
        return reply(200, {
          dailyWeightSummaries:
            q.get("includeAll") === "true" && url.pathname.endsWith("/2026-10-25")
              ? [{ summaryDate: "2026-10-24", numOfWeightEntries: 3, latestWeight: all[1], allWeightMetrics: all }]
              : [],
          totalAverage: { weight: 80_300 },
        });
      }
      case url.pathname === "/activitylist-service/activities/search/activities": {
        const all = over.activities ?? [ACTIVITY];
        const start = Number(q.get("start") ?? 0);
        return reply(200, all.slice(start, start + Number(q.get("limit") ?? 99)));
      }
    }
    return reply(404, "");
  };
  return { fetch: doFetch, calls };
}

const source = (f: Fake, over: Partial<ConstructorParameters<typeof GarminSource>[0]> = {}) =>
  new GarminSource({ api: new GarminApi({ apiKey: KEY, fetch: f.fetch, now: () => NOW }), now: () => NOW, ...over });

// ---- Token ----

test("token reply: the documented-in-practice shapes are read, junk is not", () => {
  assert.deepEqual(parseTokenReply(JSON.stringify({ access_token: "a".repeat(30), expires_in: 3600 }), 0), { token: "a".repeat(30), expiresAtMs: 3_600_000 });
  assert.equal(parseTokenReply(JSON.stringify({ accessToken: "b".repeat(30) }), 0)!.token, "b".repeat(30));
  assert.equal(parseTokenReply(JSON.stringify({ token: "c".repeat(30), expiresAt: 1_800_000_000 }), 0)!.expiresAtMs, 1_800_000_000_000, "seconds since epoch");
  assert.equal(parseTokenReply(TOKEN, 0)!.token, TOKEN, "a bare token body");
  assert.equal(parseTokenReply(JSON.stringify(TOKEN), 0)!.token, TOKEN, "a JSON string body");
  assert.equal(parseTokenReply("{}", 0), null);
  assert.equal(parseTokenReply("<html>oops</html>", 0), null);
});

test("the key is sent as ApiKey to the token endpoint, data calls use the token, and the token is reused", async () => {
  const f = fakeGarmin();
  const api = new GarminApi({ apiKey: KEY, fetch: f.fetch, now: () => NOW });
  await api.get("/userprofile-service/userprofile/settings");
  await api.get("/userprofile-service/userprofile/settings");
  const tokenCalls = f.calls.filter((c) => c.url.pathname.endsWith("/token"));
  assert.equal(tokenCalls.length, 1);
  assert.equal(tokenCalls[0].method, "POST");
  assert.equal(tokenCalls[0].url.origin, "https://personal.connectapi.garmin.com");
  assert.ok(f.calls.filter((c) => !c.url.pathname.endsWith("/token")).every((c) => c.auth === `Bearer ${TOKEN}`));
});

test("an expired token is replaced before the call", async () => {
  let now = NOW;
  const f = fakeGarmin({ token: { body: { access_token: TOKEN, expires_in: 600 } } });
  const api = new GarminApi({ apiKey: KEY, fetch: f.fetch, now: () => now });
  await api.get("/userprofile-service/userprofile/settings");
  now += 6 * 60_000; // inside the 5-minute margin of a 10-minute token
  await api.get("/userprofile-service/userprofile/settings");
  assert.equal(f.calls.filter((c) => c.url.pathname.endsWith("/token")).length, 2);
});

test("a 401 on a data call gets a new token once, then gives up", async () => {
  let rejects = 1;
  const f = fakeGarmin({ routes: (u) => (u.pathname.includes("settings") && rejects-- > 0 ? { status: 401, body: "" } : undefined) });
  const api = new GarminApi({ apiKey: KEY, fetch: f.fetch, now: () => NOW });
  assert.ok(await api.get("/userprofile-service/userprofile/settings"));
  assert.equal(f.calls.filter((c) => c.url.pathname.endsWith("/token")).length, 2);

  const always = fakeGarmin({ routes: (u) => (u.pathname.includes("settings") ? { status: 401, body: "" } : undefined) });
  await assert.rejects(
    new GarminApi({ apiKey: KEY, fetch: always.fetch }).get("/userprofile-service/userprofile/settings"),
    (e: GarminApiError) => e.status === 401,
  );
});

test("a rejected key gives a clear error that never contains the key", async () => {
  const f = fakeGarmin();
  const api = new GarminApi({ apiKey: "wrong-key-wrong-key-wrong", fetch: f.fetch });
  await assert.rejects(api.get("/userprofile-service/userprofile/settings"), (e: Error) => {
    assert.match(e.message, /rejected the personal API key \(HTTP 401\)/);
    assert.ok(!e.message.includes("wrong-key"));
    return true;
  });
});

test("network failures and non-JSON replies are GarminApiErrors without the URL", async () => {
  const down = new GarminApi({
    apiKey: KEY,
    fetch: async () => {
      throw new TypeError("fetch failed");
    },
  });
  await assert.rejects(
    down.get("/x-service/y"),
    (e: Error) => e instanceof GarminApiError && /Could not reach Garmin/.test(e.message) && !e.message.includes("connectapi"),
  );
  const html = fakeGarmin({ routes: () => ({ body: "<html></html>" }) });
  await assert.rejects(new GarminApi({ apiKey: KEY, fetch: html.fetch }).get("/x-service/y"), /not JSON/);
});

// ---- Mapping ----

test("a sync maps every endpoint to the metric names the export import uses", async () => {
  const f = fakeGarmin();
  const res = await source(f).fetchSince(null);
  const get = (metric: string, ext = "2026-10-24#0") => res.samples.find((s) => s.metric === metric && s.externalId === ext);

  assert.ok(res.samples.every((s) => s.source === GARMIN_SOURCE && s.device === "Garmin"));
  const steps = get("daily_steps")!;
  assert.equal(steps.valueNum, 9000);
  assert.equal(steps.startMs, Date.UTC(2026, 9, 23, 22, 0), "local midnight from the wellness chronology");
  assert.equal(steps.offsetMin, 120);
  assert.equal(get("daily_distanceInMeters")!.valueNum, 7000);
  assert.equal(get("daily_totalKilocalories")!.valueNum, 2500);
  assert.equal(get("daily_activeKilocalories")!.valueNum, 600);
  assert.equal(get("daily_bmrKilocalories")!.valueNum, 1900);
  assert.equal(get("daily_restingHeartRateInBeatsPerMinute")!.valueNum, 49);
  assert.equal(get("daily_moderateIntensityDurationInSeconds")!.valueNum, 1200, "minutes to seconds");
  assert.equal(get("daily_vigorousIntensityDurationInSeconds")!.valueNum, 600);
  assert.equal(get("daily_averageStressLevel")!.valueNum, 30);
  assert.equal(get("daily_stressDurationInSeconds")!.valueNum, 20_000, "low + medium + high, ms to s");
  assert.equal(get("daily_restStressDurationInSeconds")!.valueNum, 30_000);
  assert.equal(get("dailyBodyBattery_highestValue")!.valueNum, 85);
  assert.equal(get("dailyBodyBattery_lowestValue")!.valueNum, 20);
  assert.equal(get("pulseOx_avgSpo2InPercent")!.valueNum, 95);

  assert.equal(get("sleep_durationInSeconds")!.valueNum, 25800);
  assert.equal(get("sleep_deepSleepDurationInSeconds")!.valueNum, 5400);
  assert.equal(get("sleep_remSleepInSeconds")!.valueNum, 6000);
  assert.equal(get("sleep_averageSpO2")!.valueNum, 94);
  assert.equal(get("sleep_overallSleepScore")!.valueNum, 82);
  assert.equal(get("sleep_durationInSeconds")!.offsetMin, 120, "sleep reuses the day's offset");

  assert.equal(get("hrv_lastNightAvg")!.valueNum, 58);
  assert.equal(get("hrv_weeklyAvg")!.unit, "ms");

  const w = res.samples.filter((s) => s.metric === "body_weightInGrams");
  assert.deepEqual(
    w.map((s) => [s.valueNum, s.externalId]),
    [
      [80_100, "weight:11"],
      [80_500, "weight:12"],
    ],
    "every weigh-in, not the profile weight",
  );
  assert.equal(w[0].startMs, Date.UTC(2026, 9, 24, 5, 30));
  assert.equal(get("sleep_averageHeartRateInBeatsPerMinute")!.valueNum, 50, "from averageSpO2HRSleep when avgHeartRate is missing");

  const ext = "activity:777";
  assert.equal(res.samples.find((s) => s.externalId === ext && s.metric === "activity_activityType")!.valueText, "running");
  const dist = res.samples.find((s) => s.externalId === ext && s.metric === "activity_distanceInMeters")!;
  assert.equal(dist.valueNum, 6000, "metres, not the export's centimetres");
  assert.equal(dist.startMs, Date.UTC(2026, 9, 24, 6, 0));
  assert.equal(dist.endMs, Date.UTC(2026, 9, 24, 6, 30));
  assert.equal(dist.offsetMin, 120);
  assert.equal(res.samples.find((s) => s.externalId === ext && s.metric === "activity_durationInSeconds")!.valueNum, 1800);
  assert.equal(res.samples.find((s) => s.externalId === ext && s.metric === "activity_averageHeartRateInBeatsPerMinute")!.valueNum, 150);

  // Privacy: names, places and coordinates are not stored.
  assert.ok(!JSON.stringify(res.samples).includes("Some Park"));
  assert.ok(!JSON.stringify(res.samples).includes("Some City"));
  assert.ok(res.samples.every((s) => s.raw === undefined));

  assert.ok(res.catalog!.some((c) => c.metric === "daily_steps" && c.firstDay === "2026-10-24"));
  assert.deepEqual(res.warnings, []);
});

test("first sync reads 30 days in 28-day chunks, later syncs start at the cursor", async () => {
  const f = fakeGarmin();
  const res = await source(f).fetchSince(null);
  const ranges = f.calls
    .filter((c) => c.url.pathname === "/usersummary-service/v2/dailysummaries")
    .map((c) => [c.url.searchParams.get("startDate"), c.url.searchParams.get("endDate")]);
  assert.deepEqual(ranges, [
    ["2026-09-26", "2026-10-23"],
    ["2026-10-24", "2026-10-25"],
  ]);
  assert.ok(f.calls.some((c) => c.url.pathname === "/hrv-service/hrv/daily/2026-09-26/2026-10-23"));
  assert.equal(res.nextCursor, "2026-10-24", "yesterday is read again next time");

  const later = fakeGarmin();
  await source(later).fetchSince("2026-10-24");
  assert.deepEqual(
    later.calls.filter((c) => c.url.pathname === "/usersummary-service/v2/dailysummaries").map((c) => c.url.searchParams.get("startDate")),
    ["2026-10-24"],
  );
});

test("activities are paged until a short page", async () => {
  const many = Array.from({ length: 120 }, (_, i) => ({ ...ACTIVITY, activityId: 1000 + i }));
  const f = fakeGarmin({ activities: many });
  const res = await source(f).fetchSince("2026-10-24");
  const pages = f.calls.filter((c) => c.url.pathname.includes("/activities/search/")).map((c) => c.url.searchParams.get("start"));
  assert.deepEqual(pages, ["0", "99"]);
  assert.equal(new Set(res.samples.filter((s) => s.metric === "activity_activityType").map((s) => s.externalId)).size, 120);
});

test("an endpoint the key may not read becomes a warning, other failures stop the sync", async () => {
  const forbidden = fakeGarmin({ routes: (u) => (u.pathname.startsWith("/hrv-service") ? { status: 403, body: "" } : undefined) });
  const res = await source(forbidden).fetchSince("2026-10-24");
  assert.ok(res.samples.some((s) => s.metric === "daily_steps"));
  assert.deepEqual(res.warnings, ["HRV: not available (HTTP 403)"]);

  const broken = fakeGarmin({ routes: (u) => (u.pathname.startsWith("/sleep-service") ? { status: 500, body: "" } : undefined) });
  await assert.rejects(source(broken).fetchSince("2026-10-24"), /HTTP 500/);
});

test("the account timezone comes from the profile settings", async () => {
  const f = fakeGarmin({ routes: (u) => (u.pathname.includes("settings") ? { body: { timeZone: "Pacific/Kiritimati" } } : undefined) });
  await source(f).fetchSince(null);
  // UTC+14: 18:00 UTC on 25 Oct is already 26 Oct there.
  const last = f.calls.filter((c) => c.url.pathname === "/usersummary-service/v2/dailysummaries").at(-1)!;
  assert.equal(last.url.searchParams.get("endDate"), "2026-10-26");
});

test("missing or impossible values are skipped, not stored as zero", async () => {
  const f = fakeGarmin({
    routes: (u) =>
      u.pathname === "/usersummary-service/v2/dailysummaries"
        ? {
            body: {
              data: [daily("2026-10-24", "2026-10-23", { movement: { steps: { value: null } }, heartRate: { restingValue: -1 }, stress: { avgLevel: -2 } })],
            },
          }
        : undefined,
  });
  const res = await source(f).fetchSince("2026-10-24");
  for (const m of ["daily_steps", "daily_restingHeartRateInBeatsPerMinute", "daily_averageStressLevel"]) {
    assert.equal(
      res.samples.find((s) => s.metric === m),
      undefined,
      m,
    );
  }
});

// ---- Integration: sync into the real schema ----

test("runSync stores a Garmin sync, moves the cursor, and a re-sync adds nothing", async () => {
  const { db } = await migratedDb();
  const out = await runSync(db, source(fakeGarmin()), () => NOW);
  assert.equal(out.status, "ok");
  assert.ok(out.samplesWritten > 30);
  assert.equal(await loadCursor(db, GARMIN_SOURCE), "2026-10-24");
  const count = async () => (await db.all<{ n: number }>("SELECT COUNT(*) AS n FROM health_samples"))[0].n;
  const before = await count();
  await runSync(db, source(fakeGarmin()), () => NOW + 60_000);
  assert.equal(await count(), before, "same ids, refreshed in place");

  const day = await dayValues(db, "2026-10-24");
  assert.equal(day.find((v) => v.metric === "daily_steps")!.value, 9000);
  assert.ok((await db.all("SELECT 1 FROM metric_catalog WHERE source = 'garmin' AND metric = 'hrv_lastNightAvg'")).length === 1);
});

test("a failed Garmin sync keeps the cursor and logs the error without the key", async () => {
  const { db } = await migratedDb();
  const bad = new GarminSource({ api: new GarminApi({ apiKey: "wrong-key-wrong-key-wrong", fetch: fakeGarmin().fetch }), now: () => NOW });
  const out = await runSync(db, bad, () => NOW);
  assert.equal(out.status, "error");
  assert.equal(await loadCursor(db, GARMIN_SOURCE), null);
  const [run] = await db.all<{ error: string }>("SELECT error FROM sync_runs WHERE source = 'garmin'");
  assert.match(run.error, /rejected the personal API key/);
  assert.ok(!run.error.includes("wrong-key"));
});

// ---- Integration: the export import and the API never count the same reading twice ----

/** A Garmin export with the same day and the same run the API has (export units: cm, ms). */
function exportZip() {
  const json = (o: unknown) => strToU8(JSON.stringify(o));
  return zipSync({
    "DI_CONNECT/DI-Connect-Aggregator/UDSFile_2026-10-01_2026-12-31.json": json([
      { calendarDate: "2026-10-23", totalSteps: 7000, wellnessStartTimeGmt: "2026-10-22T22:00:00.0", wellnessStartTimeLocal: "2026-10-23T00:00:00.0" },
      {
        calendarDate: "2026-10-24",
        totalSteps: 9000,
        totalKilocalories: 2500,
        wellnessStartTimeGmt: "2026-10-23T22:00:00.0",
        wellnessStartTimeLocal: "2026-10-24T00:00:00.0",
      },
    ]),
    "DI_CONNECT/DI-Connect-Wellness/1_userBioMetrics.json": json([
      { metaData: { calendarDate: "2026-10-24", sequence: 1 }, weight: { weight: 80100, sourceType: "MANUAL" } },
    ]),
    "DI_CONNECT/DI-Connect-Fitness/x_summarizedActivities.json": json([
      {
        summarizedActivitiesExport: [
          {
            activityId: 777,
            activityType: "running",
            startTimeGmt: Date.UTC(2026, 9, 24, 6, 0),
            startTimeLocal: Date.UTC(2026, 9, 24, 8, 0),
            duration: 1_800_000,
            distance: 600_000,
            calories: 1757,
            avgHr: 150,
          },
        ],
      },
    ]),
  });
}

const metricRows = async (db: Awaited<ReturnType<typeof migratedDb>>["db"], metric: string, day: string) =>
  (await db.all<{ source: string }>("SELECT source FROM daily_metric_values WHERE metric = ? AND local_day = ? ORDER BY source", [metric, day])).map(
    (r) => r.source,
  );

for (const order of ["import first, then sync", "sync first, then import"] as const) {
  test(`export and API overlap (${order}): each metric and day is shown once, from the API`, async () => {
    const { db } = await migratedDb();
    const doImport = () => importGarminZip(db, exportZip(), { timeZone: "Europe/Madrid", nowMs: 1_000 });
    const doSync = () => runSync(db, source(fakeGarmin()), () => NOW);
    if (order === "import first, then sync") {
      await doImport();
      await doSync();
    } else {
      await doSync();
      await doImport();
    }

    for (const metric of [
      "daily_steps",
      "daily_totalKilocalories",
      "body_weightInGrams",
      "activity_distanceInMeters",
      "activity_durationInSeconds",
      "activity_activeKilocalories",
    ]) {
      assert.deepEqual(await metricRows(db, metric, "2026-10-24"), [GARMIN_SOURCE], metric);
    }
    const day = await dayValues(db, "2026-10-24");
    assert.equal(day.filter((v) => v.metric === "daily_steps").length, 1);
    assert.equal(day.find((v) => v.metric === "activity_distanceInMeters")!.value, 6000, "one run of 6 km, not two");

    // A day only the export has still comes from the export.
    assert.deepEqual(await metricRows(db, "daily_steps", "2026-10-23"), [GARMIN_EXPORT_SOURCE]);
    const series = await dailySeries(db, "daily_steps", "2026-10-23", "2026-10-24");
    assert.deepEqual(
      series.map((s) => [s.source, s.points.map((p) => p.day)]),
      [
        [GARMIN_SOURCE, ["2026-10-24"]],
        [GARMIN_EXPORT_SOURCE, ["2026-10-23"]],
      ],
    );

    // Nothing is deleted: both copies stay in the table (and in backups).
    const kept = await db.all<{ n: number }>("SELECT COUNT(*) AS n FROM health_samples WHERE metric = 'daily_steps' AND local_day = '2026-10-24'");
    assert.equal(kept[0].n, 2);
  });
}

test("freddy rows from before the switch give way to the API, and still beat the export", async () => {
  const { db } = await migratedDb();
  const day = Date.UTC(2026, 9, 23, 22, 0);
  const at = { startMs: day, endMs: day + 86_400_000, offsetMin: 120 };
  await upsertSamples(
    db,
    [
      { source: "freddy", device: "", externalId: "2026-10-24#0", metric: "daily_steps", ...at, valueNum: 9000 },
      { source: "freddy", device: "", externalId: "2026-10-23#0", metric: "daily_steps", ...at, startMs: day - 86_400_000, valueNum: 7000 },
    ],
    1,
  );
  await importGarminZip(db, exportZip(), { timeZone: "Europe/Madrid", nowMs: 2 });
  await runSync(db, source(fakeGarmin()), () => NOW);

  assert.deepEqual(await metricRows(db, "daily_steps", "2026-10-24"), [GARMIN_SOURCE], "API over freddy");
  assert.deepEqual(await metricRows(db, "daily_steps", "2026-10-23"), ["freddy"], "freddy over the export where the API has nothing");
});
