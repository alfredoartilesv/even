import { useEffect, useState, type ReactNode } from "react";
import type { SqlDriver } from "../../db/driver";
import type { Dashboard } from "../../domain/dashboard/dashboard";
import { CHART_IDS, loadPins, savePins, type ChartId } from "../../domain/dashboard/pins";
import { fmtDuration } from "../../domain/me/workouts";
import { BarChart, LineChart } from "../../ui/charts";
import { fmtDay } from "../../ui/common";
import { Icon } from "../../ui/icons";

const int = (n: number) => Math.round(n).toLocaleString();

interface Props {
  db: SqlDriver;
  d: Dashboard;
  /** "this week" or "this month", for the heading. */
  period: string;
  formatX: (day: string) => string;
  /** Tap a day on the steps chart to open it. */
  onDay: (day: string) => void;
}

/**
 * Today's charts for a week or a month: the pinned ones, or every chart with "Show all charts".
 * Each card has a pin button; what is pinned is kept on this device (domain/dashboard/pins.ts).
 * Pinned charts come first when all are shown.
 */
export function PinnedCharts({ db, d, period, formatX, onDay }: Props) {
  const [pins, setPins] = useState<ChartId[] | null>(null);
  const [all, setAll] = useState(false);
  useEffect(() => {
    void loadPins(db).then(setPins, () => setPins([]));
  }, [db]);
  if (pins === null) return null;

  const toggle = (id: ChartId) => {
    const next = pins.includes(id) ? pins.filter((p) => p !== id) : [...pins, id];
    setPins(next);
    void savePins(db, next);
  };
  const x = d.days.map((r) => r.day);
  const long = (day: string) => fmtDay(day);
  const pin = (id: ChartId, title: string) => {
    const on = pins.includes(id);
    return (
      <button
        type="button"
        className={`pin-button${on ? " on" : ""}`}
        aria-pressed={on}
        aria-label={`${on ? "Unpin" : "Pin"} ${title}`}
        onClick={() => toggle(id)}
      >
        <Icon name="pin" size={18} />
      </button>
    );
  };

  const charts: Record<ChartId, ReactNode> = {
    calories: (
      <BarChart
        title="Calories eaten"
        subtitle={d.targets.kcal ? `Food and drinks against your ${int(d.targets.kcal)} kcal target` : "Food and drinks each day"}
        x={x}
        values={d.days.map((r) => r.eatenKcal)}
        formatX={formatX}
        formatXLong={long}
        formatValue={int}
        unit="kcal"
        target={d.targets.kcal}
        action={pin("calories", "Calories eaten")}
      />
    ),
    energy: (
      <LineChart
        title="Energy balance"
        subtitle="What you ate against what you burned"
        x={x}
        series={[
          { id: "eaten", label: "Eaten", values: d.days.map((r) => r.eatenKcal) },
          { id: "burned", label: "Burned", values: d.days.map((r) => r.burnedKcal) },
        ]}
        formatX={formatX}
        formatXLong={long}
        formatValue={int}
        unit="kcal"
        zero
        action={pin("energy", "Energy balance")}
      />
    ),
    protein: (
      <LineChart
        title="Protein"
        subtitle={d.targets.protein ? `Dashed line is your ${int(d.targets.protein)} g target` : "Grams each day"}
        x={x}
        series={[{ id: "protein", label: "Protein", values: d.days.map((r) => r.proteinG) }]}
        formatX={formatX}
        formatXLong={long}
        formatValue={int}
        unit="g"
        target={d.targets.protein}
        zero
        action={pin("protein", "Protein")}
      />
    ),
    steps: (
      <BarChart
        title="Steps"
        subtitle="Tap a day to open it"
        x={x}
        values={d.days.map((r) => r.steps)}
        formatX={formatX}
        formatXLong={long}
        formatValue={int}
        onSelect={onDay}
        action={pin("steps", "Steps")}
      />
    ),
    sleep: (
      <BarChart
        title="Sleep"
        subtitle="Each night, from the watch"
        x={d.trendDays}
        values={d.body.sleep.trend}
        formatX={formatX}
        formatXLong={long}
        formatValue={fmtDuration}
        action={pin("sleep", "Sleep")}
      />
    ),
    heart: (
      <LineChart
        title="Heart rate and recovery"
        subtitle="Resting heart rate (bpm) and overnight HRV (ms)"
        x={d.trendDays}
        series={[
          { id: "rhr", label: "Resting heart rate", values: d.body.restingHr.trend },
          { id: "hrv", label: "HRV", values: d.body.hrv.trend },
        ]}
        formatX={formatX}
        formatXLong={long}
        formatValue={int}
        action={pin("heart", "Heart rate and recovery")}
      />
    ),
  };

  const ordered = [...CHART_IDS.filter((id) => pins.includes(id)), ...CHART_IDS.filter((id) => !pins.includes(id))];
  const shown = all ? ordered : ordered.filter((id) => pins.includes(id));
  return (
    <section className="pinned-charts" aria-labelledby="charts-title">
      <div className="pinned-head">
        <h2 id="charts-title">
          Charts · {period}
          {all ? "" : " · pinned"}
        </h2>
        <button type="button" className="secondary" aria-expanded={all} onClick={() => setAll(!all)}>
          {all ? "Show pinned only" : `Show all charts (${CHART_IDS.length})`}
        </button>
      </div>
      {shown.length === 0 && <p className="muted small pinned-empty">No charts pinned. Open Show all charts and pin the ones you want to keep here.</p>}
      <div className="pinned-grid">
        {shown.map((id) => (
          <div key={id}>{charts[id]}</div>
        ))}
      </div>
    </section>
  );
}
