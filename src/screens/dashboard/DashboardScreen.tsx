import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { createLogger } from "../../core/log";
import { newestOnly } from "../../core/newest";
import type { SqlDriver } from "../../db/driver";
import { BarChart, LineChart, Ring, StatTile } from "../../ui/charts";
import { fmtDay, fmtMoney, plural, today } from "../../ui/common";
import { Icon } from "../../ui/icons";
import { PageHeader, PeriodNav, QuickActions, SectionHeader, Segmented, type Choice } from "../../ui/layout";
import { fmtDistance, fmtDuration } from "../../domain/me/workouts";
import { dayValues, type DayValue } from "../../domain/metrics/queries";
import { SCALE } from "../../domain/journal/entries";
import { loadProfile } from "../../domain/settings/profile";
import {
  loadDashboard,
  pinnedAnchor,
  shiftSpan,
  spanRange,
  type BodyFigure,
  type BodyKey,
  type Dashboard,
  type Figure,
  type Span,
} from "../../domain/dashboard/dashboard";
import { greeting } from "../../domain/dashboard/greeting";
import { SyncedNumbers } from "./SyncedNumbers";
import { appleHealthSupported } from "../../platform/health";

const log = createLogger("dashboard");

/**
 * The last answers, kept for the app's run: the screen remounts on every tab switch, and drawing
 * the last numbers at once beats a blank screen while the database answers. Every visit still
 * reloads, so a cached view is at most one load old.
 */
interface Shown {
  data: Dashboard;
  metrics: DayValue[];
  name: string | null;
}
const shownCache = new Map<string, Shown>();
const CACHED_VIEWS = 12;
const cacheKey = (span: Span, anchor: string) => `${span}|${anchor}`;
function remember(key: string, s: Shown) {
  shownCache.delete(key);
  shownCache.set(key, s);
  if (shownCache.size > CACHED_VIEWS) shownCache.delete(shownCache.keys().next().value!);
}
/** Day, week or month: the one last looked at, so coming back to the tab shows the same view. */
let lastSpan: Span = "day";

/** Where the Dashboard's buttons go; the app shell switches tab. */
export interface DashboardLinks {
  logFood: () => void;
  logDrink: () => void;
  askClaude: () => void;
  mealPrep: () => void;
  profile: () => void;
  /** The journal on the check-in of a day (today by default), or on the measurements. */
  checkIn: (day?: string) => void;
  measurements: () => void;
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
 * (log food or a drink, ask Claude, the daily check-in); rings for calories eaten against the
 * target and steps against the goal; the check-in (mood, energy, note, latest weight); then
 * energy, workouts and meal prep, each as the period's daily average and total, with charts per
 * day. A day also lists every synced number.
 */
export function DashboardScreen({ db, version, configured, syncWarnings, profile, sync, go }: Props) {
  const [span, setSpanState] = useState<Span>(lastSpan);
  const setSpan = (s: Span) => setSpanState((lastSpan = s));
  // null = the current period, which moves on by itself when the day changes (the app can stay
  // open overnight); a past period the owner picked stays put.
  const [picked, setPicked] = useState<string | null>(null);
  const now = today();
  const anchor = picked ?? now;
  const setAnchor = (day: string, sp: Span = span) => setPicked(pinnedAnchor(sp, day, now));
  const [shown, setShown] = useState<Shown | null>(() => shownCache.get(cacheKey(span, anchor)) ?? null);
  const data = shown?.data ?? null;
  const metrics = shown?.metrics ?? [];
  const name = shown?.name ?? null;

  // Loads overlap (a sync finishing, quick taps on ‹ ›, Day / Week / Month): only the newest may
  // show, or an older, slower answer would put another period's numbers under this title.
  const begin = useRef(newestOnly()).current;
  const load = useCallback(async () => {
    const isNewest = begin();
    const key = cacheKey(span, anchor);
    const cached = shownCache.get(key);
    if (cached) setShown(cached);
    // Debug logs at Info: how long the figures and the day's metric list each take on this phone.
    const timed = <T,>(what: string, p: Promise<T>) => {
      const done = log.time(`${what} loaded`, "info");
      return p.then((v) => (done({ span }), v));
    };
    const all = log.time("dashboard loaded", "info");
    performance.mark("even:dashboard-query");
    const [d, p, m] = await Promise.all([
      timed("figures", loadDashboard(db, span, anchor, today())),
      loadProfile(db),
      span === "day" ? timed("day metrics", dayValues(db, anchor)) : Promise.resolve([]),
    ]);
    all({ span, cached: Boolean(cached) });
    performance.mark("even:dashboard-data");
    const fresh = { data: d, metrics: m, name: p.name };
    remember(key, fresh);
    if (isNewest()) setShown(fresh);
  }, [db, span, anchor, begin]);

  useEffect(() => {
    void load();
  }, [load, version]);

  // Once per app run: when the first numbers are on screen (read by scripts/perf-device.mjs).
  useEffect(() => {
    if (data && performance.getEntriesByName("even:dashboard-ready").length === 0) performance.mark("even:dashboard-ready");
  }, [data]);

  const current = spanRange(span, anchor);
  const isCurrent = current.from <= now && now <= current.to;
  const next = shiftSpan(span, anchor, 1);
  const many = span !== "day";

  /** A tile's value: the day's number, or the daily average with the total underneath. */
  const tile = (f: Figure | undefined, fmt: (n: number) => string = int) => {
    if (!f || f.total === null) return { value: null, note: many ? "no data" : undefined };
    if (!many) return { value: fmt(f.total) };
    return {
      value: fmt(f.avg!),
      note: `a day · ${fmt(f.total)} total${f.daysWithData < (data?.days.length ?? 0) ? ` · ${plural(f.daysWithData, "day")}` : ""}`,
    };
  };
  /** For the rings and the hero line: the day's number, or the daily average. */
  const headline = (f: Figure | undefined) => (f && f.total !== null ? (many ? f.avg : f.total) : null);

  const d = data;
  const x = d?.days.map((r) => r.day) ?? [];
  const axis = span === "week" ? (day: string) => short(day, { weekday: "narrow" }) : (day: string) => String(Number(day.slice(8)));
  const openDay = (day: string) => {
    setSpan("day");
    setAnchor(day, "day");
  };
  const hasAny = d && (d.steps.total !== null || d.burned.total !== null || d.eaten.total !== null || d.workouts.count > 0 || d.prep.total !== null);
  const dateLine = utc(now).toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" });
  const balance = headline(d?.balance);

  return (
    <section>
      <PageHeader title={greeting(name)} subtitle={dateLine} leading={profile} actions={sync} />

      {syncWarnings.map((w) => (
        <p key={w} className="warning small">
          {w}
        </p>
      ))}
      {!configured && !hasAny && (
        <p className="muted small">
          {appleHealthSupported ? "Connect Apple Health or add your Garmin key in Settings" : "Add your Garmin key in Settings"} to bring in steps and calories
          burned, or import your Garmin export.
        </p>
      )}

      <QuickActions
        actions={[
          { id: "food", label: "Log food", icon: "food", onClick: go.logFood },
          { id: "drink", label: "Log a drink", icon: "alcohol", onClick: go.logDrink },
          { id: "chat", label: "Ask Claude", icon: "sparkle", onClick: go.askClaude },
          { id: "checkin", label: "Check-in", icon: "note", onClick: () => go.checkIn() },
        ]}
      />

      <Segmented
        items={SPANS}
        value={span}
        label="Period"
        onChange={(id) => {
          setSpan(id);
          setAnchor(isCurrent ? now : current.from, id);
        }}
      />

      <PeriodNav
        title={spanTitle(span, anchor)}
        unit={span}
        onPrev={() => setAnchor(shiftSpan(span, anchor, -1))}
        onNext={() => setAnchor(next)}
        nextDisabled={next > now}
        onCurrent={isCurrent ? null : () => setAnchor(now)}
        currentLabel={`Back to ${span === "day" ? "today" : `this ${span}`}`}
      />

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
            <dd>
              {headline(d?.protein) !== null ? `${int(headline(d?.protein)!)} g` : "–"}
              {d?.targets.protein != null && <span className="muted small"> / {int(d.targets.protein)}</span>}
            </dd>
          </div>
        </dl>
        {d && d.balance.total !== null && (
          <p className="muted small hero-note">
            Balance is eaten minus burned{many ? `, a day, on the ${plural(d.balance.daysWithData, "day")} with both` : ""}: below zero is a deficit.
            {d.drinks.total ? ` Eaten includes ${int(d.drinks.total)} kcal from drinks.` : ""}
          </p>
        )}
      </div>

      <SectionHeader title="Check-in" action="Journal" onAction={() => go.checkIn(many ? undefined : anchor)} />
      <CheckInCard data={d} many={many} day={anchor} onOpen={() => go.checkIn(many ? undefined : anchor)} onWeight={go.measurements} />

      <SectionHeader title="Activity" />
      <div className="viz-tiles pairs">
        <StatTile label="Calories burned" unit="kcal" {...tile(d?.burned)} />
        <StatTile label="Active calories" unit="kcal" {...tile(d?.active)} />
        {d && d.body.distance.total !== null && (
          <StatTile label="Distance" {...tile(d.body.distance, fmtDistance)} trend={many ? undefined : d.body.distance.trend} />
        )}
        {d && d.body.intensityMin.total !== null && <IntensityTile f={d.body.intensityMin} span={span} />}
        {/* A day's eaten and steps are in the rings; a week or month adds their totals here. */}
        {many && <StatTile label="Calories eaten" unit="kcal" {...tile(d?.eaten)} />}
        {many && <StatTile label="Steps" {...tile(d?.steps)} />}
      </div>

      {many && d && (
        <>
          <BarChart
            title="Steps"
            subtitle="Tap a day to open it"
            x={x}
            values={d.days.map((r) => r.steps)}
            formatX={axis}
            formatXLong={(day) => fmtDay(day)}
            formatValue={int}
            onSelect={openDay}
          />
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

      {d && <Recovery d={d} many={many} />}

      <SectionHeader title="Workouts" action="Your activity" onAction={go.profile} />
      {d && d.workouts.count > 0 ? (
        <div className="viz-tiles pairs">
          <StatTile label="Sessions" value={String(d.workouts.count)} note={many ? `${(d.workouts.count / d.days.length).toFixed(1)} a day` : undefined} />
          <StatTile
            label="Time"
            value={fmtDuration(d.workouts.durationS)}
            note={many ? `${fmtDuration(d.workouts.durationS / d.days.length)} a day` : undefined}
          />
        </div>
      ) : (
        <p className="muted small">No workouts {span === "day" ? "this day" : `this ${span}`}.</p>
      )}

      <SectionHeader title="Meal prep" action="Open" onAction={go.mealPrep} />
      <div className="viz-tiles pairs">
        <StatTile label="Portions eaten" {...tile(d?.prep, (n) => n.toLocaleString(undefined, { maximumFractionDigits: 1 }))} />
        <StatTile
          label="In stock now"
          value={d ? String(d.stock.portions) : null}
          note={d ? `portions, ${d.stock.batches} ${d.stock.batches === 1 ? "batch" : "batches"}` : undefined}
        />
        <StatTile
          label="Groceries"
          value={d && d.groceries.trips ? fmtMoney(d.groceries.total, d.groceries.currency) : null}
          note={d ? (d.groceries.trips ? plural(d.groceries.trips, "shop") : "nothing logged") : undefined}
        />
      </div>

      {span === "day" && metrics.length > 0 && <SyncedNumbers metrics={metrics} />}
    </section>
  );
}

const bpm = (n: number) => `${Math.round(n)} bpm`;
const whole = (n: number) => String(Math.round(n));

/** Each recovery number: label, format, and which way is good (for the words under it). */
const RECOVERY: { key: BodyKey; label: string; fmt: (n: number) => string; note?: string }[] = [
  { key: "sleep", label: "Sleep", fmt: fmtDuration },
  { key: "restingHr", label: "Resting heart rate", fmt: bpm, note: "lower is fitter" },
  { key: "hrv", label: "HRV overnight", fmt: (n) => `${Math.round(n)} ms`, note: "higher is better rested" },
  { key: "bodyBatteryHigh", label: "Body Battery", fmt: whole },
  { key: "stress", label: "Stress", fmt: whole, note: "0-100, under 25 is rest" },
];

/**
 * How rested the body is, from the watch: sleep (with its score), resting heart rate, overnight
 * HRV, Body Battery (high and low) and stress. A day shows its numbers with the two weeks before as
 * a trend; a week or month its daily averages, trend per day. Only numbers the watch sends appear.
 */
function Recovery({ d, many }: { d: Dashboard; many: boolean }) {
  // A tile shows while its trend has data, so a day the watch missed reads as a dash, not a gap in the grid.
  const shown = RECOVERY.filter((r) => d.body[r.key].trend.some((v) => v !== null));
  if (!shown.length) return null;
  const value = (f: BodyFigure) => (many ? f.avg : f.total);
  const extra = (k: BodyKey): string | undefined => {
    const score = value(d.body.sleepScore);
    const low = value(d.body.bodyBatteryLow);
    if (k === "sleep" && score !== null) return `score ${whole(score)}${many ? " on average" : ""}`;
    if (k === "bodyBatteryHigh" && low !== null) return `high · low ${whole(low)}`;
    return undefined;
  };
  return (
    <>
      <SectionHeader title="Recovery" />
      <div className="viz-tiles pairs">
        {shown.map((r) => {
          const f = d.body[r.key];
          const notes = [many ? "a day on average" : null, extra(r.key) ?? (many ? null : r.note)].filter(Boolean);
          const v = value(f);
          return <StatTile key={r.key} label={r.label} value={v === null ? null : r.fmt(v)} note={notes.join(" · ") || undefined} trend={f.trend} />;
        })}
      </div>
    </>
  );
}

/** Garmin's intensity minutes (vigorous count double) against the WHO's 150 a week: the day's, or the period's total. */
function IntensityTile({ f, span }: { f: BodyFigure; span: Span }) {
  const total = Math.round(f.total!);
  const note =
    span === "day"
      ? "minutes today"
      : span === "week"
        ? `of 150 a week${total >= 150 ? " · met" : ` · ${150 - total} to go`}`
        : `${Math.round(f.avg! * 7)} a week on average`;
  return <StatTile label="Intensity minutes" value={String(total)} note={note} trend={span === "day" ? f.trend : undefined} />;
}

const word = (v: number) => SCALE[Math.min(5, Math.max(1, Math.round(v))) - 1].toLowerCase();

/** The day's note (or a prompt to write one), or for a week or month how many days have one and the average mood and energy; the latest weight. */
function CheckInCard({ data, many, day, onOpen, onWeight }: { data: Dashboard | null; many: boolean; day: string; onOpen: () => void; onWeight: () => void }) {
  if (!data) return null;
  const j = data.journal;
  const note = many ? null : (j.notes.find((n) => n.day === day) ?? null);
  const ratings = (mood: number | null, energy: number | null, avg: boolean) =>
    [mood !== null && `Mood ${avg ? "about " : ""}${word(mood)}`, energy !== null && `energy ${avg ? "about " : ""}${word(energy)}`].filter(Boolean).join(", ");
  return (
    <div className="card checkin-card">
      {many ? (
        <button type="button" className="link checkin-main" onClick={onOpen}>
          <strong>{j.notes.length ? `${plural(j.notes.length, "day")} with a note` : "No notes this period"}</strong>
          {j.notes.length > 0 && <span className="muted small block">{ratings(j.mood.avg, j.energy.avg, true) || "No ratings"}</span>}
        </button>
      ) : note ? (
        <button type="button" className="link checkin-main" onClick={onOpen}>
          <strong>{ratings(note.mood, note.energy, false) || "Note"}</strong>
          {note.body && <span className="muted small block clamp">{note.body}</span>}
        </button>
      ) : (
        <button type="button" className="secondary checkin-prompt" onClick={onOpen}>
          <Icon name="note" size={20} />
          {day === today() ? "How is the day going? Add a note" : "Add a note for this day"}
        </button>
      )}
      <button type="button" className="link checkin-weight small" onClick={onWeight}>
        <Icon name="scale" size={18} />
        {j.weight ? (
          <span>
            Weight <strong>{j.weight.kg.toLocaleString(undefined, { maximumFractionDigits: 1 })} kg</strong>{" "}
            <span className="muted">· {fmtDay(j.weight.day)}</span>
          </span>
        ) : (
          <span className="muted">Log your weight</span>
        )}
      </button>
    </div>
  );
}
