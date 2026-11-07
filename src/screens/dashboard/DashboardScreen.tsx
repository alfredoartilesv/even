import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { createLogger } from "../../core/log";
import { newestOnly } from "../../core/newest";
import type { SqlDriver } from "../../db/driver";
import { BalanceRing, BarChart, StatTile } from "../../ui/charts";
import { fmtDay, plural, timeZone, today } from "../../ui/common";
import { Icon } from "../../ui/icons";
import { MacroBars } from "../../ui/nutrition";
import { PageHeader, PeriodNav, Segmented, type Choice } from "../../ui/layout";
import { fmtDuration } from "../../domain/me/workouts";
import { dayValues, type DayValue } from "../../domain/metrics/queries";
import { SCALE } from "../../domain/journal/entries";
import { loadProfile } from "../../domain/settings/profile";
import { dayFood, type FoodEntry } from "../../domain/food/food";
import { addMove, undoMove } from "../../domain/mealprep/mealPrep";
import { loadDashboard, pinnedAnchor, shiftSpan, spanRange, type Dashboard, type Span } from "../../domain/dashboard/dashboard";
import { nextUp, partOfDay, slotAt, type NextUp } from "../../domain/dashboard/today";
import { SyncedNumbers } from "./SyncedNumbers";
import { PinnedCharts } from "./PinnedCharts";
import { appleHealthSupported } from "../../platform/health";

const log = createLogger("dashboard");

/**
 * The last answers, kept for the app's run: the screen remounts on every tab switch, and drawing
 * the last numbers at once beats a blank screen while the database answers. Every visit still
 * reloads, so a cached view is at most one load old.
 */
interface Shown {
  data: Dashboard;
  /** The week around the day, for a day's pinned charts. */
  week: Dashboard | null;
  metrics: DayValue[];
  food: FoodEntry[];
  next: NextUp | null;
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
/** Day, week or month: the one last looked at, so coming back to Today shows the same view. */
let lastSpan: Span = "day";

/** Where Today's buttons go; the app shell switches section. */
export interface DashboardLinks {
  logFood: () => void;
  logDrink: () => void;
  /** Coach, with text to start from (the quick add); left out while Coach is off. */
  askClaude?: (draft?: string) => void;
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
  /** The header's picture (opens You) and sync state, owned by the app shell. */
  profile: ReactNode;
  sync: ReactNode;
  go: DashboardLinks;
  /** After Eat 1 portion or its Undo, so the other sections reload. */
  onChanged?: () => void;
}

const SPANS: Choice<Span>[] = [
  { id: "day", label: "Day" },
  { id: "week", label: "Week" },
  { id: "month", label: "Month" },
];

const int = (n: number) => Math.round(n).toLocaleString();
const utc = (day: string) => new Date(`${day}T12:00:00Z`);
const short = (day: string, opts: Intl.DateTimeFormatOptions) => utc(day).toLocaleDateString(undefined, { ...opts, timeZone: "UTC" });
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const SLOT_LABEL = { breakfast: "Breakfast", lunch: "Lunch", dinner: "Dinner", snack: "Snack" } as const;
const MEAL_ORDER = ["breakfast", "lunch", "dinner", "snack", "prep"];

/** "Today", "Mon 20 – Sun 26 Oct", "October 2026". */
function spanTitle(span: Span, anchor: string): string {
  const { from, to } = spanRange(span, anchor);
  if (span === "day") return cap(fmtDay(from));
  if (span === "month") return short(from, { month: "long", year: "numeric" });
  return `${short(from, { day: "numeric", month: "short" })} – ${short(to, { day: "numeric", month: "short" })}`;
}

/**
 * Today (handoff 0.7): for a day, the balance (calories left in a ring, the macros against their
 * targets), what to eat next from the meal prep, recovery from the watch, the day so far and the
 * steps of the last two weeks; for a week or a month, calories per day with a day's numbers on a
 * tap, the averages and the check-ins. Both end with the charts the owner pinned.
 */
export function DashboardScreen({ db, version, configured, syncWarnings, profile, sync, go, onChanged }: Props) {
  const [span, setSpanState] = useState<Span>(lastSpan);
  const setSpan = (s: Span) => setSpanState((lastSpan = s));
  // null = the current period, which moves on by itself when the day changes (the app can stay
  // open overnight); a past period the owner picked stays put.
  const [picked, setPicked] = useState<string | null>(null);
  const now = today();
  const anchor = picked ?? now;
  const setAnchor = (day: string, sp: Span = span) => setPicked(pinnedAnchor(sp, day, now));
  const [shown, setShown] = useState<Shown | null>(() => shownCache.get(cacheKey(span, anchor)) ?? null);
  const [local, setLocal] = useState(0);

  // Loads overlap (a sync finishing, quick taps on ‹ ›, Day / Week / Month): only the newest may
  // show, or an older, slower answer would put another period's numbers under this title.
  const begin = useRef(newestOnly()).current;
  const load = useCallback(async () => {
    const isNewest = begin();
    const key = cacheKey(span, anchor);
    const cached = shownCache.get(key);
    if (cached) setShown(cached);
    // Debug logs at Info: how long the figures and the day's lists each take on this phone.
    const timed = <T,>(what: string, p: Promise<T>) => {
      const done = log.time(`${what} loaded`, "info");
      return p.then((v) => (done({ span }), v));
    };
    const all = log.time("dashboard loaded", "info");
    performance.mark("even:dashboard-query");
    const day = span === "day";
    const [d, p, m, food, next, week] = await Promise.all([
      timed("figures", loadDashboard(db, span, anchor, today())),
      loadProfile(db),
      day ? timed("day metrics", dayValues(db, anchor)) : Promise.resolve([]),
      day ? dayFood(db, anchor) : Promise.resolve([]),
      day && anchor === today() ? nextUp(db) : Promise.resolve(null),
      day ? loadDashboard(db, "week", anchor, today()) : Promise.resolve(null),
    ]);
    all({ span, cached: Boolean(cached) });
    performance.mark("even:dashboard-data");
    const fresh = { data: d, week, metrics: m, food, next, name: p.name };
    remember(key, fresh);
    if (isNewest()) setShown(fresh);
  }, [db, span, anchor, begin]);

  useEffect(() => {
    void load();
  }, [load, version, local]);

  // Once per app run: when the first numbers are on screen (read by scripts/perf-device.mjs).
  useEffect(() => {
    if (shown && performance.getEntriesByName("even:dashboard-ready").length === 0) performance.mark("even:dashboard-ready");
  }, [shown]);

  const current = spanRange(span, anchor);
  const isCurrent = current.from <= now && now <= current.to;
  const next = shiftSpan(span, anchor, 1);
  const many = span !== "day";
  const d = shown?.data ?? null;
  const axis = span === "week" ? (day: string) => short(day, { weekday: "narrow" }) : (day: string) => String(Number(day.slice(8)));
  const openDay = (day: string) => {
    setSpan("day");
    setAnchor(day, "day");
  };
  const hour = new Date().getHours();
  const first = shown?.name?.split(" ")[0];
  const dateLine = utc(now).toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" });
  const hasAny = d && (d.steps.total !== null || d.burned.total !== null || d.eaten.total !== null || d.workouts.count > 0);
  const chartsData = many ? d : (shown?.week ?? null);

  return (
    <section className="today">
      <PageHeader
        title={many ? (isCurrent ? `This ${span}` : spanTitle(span, anchor)) : `${partOfDay(hour)}${first ? `, ${first}` : ""}`}
        subtitle={many ? `${fmtDay(current.from)} to ${fmtDay(d?.to ?? current.to)}` : dateLine}
        leading={profile}
        actions={sync}
      />

      {syncWarnings.map((w) => (
        <p key={w} className="warning small">
          {w}
        </p>
      ))}
      {!configured && !hasAny && (
        <p className="muted small">
          {appleHealthSupported ? "Connect Apple Health or add your Garmin key in You, Connections" : "Add your Garmin key in You, Connections"} to bring in
          steps and calories burned, or import your Garmin export.
        </p>
      )}

      <div className="today-controls">
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
      </div>

      <QuickAdd go={go} />

      {d && !many && shown && (
        <DayView
          db={db}
          d={d}
          shown={shown}
          day={anchor}
          isToday={anchor === now}
          hour={hour}
          go={go}
          onOpenDay={openDay}
          onChanged={() => {
            setLocal((v) => v + 1);
            onChanged?.();
          }}
        />
      )}
      {d && many && <PeriodView d={d} span={span} axis={axis} go={go} />}

      {chartsData && (
        <PinnedCharts
          db={db}
          d={chartsData}
          period={many ? (isCurrent ? `this ${span}` : spanTitle(span, anchor)) : "this week"}
          formatX={span === "month" ? axis : (day) => short(day, { weekday: "narrow" })}
          onDay={openDay}
        />
      )}

      {!many && shown && shown.metrics.length > 0 && <SyncedNumbers metrics={shown.metrics} />}
    </section>
  );
}

/**
 * Tell Even what you ate, drank or weighed (a wide screen; the phone has its Add button): while
 * Coach is on, the text opens Coach with it ready to send, and Coach logs it once the owner
 * confirms. Always, the places to log by hand.
 */
function QuickAdd({ go }: { go: DashboardLinks }) {
  const [text, setText] = useState("");
  const coach = go.askClaude;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (coach && text.trim()) coach(text.trim());
  };
  return (
    <div className="quick-add wide-only">
      {coach && (
        <form onSubmit={submit} className="quick-add-bar">
          <Icon name="plus" size={20} />
          <label className="sr-only" htmlFor="quick-add">
            Quick add
          </label>
          <input id="quick-add" value={text} onChange={(e) => setText(e.target.value)} placeholder="Tell Even what you ate, drank or weighed" />
          <button type="submit" disabled={!text.trim()}>
            Add
          </button>
        </form>
      )}
      <div className="quick-add-chips" role="group" aria-label="Log">
        <button type="button" className="chip" onClick={go.logFood}>
          Log food
        </button>
        <button type="button" className="chip" onClick={go.logDrink}>
          Log a drink
        </button>
        <button type="button" className="chip" onClick={() => go.checkIn()}>
          Check-in
        </button>
        <button type="button" className="chip" onClick={go.measurements}>
          Weight
        </button>
      </div>
    </div>
  );
}

function DayView({
  db,
  d,
  shown,
  day,
  isToday,
  hour,
  go,
  onOpenDay,
  onChanged,
}: {
  db: SqlDriver;
  d: Dashboard;
  shown: Shown;
  day: string;
  isToday: boolean;
  hour: number;
  go: DashboardLinks;
  onOpenDay: (day: string) => void;
  onChanged: () => void;
}) {
  const eaten = d.eaten.total;
  const target = d.targets.kcal;
  const left = target !== null ? target - (eaten ?? 0) : null;
  const heroLine =
    eaten === null
      ? isToday
        ? "Nothing logged yet today. Add your first meal when you are ready."
        : "Nothing was logged this day."
      : left === null
        ? `${int(eaten)} kcal eaten${isToday ? " so far" : ""}. Set a calorie target in Food and drinks to see what is left.`
        : left < 0
          ? `${int(-left)} kcal over the target${isToday ? " today" : ""}.`
          : isToday
            ? left > 600
              ? "You are on pace, with plenty of room left."
              : "Nicely balanced, with a little room left."
            : "Within the target this day.";
  return (
    <div className="today-grid">
      <section className="card balance-card" aria-label="Balance">
        <BalanceRing eaten={eaten} target={target} caption={isToday ? "kcal left today" : "kcal left"} />
        <div className="balance-side">
          <p className="balance-line">{heroLine}</p>
          <MacroBars grams={{ protein: d.protein.total, carbs: d.carbs.total, fat: d.fat.total }} targets={d.targets} />
        </div>
      </section>

      <div className="today-stack">
        {isToday && (
          <NextUpCard
            db={db}
            next={shown.next}
            left={left}
            protein={{ eaten: d.protein.total, target: d.targets.protein }}
            hour={hour}
            go={go}
            onChanged={onChanged}
          />
        )}
        <section className="today-tiles" aria-label="Recovery">
          <StatTile
            label="Sleep"
            value={d.body.sleep.total !== null ? fmtDuration(d.body.sleep.total) : null}
            note={d.body.sleepScore.total !== null ? `score ${int(d.body.sleepScore.total)}` : undefined}
          />
          <StatTile
            label="Body Battery"
            value={d.body.bodyBatteryHigh.total !== null ? int(d.body.bodyBatteryHigh.total) : null}
            note={d.body.bodyBatteryLow.total !== null ? `low ${int(d.body.bodyBatteryLow.total)}` : undefined}
          />
          <StatTile label="Resting heart rate" value={d.body.restingHr.total !== null ? `${int(d.body.restingHr.total)} bpm` : null} />
        </section>
      </div>

      <SoFar d={d} food={shown.food} day={day} isToday={isToday} go={go} />

      {d.activityTrend.steps.some((v) => v !== null) && (
        <BarChart
          title="Steps, last two weeks"
          subtitle={`${d.steps.total !== null ? `${int(d.steps.total)} ${isToday ? "today" : "this day"}. ` : ""}Tap a day to open it.`}
          x={d.trendDays}
          values={d.activityTrend.steps}
          formatX={(x) => String(Number(x.slice(8)))}
          formatXLong={(x) => fmtDay(x)}
          formatValue={int}
          selected={day}
          onSelect={onOpenDay}
        />
      )}

      <Noticed d={d} next={shown.next} go={go} isToday={isToday} />
    </div>
  );
}

/** The meal prep portion to eat next, one tap to eat it (logged as food), with Undo. */
function NextUpCard({
  db,
  next,
  left,
  protein,
  hour,
  go,
  onChanged,
}: {
  db: SqlDriver;
  next: NextUp | null;
  left: number | null;
  protein: { eaten: number | null; target: number | null };
  hour: number;
  go: DashboardLinks;
  onChanged: () => void;
}) {
  const [eaten, setEaten] = useState<{ moveId: string; name: string; leftAfter: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const slot = SLOT_LABEL[slotAt(hour)];
  if (eaten) {
    return (
      <section className="card next-done" role="status">
        <span className="next-check" aria-hidden>
          <Icon name="food" size={18} />
        </span>
        <div className="grow">
          <strong>{slot} logged</strong>
          <span className="muted small block">
            {eaten.name} · {eaten.leftAfter ? `${plural(eaten.leftAfter, "portion")} left in the fridge` : "none left in the fridge"}
          </span>
        </div>
        <button
          type="button"
          className="link"
          onClick={async () => {
            await undoMove(db, eaten.moveId);
            setEaten(null);
            onChanged();
          }}
        >
          Undo
        </button>
      </section>
    );
  }
  if (!next) return null;
  const proteinLeft = protein.target !== null ? protein.target - (protein.eaten ?? 0) : null;
  const share = next.proteinG && proteinLeft && proteinLeft > 0 ? Math.round((next.proteinG / proteinLeft) * 100) : null;
  return (
    <section className="card next-up" aria-labelledby="next-up">
      <div className="next-head">
        <span id="next-up" className="next-pill">
          Next up · {slot}
        </span>
        <span className="muted small">eat by {fmtDay(next.eatBy)}</span>
      </div>
      <div className="next-body">
        <strong className="next-name">{next.name}</strong>
        <span className="muted small">From your meal prep · {plural(next.fridge, "portion")} in the fridge</span>
        {next.kcal !== null && (
          <span className="muted small">
            {int(next.kcal)} kcal{next.proteinG !== null ? ` · ${int(next.proteinG)} g protein` : ""}
            {share !== null ? `, about ${Math.min(100, share)}% of the protein still to go` : left !== null && left > 0 ? `, ${int(left)} kcal left today` : ""}
          </span>
        )}
      </div>
      {error && <p className="error small">{error}</p>}
      <div className="next-actions">
        <button
          type="button"
          onClick={async () => {
            try {
              const moveId = await addMove(db, { batchId: next.batchId, kind: "eat", portions: 1, timeZone: timeZone() });
              setEaten({ moveId, name: next.name, leftAfter: next.fridge - 1 });
              setError(null);
              onChanged();
            } catch (err) {
              setError(err instanceof Error ? err.message : "Could not log it");
            }
          }}
        >
          Eat 1 portion
        </button>
        <button type="button" className="secondary" onClick={go.logFood}>
          Something else
        </button>
      </div>
    </section>
  );
}

/** The day's food by meal, then drinks and weight, each with a way to add. */
function SoFar({ d, food, day, isToday, go }: { d: Dashboard; food: FoodEntry[]; day: string; isToday: boolean; go: DashboardLinks }) {
  const meals = new Map<string, FoodEntry[]>();
  for (const f of [...food].sort((a, b) => a.eatenAtMs - b.eatenAtMs)) {
    const k = f.meal ?? "snack";
    meals.set(k, [...(meals.get(k) ?? []), f]);
  }
  const rows = [...meals].sort((a, b) => MEAL_ORDER.indexOf(a[0]) - MEAL_ORDER.indexOf(b[0]));
  const kcal = food.reduce((n, f) => n + (f.calories ?? 0), 0);
  const time = (ms: number) => new Date(ms).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  const label = (k: string) => (k === "prep" ? "Meal prep" : cap(k));
  const a = d.alcohol;
  return (
    <section className="card so-far" aria-labelledby="so-far">
      <div className="so-far-head">
        <h2 id="so-far">{isToday ? "Today so far" : "That day"}</h2>
        <span className="muted small">
          {plural(rows.length, "meal")} · {int(kcal)} kcal
        </span>
      </div>
      {rows.map(([k, items]) => (
        <div key={k} className="so-far-row">
          <span className="muted small">{time(items[0].eatenAtMs)}</span>
          <span className="grow">
            <strong>{label(k)}</strong>
            <span className="muted small block clamp">{items.map((i) => i.name).join(", ")}</span>
          </span>
          <span className="so-far-num">{int(items.reduce((n, i) => n + (i.calories ?? 0), 0))}</span>
        </div>
      ))}
      <button type="button" className="so-far-row add" onClick={go.logFood}>
        <span />
        <span className="grow">
          <strong>{rows.length ? "Something else" : "Food"}</strong>
          <span className="muted small block">{rows.length ? "Add a meal or a snack" : "Nothing yet"}</span>
        </span>
        <span className="accent">+ Add</span>
      </button>
      <button type="button" className="so-far-row add" onClick={go.logDrink}>
        <span />
        <span className="grow">
          <strong>Drinks</strong>
          <span className="muted small block">
            {a.drinks ? `${plural(a.drinks, "drink")} · ${int(a.kcal)} kcal` : `None ${isToday ? "today" : "that day"}`}
          </span>
        </span>
        <span className="accent">+ Add</span>
      </button>
      <button type="button" className="so-far-row add" onClick={go.measurements}>
        <span />
        <span className="grow">
          <strong>Weight</strong>
          <span className="muted small block">
            {d.journal.weight ? `${d.journal.weight.kg.toFixed(1)} kg · ${fmtDay(d.journal.weight.day, day)}` : "Not logged"}
          </span>
        </span>
        <span className="accent">{d.journal.weight?.day === day ? "" : "+ Add"}</span>
      </button>
    </section>
  );
}

/** One thing worth a look, worked out on this device from the day's numbers (nothing is sent anywhere). */
function Noticed({ d, next, go, isToday }: { d: Dashboard; next: NextUp | null; go: DashboardLinks; isToday: boolean }) {
  const p = d.protein.total ?? 0;
  const pt = d.targets.protein;
  let text: string | null = null;
  if (pt && p < pt) {
    text = `Protein is the gap ${isToday ? "today" : "that day"}, with ${int(pt - p)} g to go.`;
    if (isToday && next?.proteinG) text += ` ${next.name} covers ${int(next.proteinG)} g of it.`;
  } else if (d.targets.steps && d.steps.total !== null && d.steps.total < d.targets.steps) {
    text = `${int(d.targets.steps - d.steps.total)} steps to your goal ${isToday ? "today" : "that day"}.`;
  }
  if (!text) return null;
  return (
    <section className="card noticed" aria-labelledby="noticed">
      <div className="grow">
        <h2 id="noticed">Worth a look</h2>
        <p>{text}</p>
      </div>
      {go.askClaude && (
        <button type="button" className="secondary" onClick={() => go.askClaude!()}>
          Ask Coach for ideas
        </button>
      )}
    </section>
  );
}

const word = (v: number) => SCALE[Math.min(5, Math.max(1, Math.round(v))) - 1].toLowerCase();

/** A week or a month: calories per day (a tap shows that day's numbers), the averages, and the check-ins. */
function PeriodView({ d, span, axis, go }: { d: Dashboard; span: Span; axis: (day: string) => string; go: DashboardLinks }) {
  const days = d.days;
  const [sel, setSel] = useState<string | null>(null);
  const pickDay = sel ?? [...days].reverse().find((r) => r.eatenKcal !== null)?.day ?? days[days.length - 1]?.day ?? null;
  const r = days.find((x) => x.day === pickDay);
  const j = d.journal;
  const avg = (f: { avg: number | null }, fmt: (n: number) => string = int) => (f.avg !== null ? fmt(f.avg) : null);
  return (
    <div className="today-grid period">
      <section className="period-days" aria-label="Calories each day">
        <BarChart
          title="Calories each day"
          subtitle={d.targets.kcal ? `target ${int(d.targets.kcal)}` : undefined}
          x={days.map((x) => x.day)}
          values={days.map((x) => x.eatenKcal)}
          formatX={axis}
          formatXLong={(x) => fmtDay(x)}
          formatValue={int}
          unit="kcal"
          target={d.targets.kcal}
          selected={pickDay}
          onSelect={setSel}
        />
        {r && (
          <div className="card period-pick">
            <strong>{cap(fmtDay(r.day))}</strong>
            <span>
              Calories<b>{r.eatenKcal !== null ? int(r.eatenKcal) : "–"}</b>
            </span>
            <span>
              Protein<b>{r.proteinG !== null ? `${int(r.proteinG)} g` : "–"}</b>
            </span>
            <span>
              Steps<b>{r.steps !== null ? int(r.steps) : "–"}</b>
            </span>
            <span>
              Workouts<b>{r.workouts}</b>
            </span>
          </div>
        )}
      </section>
      <section className="today-tiles four" aria-label="Averages">
        <StatTile label="Average calories" value={avg(d.eaten)} note={d.targets.kcal ? `target ${int(d.targets.kcal)}` : undefined} />
        <StatTile
          label="Average protein"
          value={avg(d.protein, (n) => `${int(n)} g`)}
          note={d.targets.protein ? `goal ${int(d.targets.protein)} g` : undefined}
        />
        <StatTile label="Average steps" value={avg(d.steps)} note={d.targets.steps ? `goal ${int(d.targets.steps)}` : undefined} />
        <StatTile
          label="Average sleep"
          value={avg(d.body.sleep, fmtDuration)}
          note={d.body.sleepScore.avg !== null ? `score ${int(d.body.sleepScore.avg)}` : undefined}
        />
      </section>
      <section className="card period-journal" aria-labelledby="period-journal">
        <div className="so-far-head">
          <h2 id="period-journal">Check-ins</h2>
          <button type="button" className="link accent small" onClick={() => go.checkIn()}>
            Journal ›
          </button>
        </div>
        <p className="muted small">
          {j.notes.length ? `${plural(j.notes.length, "day")} with a note` : `No notes this ${span}`}
          {j.mood.avg !== null ? ` · mood about ${word(j.mood.avg)}` : ""}
          {j.energy.avg !== null ? `, energy about ${word(j.energy.avg)}` : ""}
        </p>
        <button type="button" className="link small" onClick={go.measurements}>
          {j.weight ? `Weight ${j.weight.kg.toFixed(1)} kg · ${fmtDay(j.weight.day)}` : "Log your weight"}
        </button>
      </section>
    </div>
  );
}
