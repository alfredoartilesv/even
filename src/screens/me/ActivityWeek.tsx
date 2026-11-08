import { useEffect, useState } from "react";
import type { SqlDriver } from "../../db/driver";
import { loadDashboard, type Dashboard } from "../../domain/dashboard/dashboard";
import { fmtDuration } from "../../domain/me/workouts";
import { dayValues, type DayValue } from "../../domain/metrics/queries";
import { BarChart, StackedBar, StatTile } from "../../ui/charts";
import { fmtDay, today } from "../../ui/common";
import { SyncedNumbers } from "../dashboard/SyncedNumbers";

const int = (n: number) => Math.round(n).toLocaleString();
const STAGES = [
  { metric: "sleep_deepSleepDurationInSeconds", label: "Deep" },
  { metric: "sleep_lightSleepDurationInSeconds", label: "Light" },
  { metric: "sleep_remSleepInSeconds", label: "REM" },
];

/**
 * The top of Activity (handoff 0.7): this week's workouts, average steps, active energy and
 * resting heart rate; steps each day against the goal; and last night's sleep with its stages.
 */
export function ActivityWeek({ db, version }: { db: SqlDriver; version: number }) {
  const [d, setD] = useState<Dashboard | null>(null);
  const [night, setNight] = useState<DayValue[]>([]);
  useEffect(() => {
    const day = today();
    void Promise.all([loadDashboard(db, "week", day, day), dayValues(db, day)]).then(([w, v]) => {
      setD(w);
      setNight(v);
    });
  }, [db, version]);
  if (!d) return null;
  const sleep = night.find((v) => v.metric === "sleep_durationInSeconds");
  const score = night.find((v) => v.metric === "sleep_overallSleepScore");
  const stages = STAGES.map((s) => ({ ...s, v: night.find((v) => v.metric === s.metric)?.value ?? null })).filter((s) => s.v !== null);
  return (
    <div className="activity-week">
      <section className="today-tiles four" aria-label="This week">
        <StatTile label="Workouts" value={String(d.workouts.count)} note={`${fmtDuration(d.workouts.durationS)} this week`} />
        <StatTile
          label="Average steps"
          value={d.steps.avg !== null ? int(d.steps.avg) : null}
          note={d.targets.steps ? `goal ${int(d.targets.steps)}` : undefined}
        />
        <StatTile label="Active energy" value={d.active.total !== null ? int(d.active.total) : null} note="kcal this week" />
        <StatTile label="Resting heart rate" value={d.body.restingHr.avg !== null ? int(d.body.restingHr.avg) : null} note="bpm, average" />
      </section>
      <div className="activity-pair">
        <BarChart
          title="Steps each day"
          subtitle={d.targets.steps ? `goal ${int(d.targets.steps)}` : undefined}
          x={d.days.map((r) => r.day)}
          values={d.days.map((r) => r.steps)}
          formatX={(x) => new Date(`${x}T12:00:00Z`).toLocaleDateString(undefined, { weekday: "narrow", timeZone: "UTC" })}
          formatXLong={(x) => fmtDay(x)}
          formatValue={int}
        />
        <section className="card sleep-card" aria-labelledby="sleep-last">
          <div className="so-far-head">
            <h2 id="sleep-last">Sleep last night</h2>
            {score && <span className="muted small">Score {int(score.value)}</span>}
          </div>
          <span className="sleep-big">{sleep ? fmtDuration(sleep.value) : "No sleep synced"}</span>
          {/* The week beside last night, so the card says how the night compares instead of standing half empty. */}
          <dl className="sleep-week">
            <div>
              <dt className="muted small">Average this week</dt>
              <dd>{d.body.sleep.avg !== null ? fmtDuration(d.body.sleep.avg) : "–"}</dd>
            </div>
            <div>
              <dt className="muted small">Average score</dt>
              <dd>{d.body.sleepScore.avg !== null ? int(d.body.sleepScore.avg) : "–"}</dd>
            </div>
            <div>
              <dt className="muted small">Nights synced</dt>
              <dd>{d.body.sleep.daysWithData} of 7</dd>
            </div>
          </dl>
          {stages.length > 0 && (
            <StackedBar label="Sleep stages" parts={stages.map((s, i) => ({ label: s.label, value: s.v!, slot: i + 1 }))} format={fmtDuration} />
          )}
        </section>
      </div>
      {/* Every number the watch sent today, moved here from Today (the board keeps Today to the essentials). */}
      {night.length > 0 && <SyncedNumbers metrics={night} />}
    </div>
  );
}
