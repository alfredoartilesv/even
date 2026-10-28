import { useState } from "react";
import { addDays } from "../../core/tz";
import { BarChart } from "../../ui/charts";
import { fmtDay, plural, today } from "../../ui/common";
import { ChipGroup } from "../../ui/controls";
import { SectionHeader } from "../../ui/layout";
import { activityLabel, SPORT_LABEL, type SportId } from "./sports";
import {
  byMonth,
  fmtDistance,
  fmtDuration,
  fmtPace,
  fmtSpeed,
  personalBests,
  sportTotals,
  trainingEffectLabel,
  weeklyVolume,
  weekOf,
  type Workout,
} from "./workouts";

const RANGES = [
  { id: 30, label: "30 days" },
  { id: 90, label: "90 days" },
  { id: 365, label: "1 year" },
  { id: 0, label: "All" },
];
const PAGE = 10;
const WEEKS = 12;

const utc = (day: string) => new Date(`${day}T12:00:00Z`);
const monthTitle = (m: string) => utc(`${m}-15`).toLocaleDateString(undefined, { month: "long", year: "numeric", timeZone: "UTC" });
const hours = (s: number) => s / 3600;

/** "Sat 17 Oct", with the year added when it is not this year. */
export function fmtDayYear(day: string): string {
  const d = fmtDay(day);
  return day.slice(0, 4) === today().slice(0, 4) ? d : `${d} ${day.slice(0, 4)}`;
}

/**
 * Past workouts, from the Garmin sync or import: a range and a sport to look at, training time
 * per week for the last 12 weeks, totals per sport, longest sessions, then every session by month,
 * ten at a time. A session opens to show what the watch measured beyond the basics (max heart rate,
 * climb, training effect, VO2 max...).
 */
export function ActivityHistory({ workouts, mySports }: { workouts: Workout[]; mySports: SportId[] }) {
  const [range, setRange] = useState(90);
  const [sport, setSport] = useState<SportId | "all">("all");
  const [shown, setShown] = useState(PAGE);
  // A week tapped on the chart: the list shows that week's sessions instead of the range.
  const [week, setWeek] = useState<string | null>(null);
  const day = today();

  const inRange = range ? workouts.filter((w) => w.day > addDays(day, -range)) : workouts;
  const present = sportTotals(workouts).map((t) => t.sport);
  // The owner's sports first, in their order, then the rest by time.
  const sportOrder = [...mySports.filter((s) => present.includes(s)), ...present.filter((s) => !mySports.includes(s))];
  const pick = (ws: Workout[]) => (sport === "all" ? ws : ws.filter((w) => w.sport === sport));
  const list = week ? pick(workouts).filter((w) => weekOf(w.day) === week) : pick(inRange);
  const weeks = weeklyVolume(pick(workouts), day, WEEKS);
  const totals = sportTotals(inRange).sort((a, b) => sportOrder.indexOf(a.sport) - sportOrder.indexOf(b.sport));
  const bests = personalBests(pick(workouts)).filter((b) => b.longestDistance || b.longestTime);
  const thisWeek = weeks.at(-1)!;
  const prior = weeks.slice(-5, -1);
  const usual = prior.length ? prior.reduce((s, w) => s + w.durationS, 0) / prior.length : 0;

  if (!workouts.length) {
    return (
      <>
        <SectionHeader title="Activities" />
        <p className="muted small">No workouts yet. They arrive from your watch with the Garmin sync, or from the Garmin import in Settings › Connections.</p>
      </>
    );
  }

  return (
    <>
      <SectionHeader title="Activities" />
      {sportOrder.length > 1 && (
        <ChipGroup
          label="Sport"
          options={[{ id: "all" as const, label: "All sports" }, ...sportOrder.map((s) => ({ id: s, label: SPORT_LABEL[s] }))]}
          value={sport}
          onChange={(s) => {
            setSport(s);
            setShown(PAGE);
            setWeek(null);
          }}
        />
      )}

      <BarChart
        title="Training time per week"
        subtitle={`Last ${WEEKS} weeks${sport === "all" ? "" : `, ${SPORT_LABEL[sport].toLowerCase()}`}, tap a week for its sessions`}
        x={weeks.map((w) => w.week)}
        values={weeks.map((w) => (w.sessions ? hours(w.durationS) : null))}
        formatX={(w) => String(utc(w).getUTCDate())}
        formatXLong={(w) => `Week of ${fmtDayYear(w)}`}
        formatValue={(h) => fmtDuration(h * 3600)}
        selected={week ?? weekOf(day)}
        onSelect={(w) => {
          setWeek(w === week ? null : w);
          setShown(PAGE);
        }}
        height={150}
      />
      <p className="muted small">
        This week: {thisWeek.sessions ? `${plural(thisWeek.sessions, "session")}, ${fmtDuration(thisWeek.durationS)}` : "nothing yet"}
        {usual > 0 && ` · usually ${fmtDuration(usual)} a week (last 4 weeks)`}
      </p>

      {week ? (
        <div className="chips">
          <button type="button" className="chip active" onClick={() => setWeek(null)} aria-label="Show the whole range again">
            Week of {fmtDayYear(week)} ×
          </button>
        </div>
      ) : (
        <ChipGroup
          label="Activities range"
          options={RANGES}
          value={range}
          onChange={(r) => {
            setRange(r);
            setShown(PAGE);
          }}
        />
      )}

      {sport === "all" && !week && totals.length > 0 && (
        <div className="stack tight">
          {totals.map((t) => (
            <button key={t.sport} type="button" className="card sport-total link-card" onClick={() => setSport(t.sport)}>
              <div className="row">
                <strong className="grow">{SPORT_LABEL[t.sport]}</strong>
                {mySports.includes(t.sport) && <span className="muted small">your sport</span>}
              </div>
              <dl className="stat-row">
                <div>
                  <dt>Sessions</dt>
                  <dd>{t.sessions}</dd>
                </div>
                <div>
                  <dt>Time</dt>
                  <dd>{fmtDuration(t.durationS)}</dd>
                </div>
                {t.distanceM > 0 && (
                  <div>
                    <dt>Distance</dt>
                    <dd>{fmtDistance(t.distanceM)}</dd>
                  </div>
                )}
                {t.kcal > 0 && (
                  <div>
                    <dt>Calories</dt>
                    <dd>{Math.round(t.kcal).toLocaleString()}</dd>
                  </div>
                )}
              </dl>
            </button>
          ))}
        </div>
      )}

      {bests.length > 0 && (
        <>
          <h3 className="group-head">Longest sessions</h3>
          <ul className="plain">
            {bests.map((b) => (
              <li key={b.sport} className="small">
                <strong>{SPORT_LABEL[b.sport]}</strong>:{" "}
                {b.longestDistance ? (
                  <>
                    {fmtDistance(b.longestDistance.distanceM!)}
                    <span className="muted"> · {fmtDayYear(b.longestDistance.day)}</span>
                  </>
                ) : null}
                {b.longestTime && b.longestTime !== b.longestDistance && (
                  <span className={b.longestDistance ? "muted" : undefined}>
                    {b.longestDistance ? " · longest time " : ""}
                    {fmtDuration(b.longestTime.durationS!)}
                    {!b.longestDistance && <span className="muted"> · {fmtDayYear(b.longestTime.day)}</span>}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </>
      )}

      <h3 className="group-head">
        Sessions <span className="muted small">· {plural(list.length, "workout")}</span>
      </h3>
      {list.length === 0 ? (
        <p className="muted small">
          No {sport === "all" ? "workouts" : SPORT_LABEL[sport].toLowerCase()} {week ? "that week" : "in this range"}.
        </p>
      ) : (
        byMonth(list.slice(0, shown)).map((m) => (
          <div key={m.month}>
            <div className="row month-head">
              <strong className="small">{monthTitle(m.month)}</strong>
              <span className="muted small">
                {plural(m.items.length, "session")} · {fmtDuration(m.items.reduce((s, w) => s + (w.durationS ?? 0), 0))}
              </span>
            </div>
            <ul className="workouts">
              {m.items.map((w) => (
                <li key={w.key}>
                  <WorkoutRow w={w} />
                </li>
              ))}
            </ul>
          </div>
        ))
      )}
      {list.length > shown && (
        <button type="button" className="secondary wide-button" onClick={() => setShown(shown + PAGE * 2)}>
          Show more ({list.length - shown} older)
        </button>
      )}
    </>
  );
}

const clock = (ms: number) => new Date(ms).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
const te = (v: number | null) => (v === null ? null : v.toFixed(1));

/** One session: what and when on top, its main numbers in columns; tap for everything the watch measured. */
export function WorkoutRow({ w }: { w: Workout }) {
  const speed = w.sport === "cycling" ? fmtSpeed(w.durationS, w.distanceM) : fmtPace(w.durationS, w.distanceM);
  const stats = [
    w.distanceM ? { k: "Distance", v: fmtDistance(w.distanceM) } : null,
    w.durationS ? { k: "Time", v: fmtDuration(w.durationS) } : null,
    speed ? { k: w.sport === "cycling" ? "Speed" : "Pace", v: speed } : null,
    w.avgHr ? { k: "Avg HR", v: `${Math.round(w.avgHr)} bpm` } : null,
    !speed && w.kcal ? { k: "Calories", v: `${Math.round(w.kcal)} kcal` } : null,
  ].filter((x): x is { k: string; v: string } => x !== null);
  const more = [
    w.maxHr ? { k: "Max HR", v: `${Math.round(w.maxHr)} bpm` } : null,
    speed && w.kcal ? { k: "Calories", v: `${Math.round(w.kcal)} kcal` } : null,
    w.movingS && w.durationS && w.movingS < w.durationS - 30 ? { k: "Moving", v: fmtDuration(w.movingS) } : null,
    w.elevationM ? { k: "Climb", v: `${Math.round(w.elevationM)} m` } : null,
    w.steps ? { k: "Steps", v: Math.round(w.steps).toLocaleString() } : null,
    w.aerobicTe !== null ? { k: "Aerobic TE", v: `${te(w.aerobicTe)} ${trainingEffectLabel(w.aerobicTe)}` } : null,
    w.anaerobicTe !== null ? { k: "Anaerobic TE", v: te(w.anaerobicTe)! } : null,
    w.vo2Max ? { k: "VO2 max", v: String(Math.round(w.vo2Max)) } : null,
  ].filter((x): x is { k: string; v: string } => x !== null);
  const head = (
    <>
      <div className="row">
        <strong className="grow">{activityLabel(w.type)}</strong>
        <span className="muted small">
          {fmtDayYear(w.day)}
          {w.startMs !== null && `, ${clock(w.startMs)}`}
        </span>
      </div>
      {stats.length > 0 && (
        <dl className="stat-row">
          {stats.map((s) => (
            <div key={s.k}>
              <dt>{s.k}</dt>
              <dd>{s.v}</dd>
            </div>
          ))}
        </dl>
      )}
    </>
  );
  if (!more.length) return head;
  return (
    <details className="workout-more">
      <summary>{head}</summary>
      <dl className="stat-row">
        {more.map((s) => (
          <div key={s.k}>
            <dt>{s.k}</dt>
            <dd>{s.v}</dd>
          </div>
        ))}
      </dl>
    </details>
  );
}
