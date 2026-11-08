import { useState } from "react";
import { addDays } from "../../core/tz";
import { BarChart } from "../../ui/charts";
import { fmtDay, plural, today } from "../../ui/common";
import { ChipGroup } from "../../ui/controls";
import { seriesColor } from "../../ui/charts";
import { Icon, type IconName } from "../../ui/icons";
import { SectionHeader } from "../../ui/layout";
import { activityLabel, SPORT_LABEL, type SportId } from "../../domain/me/sports";
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
} from "../../domain/me/workouts";

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
        <p className="muted small">No workouts yet. They arrive from your watch with the Garmin sync, or from the Garmin import in You › Connections.</p>
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

/** Each sport's badge: an icon and a fixed color slot, so running looks the same in every list. */
const SPORT_MARK: Record<SportId, { icon: IconName; slot: number }> = {
  running: { icon: "steps", slot: 1 },
  walking: { icon: "steps", slot: 3 },
  hiking: { icon: "steps", slot: 6 },
  cycling: { icon: "bike", slot: 2 },
  swimming: { icon: "wave", slot: 7 },
  strength: { icon: "workout", slot: 4 },
  yoga: { icon: "sparkle", slot: 5 },
  cardio: { icon: "flame", slot: 8 },
  team: { icon: "flame", slot: 2 },
  winter: { icon: "wave", slot: 7 },
  other: { icon: "workout", slot: 4 },
};

/** Garmin's training effect, 0 to 5, as five steps filled to the value, with its number and word. */
function TrainingEffect({ label, value }: { label: string; value: number }) {
  return (
    <div className="te">
      <div className="row">
        <span className="small muted grow">{label}</span>
        <strong className="small">
          {value.toFixed(1)} <span className="muted">{trainingEffectLabel(value)}</span>
        </strong>
      </div>
      <div className="te-steps" role="meter" aria-label={`${label} ${value.toFixed(1)} of 5`} aria-valuemin={0} aria-valuemax={5} aria-valuenow={value}>
        {[1, 2, 3, 4, 5].map((n) => (
          <span key={n} style={{ ["--fill" as string]: `${Math.max(0, Math.min(1, value - (n - 1))) * 100}%` }} />
        ))}
      </div>
    </div>
  );
}

/**
 * One session as a card: the sport's badge, what and when, the headline number (distance, or time
 * without one) large with time, pace or speed and heart rate beside it. Tap it for the rest the
 * watch measured, as small tiles, and training effect as a 0-5 scale.
 */
export function WorkoutRow({ w }: { w: Workout }) {
  const mark = SPORT_MARK[w.sport];
  const speed = w.sport === "cycling" ? fmtSpeed(w.durationS, w.distanceM) : fmtPace(w.durationS, w.distanceM);
  const hero = w.distanceM ? fmtDistance(w.distanceM) : w.durationS ? fmtDuration(w.durationS) : null;
  const side = [
    w.distanceM && w.durationS ? fmtDuration(w.durationS) : null,
    speed,
    w.avgHr ? `♥ ${Math.round(w.avgHr)} bpm` : null,
    !w.distanceM && w.kcal ? `${Math.round(w.kcal)} kcal` : null,
  ].filter(Boolean);
  const more = [
    w.maxHr ? { k: "Max HR", v: `${Math.round(w.maxHr)} bpm` } : null,
    w.distanceM && w.kcal ? { k: "Calories", v: `${Math.round(w.kcal)} kcal` } : null,
    w.movingS && w.durationS && w.movingS < w.durationS - 30 ? { k: "Moving", v: fmtDuration(w.movingS) } : null,
    w.elevationM ? { k: "Climb", v: `${Math.round(w.elevationM)} m` } : null,
    w.steps ? { k: "Steps", v: Math.round(w.steps).toLocaleString() } : null,
    w.vo2Max ? { k: "VO2 max", v: String(Math.round(w.vo2Max)) } : null,
  ].filter((x): x is { k: string; v: string } => x !== null);
  const hasMore = more.length > 0 || w.aerobicTe !== null || w.anaerobicTe !== null;

  const head = (
    <div className="workout">
      <span className="sport-badge" style={{ ["--sport" as string]: seriesColor(mark.slot) }} aria-hidden>
        <Icon name={mark.icon} size={20} />
      </span>
      <div className="grow workout-body">
        <div className="row">
          <strong className="grow">{activityLabel(w.type)}</strong>
          <span className="muted small">
            {fmtDayYear(w.day)}
            {w.startMs !== null && ` · ${clock(w.startMs)}`}
          </span>
        </div>
        <div className="workout-main">
          {hero && <span className="workout-hero">{hero}</span>}
          {side.length > 0 && <span className="muted small">{side.join(" · ")}</span>}
        </div>
      </div>
      {hasMore && <Icon name="chevron" size={18} />}
    </div>
  );
  if (!hasMore) return head;
  return (
    <details className="workout-more">
      <summary>{head}</summary>
      <div className="workout-extra">
        {more.length > 0 && (
          <dl className="workout-tiles">
            {more.map((s) => (
              <div key={s.k}>
                <dt className="small muted">{s.k}</dt>
                <dd>{s.v}</dd>
              </div>
            ))}
          </dl>
        )}
        {w.aerobicTe !== null && <TrainingEffect label="Aerobic training effect" value={w.aerobicTe} />}
        {w.anaerobicTe !== null && <TrainingEffect label="Anaerobic training effect" value={w.anaerobicTe} />}
      </div>
    </details>
  );
}
