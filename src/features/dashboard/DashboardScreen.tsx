import { useCallback, useEffect, useState, type ReactNode } from "react";
import type { SqlDriver } from "../../db/driver";
import { BarChart, LineChart, Ring, StatTile } from "../../ui/charts";
import { fmtDay, plural, today } from "../../ui/common";
import { PageHeader, QuickActions, SectionHeader, Segmented, type Choice } from "../../ui/layout";
import { fmtDuration } from "../me/workouts";
import { dayValues, type DayValue } from "../metrics/queries";
import { loadProfile } from "../settings/profile";
import { loadDashboard, shiftSpan, spanRange, type Dashboard, type Figure, type Span } from "./dashboard";
import { greeting } from "./greeting";

/** Where the Dashboard's buttons go; the app shell switches tab. */
export interface DashboardLinks {
  logFood: () => void;
  logDrink: () => void;
  askClaude: () => void;
  mealPrep: () => void;
  profile: () => void;
}

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
  go: DashboardLinks;
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
 * The first tab: how the day, week or month went. A greeting and the date; the things done most
 * (log food or a drink, ask Claude, meal prep); rings for calories eaten against the target and
 * steps against the goal; then energy, workouts and meal prep, each as the period's daily
 * average and total, with charts per day. A day also lists every synced number.
 */
export function DashboardScreen({ db, version, configured, syncWarnings, profile, sync, go }: Props) {
  const [span, setSpan] = useState<Span>("day");
  const [anchor, setAnchor] = useState(today());
  const [data, setData] = useState<Dashboard | null>(null);
  const [metrics, setMetrics] = useState<DayValue[]>([]);
  const [name, setName] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [d, p] = await Promise.all([loadDashboard(db, span, anchor, today()), loadProfile(db)]);
    setData(d);
    setName(p.name);
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
  /** For the rings and the hero line: the day's number, or the daily average. */
  const headline = (f: Figure | undefined) => (f && f.total !== null ? (many ? f.avg : f.total) : null);

  const d = data;
  const x = d?.days.map((r) => r.day) ?? [];
  const axis = span === "week" ? (day: string) => short(day, { weekday: "narrow" }) : (day: string) => String(Number(day.slice(8)));
  const openDay = (day: string) => {
    setSpan("day");
    setAnchor(day);
  };
  const hasAny = d && (d.steps.total !== null || d.burned.total !== null || d.eaten.total !== null || d.workouts.count > 0 || d.prep.total !== null);
  const dateLine = utc(now).toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" });
  const balance = headline(d?.balance);

  return (
    <section>
      <PageHeader title={greeting(new Date().getHours(), name)} subtitle={dateLine} leading={profile} actions={sync} />

      {syncWarnings.map((w) => (
        <p key={w} className="warning small">
          {w}
        </p>
      ))}
      {!configured && !hasAny && <p className="muted small">Add your Garmin key in Settings to bring in steps and calories burned, or import your Garmin export.</p>}

      <QuickActions
        actions={[
          { id: "food", label: "Log food", icon: "food", onClick: go.logFood },
          { id: "drink", label: "Log a drink", icon: "alcohol", onClick: go.logDrink },
          { id: "chat", label: "Ask Claude", icon: "sparkle", onClick: go.askClaude },
          { id: "prep", label: "Meal prep", icon: "box", onClick: go.mealPrep },
        ]}
      />

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
        <button type="button" className="secondary icon-button" aria-label={`Previous ${span}`} onClick={() => setAnchor(shiftSpan(span, anchor, -1))}>
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
        <button type="button" className="secondary icon-button" aria-label={`Next ${span}`} disabled={next > now} onClick={() => setAnchor(next)}>
          ›
        </button>
      </div>

      {/* Keyed by period so the card animates in when the period changes. */}
      <div key={`${span}|${anchor}`} className="card hero-card fade-in">
        <div className="rings">
          <Ring label={many ? "Eaten, a day" : "Eaten"} value={headline(d?.eaten)} target={d?.targets.kcal ?? null} kind="limit" unit="kcal" format={int} />
          <Ring label={many ? "Steps, a day" : "Steps"} value={headline(d?.steps)} target={d?.targets.steps ?? null} kind="goal" format={int} />
        </div>
        <dl className="hero-stats">
          <div>
            <dt className="muted small">Burned</dt>
            <dd>{headline(d?.burned) !== null ? `${int(headline(d?.burned)!)} kcal` : "–"}</dd>
          </div>
          <div>
            <dt className="muted small">Balance</dt>
            <dd>{balance !== null ? `${signed(balance)} kcal` : "–"}</dd>
          </div>
          <div>
            <dt className="muted small">Protein</dt>
            <dd>{headline(d?.protein) !== null ? `${int(headline(d?.protein)!)} g` : "–"}</dd>
          </div>
        </dl>
        {d && d.balance.total !== null && (
          <p className="muted small hero-note">
            Balance is eaten minus burned{many ? `, a day, on the ${plural(d.balance.daysWithData, "day")} with both` : ""}: below zero is a deficit.
            {d.drinks.total ? ` Eaten includes ${int(d.drinks.total)} kcal from drinks.` : ""}
          </p>
        )}
      </div>

      <SectionHeader title="Energy" />
      <div className="viz-tiles pairs">
        <StatTile label="Calories burned" unit="kcal" {...tile(d?.burned)} />
        <StatTile label="Active calories" unit="kcal" {...tile(d?.active)} />
        {/* A day's eaten and steps are in the rings; a week or month adds their totals here. */}
        {many && <StatTile label="Calories eaten" unit="kcal" {...tile(d?.eaten)} />}
        {many && <StatTile label="Steps" {...tile(d?.steps)} />}
      </div>

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
            target={d.targets.kcal}
            zero
          />
        </>
      )}

      <SectionHeader title="Workouts" action="Your activity" onAction={go.profile} />
      {d && d.workouts.count > 0 ? (
        <div className="viz-tiles pairs">
          <StatTile label="Sessions" value={String(d.workouts.count)} note={many ? `${(d.workouts.count / d.days.length).toFixed(1)} a day` : undefined} />
          <StatTile label="Time" value={fmtDuration(d.workouts.durationS)} note={many ? `${fmtDuration(d.workouts.durationS / d.days.length)} a day` : undefined} />
        </div>
      ) : (
        <p className="muted small">No workouts {span === "day" ? "this day" : `this ${span}`}.</p>
      )}

      <SectionHeader title="Meal prep" action="Open" onAction={go.mealPrep} />
      <div className="viz-tiles pairs">
        <StatTile label="Portions eaten" {...tile(d?.prep, (n) => n.toLocaleString(undefined, { maximumFractionDigits: 1 }))} />
        <StatTile label="In stock now" value={d ? String(d.stock.portions) : null} note={d ? `portions, ${d.stock.batches} ${d.stock.batches === 1 ? "batch" : "batches"}` : undefined} />
      </div>

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
