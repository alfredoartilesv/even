import { useCallback, useEffect, useState, type ReactNode } from "react";
import type { SqlDriver } from "../../db/driver";
import { BarChart, LineChart, StatTile } from "../../ui/charts";
import { fmtDay, plural, today } from "../../ui/common";
import { PageHeader, Segmented, type Choice } from "../../ui/layout";
import { getCalorieGoal } from "../food/food";
import { fmtDuration } from "../me/workouts";
import { dayValues, type DayValue } from "../metrics/queries";
import { loadDashboard, shiftSpan, spanRange, type Dashboard, type Figure, type Span } from "./dashboard";

interface Props {
  db: SqlDriver;
  /** Bumped after every sync and every change elsewhere, so the numbers reload. */
  version: number;
  configured: boolean;
  /** What the last sync could not bring in, from sync_runs. */
  syncWarnings: string[];
  /** The top bar's left (profile) and right (sync) pieces, owned by the app shell. */
  profile: ReactNode;
  sync: ReactNode;
  onLogFood: () => void;
}

const SPANS: Choice<Span>[] = [
  { id: "day", label: "Day" },
  { id: "week", label: "Week" },
  { id: "month", label: "Month" },
];

const int = (n: number) => Math.round(n).toLocaleString();
const signed = (n: number) => `${n > 0 ? "+" : n < 0 ? "−" : ""}${int(Math.abs(n))}`;
const utc = (day: string) => new Date(`${day}T12:00:00Z`);
const short = (day: string, opts: Intl.DateTimeFormatOptions) => utc(day).toLocaleDateString(undefined, { ...opts, timeZone: "UTC" });
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** "Today", "Mon 20 – Sun 26 Oct", "October 2026". */
function spanTitle(span: Span, anchor: string): string {
  const { from, to } = spanRange(span, anchor);
  if (span === "day") return cap(fmtDay(from));
  if (span === "month") return short(from, { month: "long", year: "numeric" });
  return `${short(from, { day: "numeric", month: "short" })} – ${short(to, { day: "numeric", month: "short" })}`;
}

/**
 * The first tab: how the day, week or month went. Steps, calories burned and eaten (with the
 * balance), workouts and meal prep, each as the period's daily average and total, then charts per
 * day. A day also lists every synced number.
 */
export function DashboardScreen({ db, version, configured, syncWarnings, profile, sync, onLogFood }: Props) {
  const [span, setSpan] = useState<Span>("day");
  const [anchor, setAnchor] = useState(today());
  const [data, setData] = useState<Dashboard | null>(null);
  const [metrics, setMetrics] = useState<DayValue[]>([]);
  const [calorieTarget, setCalorieTarget] = useState<number | null>(null);

  const load = useCallback(async () => {
    const [d, goal] = await Promise.all([loadDashboard(db, span, anchor, today()), getCalorieGoal(db)]);
    setData(d);
    setCalorieTarget(goal?.target ?? null);
    setMetrics(span === "day" ? await dayValues(db, anchor) : []);
  }, [db, span, anchor]);

  useEffect(() => {
    void load();
  }, [load, version]);

  const now = today();
  const current = spanRange(span, anchor);
  const isCurrent = current.from <= now && now <= current.to;
  const next = shiftSpan(span, anchor, 1);
  const many = span !== "day";

  /** A tile's value: the day's number, or the daily average with the total underneath. */
  const tile = (f: Figure | undefined, fmt: (n: number) => string = int) => {
    if (!f || f.total === null) return { value: null, note: many ? "no data" : undefined };
    if (!many) return { value: fmt(f.total) };
    return { value: fmt(f.avg!), note: `a day · ${fmt(f.total)} total${f.daysWithData < (data?.days.length ?? 0) ? ` · ${plural(f.daysWithData, "day")}` : ""}` };
  };

  const d = data;
  const x = d?.days.map((r) => r.day) ?? [];
  const axis = span === "week" ? (day: string) => short(day, { weekday: "narrow" }) : (day: string) => String(Number(day.slice(8)));
  const openDay = (day: string) => {
    setSpan("day");
    setAnchor(day);
  };
  const hasAny = d && (d.steps.total !== null || d.burned.total !== null || d.eaten.total !== null || d.workouts.count > 0 || d.prep.total !== null);

  return (
    <section>
      <PageHeader title="Dashboard" leading={profile} actions={sync} />

      <Segmented
        items={SPANS}
        value={span}
        label="Period"
        onChange={(id) => {
          setSpan(id);
          setAnchor(isCurrent ? now : current.from);
        }}
      />

      <div className="period-nav">
        <button type="button" className="secondary" aria-label={`Previous ${span}`} onClick={() => setAnchor(shiftSpan(span, anchor, -1))}>
          ‹
        </button>
        <div className="grow center">
          <strong>{spanTitle(span, anchor)}</strong>
          {!isCurrent && (
            <button type="button" className="link small accent" onClick={() => setAnchor(now)}>
              Back to {span === "day" ? "today" : `this ${span}`}
            </button>
          )}
        </div>
        <button type="button" className="secondary" aria-label={`Next ${span}`} disabled={next > now} onClick={() => setAnchor(next)}>
          ›
        </button>
      </div>

      {syncWarnings.map((w) => (
        <p key={w} className="warning small">
          {w}
        </p>
      ))}
      {!configured && !hasAny && <p className="muted small">Add your Garmin key in Settings to bring in steps and calories burned, or import your Garmin export.</p>}

      <div className="viz-tiles pairs">
        <StatTile label="Steps" {...tile(d?.steps)} />
        <StatTile label="Calories burned" unit="kcal" {...tile(d?.burned)} />
        <StatTile label="Calories eaten" unit="kcal" {...tile(d?.eaten)} />
        <StatTile label="Balance" unit="kcal" {...tile(d?.balance, signed)} />
        <StatTile label="Active calories" unit="kcal" {...tile(d?.active)} />
        <StatTile label="Protein" unit="g" {...tile(d?.protein)} />
      </div>
      {d && d.balance.total !== null && (
        <p className="muted small">
          Balance is eaten minus burned{many ? `, on the ${plural(d.balance.daysWithData, "day")} that have both` : ""}: below zero is a deficit.
          {d.drinks.total ? ` Eaten includes ${int(d.drinks.total)} kcal from drinks.` : ""}
        </p>
      )}
      <button type="button" className="secondary wide-button" onClick={onLogFood}>
        Log food
      </button>

      {many && d && (
        <>
          <BarChart title="Steps" subtitle="Tap a day to open it" x={x} values={d.days.map((r) => r.steps)} formatX={axis} formatXLong={(day) => fmtDay(day)} formatValue={int} onSelect={openDay} />
          <LineChart
            title="Calories in and out"
            x={x}
            series={[
              { id: "eaten", label: "Eaten", values: d.days.map((r) => r.eatenKcal) },
              { id: "burned", label: "Burned", values: d.days.map((r) => r.burnedKcal) },
            ]}
            formatX={axis}
            formatXLong={(day) => fmtDay(day)}
            formatValue={int}
            unit="kcal"
            target={calorieTarget}
            zero
          />
        </>
      )}

      <h2>Meal prep</h2>
      <div className="viz-tiles pairs">
        <StatTile label="Portions eaten" {...tile(d?.prep, (n) => n.toLocaleString(undefined, { maximumFractionDigits: 1 }))} />
        <StatTile label="In stock now" value={d ? String(d.stock.portions) : null} note={d ? `portions, ${d.stock.batches} ${d.stock.batches === 1 ? "batch" : "batches"}` : undefined} />
      </div>

      <h2>Workouts</h2>
      {d && d.workouts.count > 0 ? (
        <div className="viz-tiles pairs">
          <StatTile label="Sessions" value={String(d.workouts.count)} note={many ? `${(d.workouts.count / d.days.length).toFixed(1)} a day` : undefined} />
          <StatTile label="Time" value={fmtDuration(d.workouts.durationS)} note={many ? `${fmtDuration(d.workouts.durationS / d.days.length)} a day` : undefined} />
        </div>
      ) : (
        <p className="muted small">No workouts {span === "day" ? "this day" : `this ${span}`}.</p>
      )}

      {span === "day" && metrics.length > 0 && (
        <details className="card">
          <summary>All synced numbers ({metrics.length})</summary>
          <table className="values">
            <tbody>
              {metrics.map((v) => (
                <tr key={`${v.metric}|${v.device}`}>
                  <td>
                    {v.label}
                    <div className="muted small">{v.device}</div>
                  </td>
                  <td className="num">
                    {v.value.toLocaleString(undefined, { maximumFractionDigits: 1 })} {v.unit ?? ""}
                    {v.partial && <div className="muted small">day not over</div>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}
    </section>
  );
}
