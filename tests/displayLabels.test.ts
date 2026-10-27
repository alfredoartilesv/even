import assert from "node:assert/strict";
import test from "node:test";
import Anthropic from "@anthropic-ai/sdk";
import { displayCategory, metricLabel, metricValue } from "../src/features/metrics/display";
import { fmtPace } from "../src/features/me/workouts";
import { ChatApiError, startConversation, toChatError } from "../src/features/chat/engine";
import { recordConsent } from "../src/features/chat/consent";
import { listConversations } from "../src/features/chat/store";
import { migratedDb } from "./helpers";

/** Day metrics the Garmin API sync and the export import write (see src/features/import/garmin.ts). */
const GARMIN_METRICS = [
  "daily_steps",
  "daily_distanceInMeters",
  "daily_totalKilocalories",
  "daily_activeKilocalories",
  "daily_bmrKilocalories",
  "daily_restingHeartRateInBeatsPerMinute",
  "daily_minHeartRateInBeatsPerMinute",
  "daily_maxHeartRateInBeatsPerMinute",
  "daily_moderateIntensityDurationInSeconds",
  "daily_vigorousIntensityDurationInSeconds",
  "daily_activeDurationInSeconds",
  "daily_highlyActiveDurationInSeconds",
  "daily_averageStressLevel",
  "daily_maxStressLevel",
  "daily_stressDurationInSeconds",
  "daily_restStressDurationInSeconds",
  "dailyBodyBattery_highestValue",
  "dailyBodyBattery_lowestValue",
  "dailyBodyBattery_chargedValue",
  "dailyBodyBattery_drainedValue",
  "pulseOx_averageSpO2",
  "pulseOx_lowestSpO2",
  "respiration_avgWakingBreathsPerMinute",
  "sleep_durationInSeconds",
  "sleep_deepDurationInSeconds",
  "sleep_lightDurationInSeconds",
  "sleep_remDurationInSeconds",
  "sleep_awakeDurationInSeconds",
  "sleep_averageSpO2",
  "sleep_averageHeartRateInBeatsPerMinute",
  "sleep_averageRespiration",
  "body_weightInGrams",
  "userMetrics_vo2Max",
  "userMetrics_vo2MaxRunning",
  "userMetrics_vo2MaxWalking",
  "userMetrics_fitnessAge",
];

test("synced metric names read as plain English with usable units", () => {
  assert.equal(metricLabel("daily_bmrKilocalories"), "Resting calories (BMR)");
  assert.equal(metricLabel("daily_moderateIntensityDurationInSeconds"), "Moderate activity");
  assert.equal(metricLabel("body_weightInGrams"), "Weight");
  assert.equal(metricLabel("daily_someNewThingInSeconds"), "Some new thing");
  assert.equal(metricValue("body_weightInGrams", 85200, null), (85.2).toLocaleString(undefined, { maximumFractionDigits: 1 }) + " kg");
  assert.equal(metricValue("daily_vigorousIntensityDurationInSeconds", 3900, null), "1 h 05 min");
  assert.equal(metricValue("daily_restingHeartRateInBeatsPerMinute", 52, null), "52 bpm");
});

test("every name the Garmin sync and export write reads clearly, and nothing falls back to a raw name", () => {
  assert.equal(metricLabel("dailyBodyBattery_highestValue"), "Body Battery high");
  assert.equal(metricLabel("pulseOx_averageSpO2"), "Average blood oxygen");
  assert.equal(metricValue("pulseOx_averageSpO2", 95, null), (95).toLocaleString(undefined, { maximumFractionDigits: 1 }) + " %");
  assert.equal(metricLabel("sleep_remDurationInSeconds"), "REM sleep");
  assert.equal(metricLabel("daily_activeDurationInSeconds"), "Active time");
  assert.equal(metricValue("respiration_avgWakingBreathsPerMinute", 14, null), "14 breaths/min");
  assert.equal(metricLabel("userMetrics_vo2MaxRunning"), "VO2 max (running)");
  assert.equal(metricLabel("someNewGarminMetricWithAVeryLongName"), "Some new garmin metric with a very long name");
  for (const m of GARMIN_METRICS) assert.doesNotMatch(metricLabel(m), /_|[a-z][A-Z]|In(Seconds|Meters|Grams)/, m);
});

test("rows without a catalog entry group by the name-based category, not all under Other", () => {
  assert.equal(displayCategory("dailyBodyBattery_highestValue", "other"), "recovery");
  assert.equal(displayCategory("sleep_deepDurationInSeconds", "other"), "sleep");
  assert.equal(displayCategory("daily_averageStressLevel", "other"), "stress");
  assert.equal(displayCategory("daily_steps", "body"), "body", "a catalog category is kept");
});

test("a failed first question carries its conversation, so a new chat can Try again", async () => {
  const { db } = await migratedDb();
  await recordConsent(db, "claude.aggregates", true, "dev");
  const billing = new Anthropic.BadRequestError(
    400,
    { type: "error", error: { type: "invalid_request_error", message: "Your credit balance is too low to access the Anthropic API." } },
    "x",
    new Headers(),
  );
  const err = await startConversation({ db, deviceId: "dev", create: async () => Promise.reject(billing) }, "How did I sleep?").catch((e) => e);
  assert.ok(err instanceof ChatApiError);
  assert.equal(err.kind, "billing");
  assert.ok(err.conversationId, "the screen gets the id to retry with");
  const [conv] = await listConversations(db);
  assert.equal(err.conversationId, conv.id);
});

test("pace per km", () => {
  assert.equal(fmtPace(39 * 60, 5600), "6:58 /km");
  assert.equal(fmtPace(600, null), null);
});

test("an out-of-credits 400 becomes a billing error with a plain message and the API detail kept apart", () => {
  const body = {
    type: "error",
    error: {
      type: "invalid_request_error",
      message: "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.",
    },
  };
  const e = toChatError(new Anthropic.BadRequestError(400, body, "x", new Headers({ "request-id": "req_123" })));
  assert.equal(e.kind, "billing");
  assert.doesNotMatch(e.message, /\{|invalid_request_error/);
  assert.match(e.detail ?? "", /credit balance is too low/);
});
