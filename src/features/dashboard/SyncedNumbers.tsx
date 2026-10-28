import { useState } from "react";
import { StackedBar } from "../../ui/charts";
import { ChipGroup } from "../../ui/controls";
import { SectionHeader } from "../../ui/layout";
import type { MetricCategory } from "../metrics/catalog";
import { CATEGORY_LABEL, CATEGORY_ORDER, displayCategory, metricLabel, metricValue } from "../metrics/display";
import type { DayValue } from "../metrics/queries";
import { fmtDuration } from "../me/workouts";

/** The category last looked at, kept while the app runs so moving between days keeps it. */
let lastCategory: MetricCategory | null = null;

/** Sleep stages as Garmin's sync and its export name them, in the order they are drawn. Fixed color slots. */
const STAGES: { label: string; match: RegExp; slot: number }[] = [
  { label: "Deep", match: /^sleep_deep/, slot: 7 },
  { label: "Light", match: /^sleep_light/, slot: 1 },
  { label: "REM", match: /^sleep_rem/, slot: 5 },
  { label: "Awake", match: /^sleep_awake/, slot: 4 },
];

/** The headline number of each kind leads its group: total sleep and its score, steps, calories, resting heart rate... */
const LEAD = [
  "sleep_durationInSeconds",
  "sleep_overallSleepScore",
  "daily_steps",
  "daily_totalKilocalories",
  "daily_activeKilocalories",
  "daily_distanceInMeters",
  "daily_restingHeartRateInBeatsPerMinute",
  "hrv_lastNightAvg",
  "dailyBodyBattery_highestValue",
  "daily_averageStressLevel",
  "body_weightInGrams",
];
const lead = (metric: string) => {
  const i = LEAD.indexOf(metric);
  return i < 0 ? LEAD.length : i;
};

/**
 * Every number the watch sent for the day, one kind at a time: chips for activity, heart, sleep...
 * (with how many each has), then the numbers as a two-column grid with plain names and units. Sleep
 * adds its stages as one bar. The device is named once; per number only when several sent it.
 */
export function SyncedNumbers({ metrics }: { metrics: DayValue[] }) {
  const devices = [...new Set(metrics.map((v) => v.device).filter(Boolean))];
  const perMetric = new Map<string, number>();
  for (const v of metrics) perMetric.set(v.metric, (perMetric.get(v.metric) ?? 0) + 1);
  const groups = CATEGORY_ORDER.map((c) => ({
    category: c,
    rows: metrics.filter((v) => displayCategory(v.metric, v.category) === c).sort((a, b) => lead(a.metric) - lead(b.metric)),
  })).filter((g) => g.rows.length);
  const [picked, setPicked] = useState<MetricCategory | null>(lastCategory);
  const open = groups.find((g) => g.category === picked) ?? groups[0];
  if (!open) return null;

  const stages = open.category === "sleep" ? STAGES.map((s) => ({ ...s, row: open.rows.find((r) => s.match.test(r.metric)) })).filter((s) => s.row) : [];

  return (
    <>
      <SectionHeader title="From your watch" />
      <p className="muted small">
        {metrics.length} numbers{devices.length === 1 ? ` from ${devices[0]}` : devices.length > 1 ? ` from ${devices.length} devices` : ""}
      </p>
      <ChipGroup
        label="Kind of number"
        options={groups.map((g) => ({ id: g.category, label: `${CATEGORY_LABEL[g.category]} ${g.rows.length}` }))}
        value={open.category}
        onChange={(c) => setPicked((lastCategory = c))}
      />
      <div className="card synced">
        {stages.length >= 2 && (
          <StackedBar parts={stages.map((s) => ({ label: s.label, value: s.row!.value, slot: s.slot }))} format={fmtDuration} label="Sleep stages" />
        )}
        <dl className="synced-grid">
          {open.rows.map((v) => (
            <div key={`${v.metric}|${v.device}`}>
              <dt className="muted small">{v.label === v.metric ? metricLabel(v.metric) : v.label}</dt>
              <dd>
                {metricValue(v.metric, v.value, v.unit)}
                {v.partial && <span className="muted small block">so far today</span>}
                {(devices.length > 1 || (perMetric.get(v.metric) ?? 0) > 1) && <span className="muted small block">{v.device}</span>}
              </dd>
            </div>
          ))}
        </dl>
      </div>
    </>
  );
}
