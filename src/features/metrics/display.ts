import { classifyMetric, type MetricCategory } from "./catalog";

/**
 * How a synced metric reads on screen: a plain-English label and a value in a unit people use
 * ("85.2 kg", not "85200 InGrams"). Pure. Only for display; the stored numbers never change.
 */

const PREFIX = /^(daily|body|sleep|activity|stress|dailyBodyBattery|pulseOx|userMetrics|wellness|hrv|respiration)_/;

/** Names that read badly when only split into words. Keys are the metric without its prefix. */
const NAMES: Record<string, string> = {
  steps: "Steps",
  activeKilocalories: "Active calories",
  bmrKilocalories: "Resting calories (BMR)",
  totalKilocalories: "Total calories burned",
  distanceInMeters: "Distance",
  moderateIntensityDurationInSeconds: "Moderate activity",
  vigorousIntensityDurationInSeconds: "Vigorous activity",
  activeTimeInSeconds: "Active time",
  floorsClimbed: "Floors climbed",
  weightInGrams: "Weight",
  bodyFatInPercent: "Body fat",
  bodyMassIndex: "BMI",
  maxHeartRateInBeatsPerMinute: "Max heart rate",
  minHeartRateInBeatsPerMinute: "Min heart rate",
  restingHeartRateInBeatsPerMinute: "Resting heart rate",
  averageHeartRateInBeatsPerMinute: "Average heart rate",
  averageStressLevel: "Average stress",
  maxStressLevel: "Peak stress",
  stressDurationInSeconds: "Time stressed",
  restStressDurationInSeconds: "Time at rest",
  durationInSeconds: "Duration",
  deepSleepDurationInSeconds: "Deep sleep",
  lightSleepDurationInSeconds: "Light sleep",
  remSleepInSeconds: "REM sleep",
  awakeDurationInSeconds: "Awake",
  overallSleepScore: "Sleep score",
  bodyBatteryChargedValue: "Body Battery charged",
  bodyBatteryDrainedValue: "Body Battery drained",
  bodyBatteryHighestValue: "Body Battery high",
  bodyBatteryLowestValue: "Body Battery low",
  averageSpo2InPercent: "Average blood oxygen",
  minSpo2InPercent: "Lowest blood oxygen",
  lastNightAvg: "Overnight HRV",
  vo2Max: "VO2 max",
};

/**
 * Full metric names whose prefix carries the meaning ("dailyBodyBattery_highestValue" is not just
 * "Highest value"), as written by the Garmin API sync and the Garmin export import.
 */
const FULL_NAMES: Record<string, string> = {
  dailyBodyBattery_highestValue: "Body Battery high",
  dailyBodyBattery_lowestValue: "Body Battery low",
  dailyBodyBattery_chargedValue: "Body Battery charged",
  dailyBodyBattery_drainedValue: "Body Battery drained",
  pulseOx_averageSpO2: "Average blood oxygen",
  pulseOx_lowestSpO2: "Lowest blood oxygen",
  sleep_durationInSeconds: "Total sleep",
  sleep_deepDurationInSeconds: "Deep sleep",
  sleep_lightDurationInSeconds: "Light sleep",
  sleep_remDurationInSeconds: "REM sleep",
  sleep_awakeDurationInSeconds: "Awake during sleep",
  sleep_averageSpO2: "Blood oxygen asleep",
  sleep_averageHeartRateInBeatsPerMinute: "Heart rate asleep",
  sleep_averageRespiration: "Breathing rate asleep",
  daily_activeDurationInSeconds: "Active time",
  daily_highlyActiveDurationInSeconds: "Highly active time",
  respiration_avgWakingBreathsPerMinute: "Breathing rate awake",
  userMetrics_vo2Max: "VO2 max",
  userMetrics_vo2MaxRunning: "VO2 max (running)",
  userMetrics_vo2MaxWalking: "VO2 max (walking)",
  userMetrics_vo2MaxCycling: "VO2 max (cycling)",
  userMetrics_fitnessAge: "Fitness age",
};

/** Unit suffixes in Garmin-style names, longest first, and how to show the value. */
type Kind = "duration" | "distance" | "grams" | "bpm" | "brpm" | "kcal" | "percent" | "plain";
const SUFFIXES: [RegExp, Kind][] = [
  [/(Duration)?InSeconds$/, "duration"],
  [/InMeters$/, "distance"],
  [/InGrams$/, "grams"],
  [/InBeatsPerMinute$/, "bpm"],
  [/BreathsPerMinute$/, "brpm"],
  [/Kilocalories$/, "kcal"],
  [/InPercent$/, "percent"],
  [/SpO2$/i, "percent"],
];

function kindOf(metric: string, unit: string | null): Kind {
  for (const [re, k] of SUFFIXES) if (re.test(metric)) return k;
  const u = (unit ?? "").toLowerCase();
  if (u === "s" || u === "sec" || u === "seconds") return "duration";
  if (u === "m" || u === "meters") return "distance";
  if (u === "g" || u === "grams") return "grams";
  if (u === "bpm") return "bpm";
  if (u === "brpm") return "brpm";
  if (u === "kcal") return "kcal";
  if (u === "%") return "percent";
  return "plain";
}

/** "daily_moderateIntensityDurationInSeconds" -> "Moderate activity"; unknown names are split into words. */
export function metricLabel(metric: string): string {
  if (FULL_NAMES[metric]) return FULL_NAMES[metric];
  const bare = metric.replace(PREFIX, "");
  if (NAMES[bare]) return NAMES[bare];
  let words = bare;
  for (const [re] of SUFFIXES) words = words.replace(re, "");
  words = words
    .replace(/_/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z])([A-Z][a-z])/g, "$1 $2") // "AVery" -> "A Very"
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  return words ? words[0].toUpperCase() + words.slice(1) : metric;
}

const num = (v: number, digits = 0) => v.toLocaleString(undefined, { maximumFractionDigits: digits });

/** "1 h 05 min", "42 min", "50 s". */
function hm(seconds: number): string {
  const s = Math.round(seconds);
  if (s < 60) return `${s} s`;
  const h = Math.floor(s / 3600);
  const m = Math.round((s % 3600) / 60);
  return h ? `${h} h ${String(m).padStart(2, "0")} min` : `${m} min`;
}

/** The value with a readable unit. */
export function metricValue(metric: string, value: number, unit: string | null): string {
  switch (kindOf(metric, unit)) {
    case "duration":
      return hm(value);
    case "distance":
      return value >= 1000 ? `${num(value / 1000, 2)} km` : `${num(value)} m`;
    case "grams":
      return `${num(value / 1000, 1)} kg`;
    case "bpm":
      return `${num(value)} bpm`;
    case "brpm":
      return `${num(value)} breaths/min`;
    case "kcal":
      return `${num(value)} kcal`;
    case "percent":
      return `${num(value, 1)} %`;
    default:
      return `${num(value, 1)}${unit ? ` ${unit}` : ""}`;
  }
}

export const CATEGORY_LABEL: Record<MetricCategory, string> = {
  activity: "Activity",
  heart: "Heart",
  sleep: "Sleep",
  recovery: "Recovery",
  stress: "Stress",
  body: "Body",
  nutrition: "Nutrition",
  other: "Other",
};
export const CATEGORY_ORDER: MetricCategory[] = ["activity", "heart", "sleep", "recovery", "stress", "body", "nutrition", "other"];

/**
 * The group a row shows under: the catalog's category, or, when the metric has no catalog row yet
 * (dayValues reports that as "other"), the same name-based guess the catalog would have made.
 */
export function displayCategory(metric: string, category: MetricCategory): MetricCategory {
  return category === "other" ? classifyMetric(metric).category : category;
}
