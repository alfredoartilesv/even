import test from "node:test";
import assert from "node:assert/strict";
import { parseListMetrics, parseQueryMetrics } from "../src/sources/freddyText";
import { LIST_METRICS, QUERY_METRICS } from "./fixtures";

test("parseListMetrics reads name, count, range, unit and device", () => {
  const list = parseListMetrics(LIST_METRICS);
  assert.deepEqual(
    list.map((m) => m.name),
    ["activity_distanceInMeters", "activityDetail_samples", "body_weightInGrams", "daily_steps", "epoch_steps", "sleep_durationInSeconds"],
  );
  const dist = list[0];
  assert.deepEqual(dist, {
    name: "activity_distanceInMeters",
    records: 9,
    from: "2026-09-27",
    to: "2026-10-17",
    unit: "meters",
    device: "Forerunner 245",
  });
  assert.equal(list.find((m) => m.name === "daily_steps")!.unit, undefined);
  assert.equal(list.find((m) => m.name === "epoch_steps")!.records, 3045);
});

test("parseQueryMetrics: timezone, numbers, units, labels", () => {
  const r = parseQueryMetrics(QUERY_METRICS);
  assert.equal(r.timeZone, "Europe/Madrid");
  const steps = r.samples.find((s) => s.metric === "daily_steps" && s.externalId === "2026-10-24#0")!;
  assert.equal(steps.valueNum, 10000);
  assert.equal(steps.unit, undefined);
  assert.equal(steps.device, "Garmin");
  assert.equal(steps.source, "freddy");
  const hr = r.samples.find((s) => s.metric === "daily_averageHeartRateInBeatsPerMinute")!;
  assert.equal(hr.valueNum, 90);
  assert.equal(hr.unit, "bpm");
});

test("day boundaries use local midnight, including the 25-hour DST day", () => {
  const r = parseQueryMetrics(QUERY_METRICS);
  const today = r.samples.find((s) => s.externalId === "2026-10-25#0")!;
  assert.equal(new Date(today.startMs).toISOString(), "2026-10-24T22:00:00.000Z");
  assert.equal(today.offsetMin, 120);
  assert.equal((today.endMs! - today.startMs) / 3_600_000, 25);
});

test("partial day is flagged only for that day", () => {
  const r = parseQueryMetrics(QUERY_METRICS);
  const partial = r.samples.filter((s) => (s.raw as { partial?: boolean } | undefined)?.partial);
  assert.deepEqual(partial.map((s) => s.externalId.slice(0, 10)), ["2026-10-25", "2026-10-25"]);
});

test("duplicate metric lines on one day get distinct external ids", () => {
  const r = parseQueryMetrics(QUERY_METRICS);
  const w = r.samples.filter((s) => s.metric === "body_weightInGrams");
  assert.deepEqual(w.map((s) => [s.externalId, s.valueNum]), [["2026-10-24#0", 87000], ["2026-10-24#1", 86500]]);
});

test("text values and unrecognised shapes are kept, not guessed", () => {
  const r = parseQueryMetrics(QUERY_METRICS);
  const q = r.samples.find((s) => s.metric === "daily_stressQualifier")!;
  assert.equal(q.valueText, "very stressful");
  assert.equal(q.valueNum, undefined);
  const weird = r.samples.find((s) => s.metric === "weird_metric")!;
  assert.equal(weird.valueNum, undefined);
  assert.equal(weird.valueText, "5 bpm at 07:30+01:00");
  assert.deepEqual(r.skipped, ["this line has no colon structure"]);
});

test("notes are captured", () => {
  const r = parseQueryMetrics(QUERY_METRICS);
  assert.equal(r.notes.length, 1);
  assert.match(r.notes[0], /limited to the available window/);
});

test("empty or unrelated text yields nothing", () => {
  const r = parseQueryMetrics("No data found.");
  assert.deepEqual(r.samples, []);
  assert.deepEqual(parseListMetrics("nothing here"), []);
});
