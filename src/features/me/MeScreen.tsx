import { useCallback, useEffect, useState, type FormEvent } from "react";
import { ageOn } from "../../core/health";
import { addDays } from "../../core/tz";
import type { SqlDriver } from "../../db/driver";
import { deviceId } from "../../db/settings";
import { Meter, StatTile } from "../../ui/charts";
import { failed, fmtDay, MsgLine, plural, today, type Msg } from "../../ui/common";
import { StatusBadge, type Status as BadgeStatus } from "../../ui/controls";
import { latestWeight, type Weight } from "../alcohol/alcohol";
import { insertGoal } from "../journal/journal";
import { loadProfile, loadProfilePhoto, saveProfile, saveProfilePhoto, EMPTY_PROFILE, type Profile } from "../settings/profile";
import { fmtGoalValue, GOAL_TEMPLATES } from "./goalTemplates";
import { deleteGoal, goalProgress, listGoals, type Goal, type Progress, type Status } from "./goals";
import { activityLabel, SPORT_LABEL, SPORTS, type SportId } from "./sports";
import { Avatar, squarePhoto } from "./ui/avatar";
import { fmtDistance, fmtDuration, fmtPace, fmtSpeed, listWorkouts, personalBests, sportTotals, type Workout } from "./workouts";

const STATUS: Record<Status, { badge: BadgeStatus; word: string }> = {
  met: { badge: "good", word: "met" },
  on_track: { badge: "good", word: "on track" },
  behind: { badge: "warning", word: "not yet" },
  missed: { badge: "critical", word: "over" },
  no_data: { badge: "info", word: "no data yet" },
};
const PERIOD_WORD = { day: "today", week: "this week", month: "this month" } as const;
const RANGES = [
  { days: 30, label: "30 days" },
  { days: 365, label: "1 year" },
  { days: 0, label: "All" },
];

/**
 * The owner's own page: picture, name and body numbers, their sports, goals with progress,
 * and their workouts (totals per sport, personal bests, recent sessions).
 */
export function MeScreen({ db, version, onEditProfile, onChanged }: { db: SqlDriver; version: number; onEditProfile: () => void; onChanged: () => void }) {
  const [profile, setProfile] = useState<Profile>(EMPTY_PROFILE);
  const [photo, setPhoto] = useState<string | null>(null);
  const [weight, setWeight] = useState<Weight | null>(null);
  const [goals, setGoals] = useState<{ goal: Goal; progress: Progress | null }[]>([]);
  const [workouts, setWorkouts] = useState<Workout[]>([]);
  const [range, setRange] = useState(30);
  const [msg, setMsg] = useState<Msg>(null);
  const [editingSports, setEditingSports] = useState(false);
  const [sportsDraft, setSportsDraft] = useState<SportId[]>([]);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  const [template, setTemplate] = useState(GOAL_TEMPLATES[0].id);
  const [targetText, setTargetText] = useState(String(GOAL_TEMPLATES[0].defaultValue));
  const [customTitle, setCustomTitle] = useState("");
  const [goalMsg, setGoalMsg] = useState<Msg>(null);

  const load = useCallback(async () => {
    const day = today();
    const [p, ph, w, g, ws] = await Promise.all([loadProfile(db), loadProfilePhoto(db), latestWeight(db, day), listGoals(db, day), listWorkouts(db, "1900-01-01", day)]);
    setProfile(p);
    setPhoto(ph);
    setWeight(w);
    setWorkouts(ws);
    setGoals(await Promise.all(g.map(async (goal) => ({ goal, progress: await goalProgress(db, goal, day) }))));
  }, [db]);

  useEffect(() => {
    void load();
  }, [load, version]);

  async function pickPhoto(file: File | undefined) {
    if (!file) return;
    try {
      const url = await squarePhoto(file);
      await saveProfilePhoto(db, url);
      setPhoto(url);
      setMsg(null);
      onChanged();
    } catch (err) {
      setMsg(failed(err, "me.photo"));
    }
  }

  async function saveSports() {
    try {
      setProfile(await saveProfile(db, { ...profile, sports: sportsDraft }, today()));
      setEditingSports(false);
    } catch (err) {
      setMsg(failed(err, "me.sports"));
    }
  }

  async function addGoal(e: FormEvent) {
    e.preventDefault();
    try {
      const stamp = { createdBy: "user" as const, deviceId: await deviceId(db) };
      if (template === "custom") {
        const title = customTitle.trim();
        if (!title) throw new Error("Write the goal first");
        await insertGoal(db, { title: title.slice(0, 120), targetKind: "none", period: "day", startDay: today() }, stamp);
        setCustomTitle("");
      } else {
        const t = GOAL_TEMPLATES.find((x) => x.id === template)!;
        const v = Number(targetText);
        if (!Number.isFinite(v) || v < t.min || v > t.max) throw new Error(`${t.ask} must be between ${t.min} and ${t.max}`);
        await insertGoal(db, t.build(v, today()), stamp);
      }
      setGoalMsg({ kind: "ok", text: "Goal added." });
      await load();
    } catch (err) {
      setGoalMsg(failed(err, "me.goals"));
    }
  }

  const day = today();
  const age = profile.birthDate ? ageOn(profile.birthDate, day) : null;
  const facts = [age !== null && `${age} years`, profile.heightCm !== null && `${profile.heightCm} cm`, weight && `${weight.kg.toFixed(1)} kg`].filter(Boolean).join(" · ");

  const last30 = workouts.filter((w) => w.day > addDays(day, -30));
  const inRange = range ? workouts.filter((w) => w.day > addDays(day, -range)) : workouts;
  const mine = (s: SportId) => profile.sports.indexOf(s);
  const totals = sportTotals(inRange).sort((a, b) => {
    const ma = mine(a.sport);
    const mb = mine(b.sport);
    return ma >= 0 && mb >= 0 ? ma - mb : ma >= 0 ? -1 : mb >= 0 ? 1 : 0;
  });
  const bests = personalBests(workouts).filter((b) => b.longestDistance && (profile.sports.length === 0 || profile.sports.includes(b.sport)));
  const measurable = goals.filter((g) => g.progress);
  const metNow = measurable.filter((g) => g.progress!.status === "met" || g.progress!.status === "on_track").length;
  const tpl = GOAL_TEMPLATES.find((t) => t.id === template);

  return (
    <section>
      <div className="me-head">
        <label className="avatar-pick" title="Change picture">
          <Avatar photo={photo} name={profile.name} />
          <input type="file" accept="image/*" onChange={(e) => void pickPhoto(e.target.files?.[0])} aria-label="Change profile picture" />
        </label>
        <div className="grow">
          <h2>{profile.name ?? "You"}</h2>
          {facts && <div className="muted small">{facts}</div>}
          <div className="actions compact">
            <button className="secondary" onClick={onEditProfile}>
              Edit profile
            </button>
            {photo && (
              <button
                className="secondary"
                onClick={async () => {
                  await saveProfilePhoto(db, null);
                  setPhoto(null);
                  onChanged();
                }}
              >
                Remove picture
              </button>
            )}
          </div>
        </div>
      </div>
      <MsgLine msg={msg} />

      <div className="row">
        <h3>My sports</h3>
        {!editingSports && (
          <button
            className="link small"
            onClick={() => {
              setSportsDraft(profile.sports);
              setEditingSports(true);
            }}
          >
            {profile.sports.length ? "Edit" : "Choose"}
          </button>
        )}
      </div>
      {editingSports ? (
        <div className="stack tight">
          <p className="muted small">Tap in the order you like them. They come first in your activities.</p>
          <div className="chips">
            {SPORTS.map((s) => {
              const i = sportsDraft.indexOf(s.id);
              return (
                <button
                  key={s.id}
                  type="button"
                  className={i >= 0 ? "chip active" : "chip"}
                  aria-pressed={i >= 0}
                  onClick={() => setSportsDraft(i >= 0 ? sportsDraft.filter((x) => x !== s.id) : [...sportsDraft, s.id])}
                >
                  {i >= 0 ? `${i + 1}. ` : ""}
                  {s.label}
                </button>
              );
            })}
          </div>
          <div className="actions">
            <button onClick={saveSports}>Save</button>
            <button className="secondary" onClick={() => setEditingSports(false)}>
              Cancel
            </button>
          </div>
        </div>
      ) : profile.sports.length ? (
        <div className="chips">
          {profile.sports.map((s) => (
            <span key={s} className="chip static">
              {SPORT_LABEL[s]}
            </span>
          ))}
        </div>
      ) : (
        <p className="muted small">Pick the sports you do, and they lead your activities below.</p>
      )}

      <div className="viz-tiles pairs">
        <StatTile label="Workouts" value={String(last30.length)} note="last 30 days" />
        <StatTile label="Active time" value={last30.length ? fmtDuration(last30.reduce((s, w) => s + (w.durationS ?? 0), 0)) : null} note="last 30 days" />
        <StatTile label="Distance" value={last30.some((w) => w.distanceM) ? fmtDistance(last30.reduce((s, w) => s + (w.distanceM ?? 0), 0)) : null} note="last 30 days" />
        <StatTile label="Goals" value={measurable.length ? `${metNow} of ${measurable.length}` : null} note={measurable.length ? "met or on track" : goals.length ? "none with a number" : "none yet"} />
      </div>

      <h2>Goals</h2>
      {goals.length === 0 && <p className="muted small">No goals yet. Add one below, or ask the assistant to set one up with you.</p>}
      {goals.map(({ goal: g, progress: p }) => (
        <div key={g.id} className="card">
          <div className="row">
            <strong className="grow">{g.title}</strong>
            {p && <StatusBadge status={STATUS[p.status].badge}>{STATUS[p.status].word}</StatusBadge>}
          </div>
          {p && g.targetNum !== null && (
            <>
              <div className="small">
                {p.current === null ? `Nothing ${PERIOD_WORD[g.period]} yet` : `${fmtGoalValue(g, p.current)} ${PERIOD_WORD[g.period]}`}
                <span className="muted">
                  {" "}
                  · target {g.comparator === "<=" ? "at most" : "at least"} {fmtGoalValue(g, g.targetNum)}
                </span>
              </div>
              {p.fraction !== null && <Meter value={p.current ?? 0} max={g.targetNum} label={g.title} />}
              {p.last7 && (
                <div className="muted small">
                  Met {p.last7.met} of the last {p.last7.withData} days with data{p.streak ? ` · ${plural(p.streak, "day")} in a row` : ""}
                </div>
              )}
            </>
          )}
          {!p && <div className="muted small">Since {fmtDay(g.startDay)}{g.notes ? ` · ${g.notes}` : ""}</div>}
          <div className="actions compact">
            {confirmDelete === g.id ? (
              <>
                <button
                  className="secondary danger"
                  onClick={async () => {
                    await deleteGoal(db, g.id);
                    setConfirmDelete(null);
                    await load();
                  }}
                >
                  Delete goal
                </button>
                <button className="secondary" onClick={() => setConfirmDelete(null)}>
                  Keep
                </button>
              </>
            ) : (
              <button className="secondary" onClick={() => setConfirmDelete(g.id)}>
                Delete…
              </button>
            )}
          </div>
        </div>
      ))}
      <form onSubmit={addGoal} className="stack">
        <div className="grid">
          <label>
            New goal
            <select
              value={template}
              onChange={(e) => {
                setTemplate(e.target.value);
                const t = GOAL_TEMPLATES.find((x) => x.id === e.target.value);
                if (t) setTargetText(String(t.defaultValue));
              }}
            >
              {GOAL_TEMPLATES.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.label}
                </option>
              ))}
              <option value="custom">Something else (no number)</option>
            </select>
          </label>
          {tpl ? (
            <label>
              {tpl.ask}
              <input inputMode="decimal" value={targetText} onChange={(e) => setTargetText(e.target.value)} />
            </label>
          ) : (
            <label>
              Goal
              <input value={customTitle} onChange={(e) => setCustomTitle(e.target.value)} placeholder="e.g. Run a half marathon" maxLength={120} />
            </label>
          )}
        </div>
        <button type="submit">Add goal</button>
        <MsgLine msg={goalMsg} />
      </form>

      <h2>Activities</h2>
      <div className="chips" role="radiogroup" aria-label="Activities range">
        {RANGES.map((r) => (
          <button key={r.days} type="button" role="radio" aria-checked={range === r.days} className={range === r.days ? "chip active" : "chip"} onClick={() => setRange(r.days)}>
            {r.label}
          </button>
        ))}
      </div>
      {totals.length === 0 ? (
        <p className="muted small">No workouts {range ? `in the last ${range === 365 ? "year" : `${range} days`}` : "yet"}. They arrive from your watch with the Garmin sync, or from the Garmin import.</p>
      ) : (
        <div className="stack tight">
          {totals.map((t) => (
            <div key={t.sport} className="card sport-total">
              <div className="row">
                <strong className="grow">{SPORT_LABEL[t.sport]}</strong>
                {mine(t.sport) >= 0 && <span className="muted small">your sport</span>}
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
              </dl>
            </div>
          ))}
        </div>
      )}

      {bests.length > 0 && (
        <>
          <h3 className="group-head">Longest sessions</h3>
          <ul className="plain">
            {bests.map((b) => (
              <li key={b.sport} className="small">
                <strong>{SPORT_LABEL[b.sport]}</strong>: {fmtDistance(b.longestDistance!.distanceM!)}
                <span className="muted"> · {fmtDayYear(b.longestDistance!.day)}</span>
                {b.longestTime && b.longestTime !== b.longestDistance && <span className="muted"> · longest time {fmtDuration(b.longestTime.durationS!)}</span>}
              </li>
            ))}
          </ul>
        </>
      )}

      {workouts.length > 0 && (
        <>
          <h3 className="group-head">Recent workouts</h3>
          <ul className="workouts">
            {workouts.slice(0, 8).map((w) => (
              <li key={w.key}>
                <WorkoutRow w={w} />
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

/** "Sat 17 Oct", with the year added when it is not this year. */
function fmtDayYear(day: string): string {
  const d = fmtDay(day);
  return day.slice(0, 4) === today().slice(0, 4) ? d : `${d} ${day.slice(0, 4)}`;
}

/** One session: what and when on top, then its numbers in labelled columns. */
function WorkoutRow({ w }: { w: Workout }) {
  const speed = w.sport === "cycling" ? fmtSpeed(w.durationS, w.distanceM) : fmtPace(w.durationS, w.distanceM);
  const stats = [
    w.distanceM ? { k: "Distance", v: fmtDistance(w.distanceM) } : null,
    w.durationS ? { k: "Time", v: fmtDuration(w.durationS) } : null,
    speed ? { k: w.sport === "cycling" ? "Speed" : "Pace", v: speed } : null,
    w.avgHr ? { k: "Avg HR", v: `${Math.round(w.avgHr)} bpm` } : null,
    !speed && w.kcal ? { k: "Calories", v: `${Math.round(w.kcal)} kcal` } : null,
  ].filter((x): x is { k: string; v: string } => x !== null);
  return (
    <>
      <div className="row">
        <strong className="grow">{activityLabel(w.type)}</strong>
        <span className="muted small">{fmtDayYear(w.day)}</span>
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
      {speed && w.kcal ? <div className="muted small">{Math.round(w.kcal)} kcal</div> : null}
    </>
  );
}
