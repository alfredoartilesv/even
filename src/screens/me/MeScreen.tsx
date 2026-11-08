import { fmtHeight, fmtWeight } from "../../core/units";
import { useCallback, useEffect, useState } from "react";
import { ageOn } from "../../core/health";
import { addDays } from "../../core/tz";
import type { SqlDriver } from "../../db/driver";
import { StatTile } from "../../ui/charts";
import { failed, MsgLine, today, type Msg } from "../../ui/common";
import { SectionHeader, Segmented, type Choice } from "../../ui/layout";
import { latestWeight, type Weight } from "../../domain/alcohol/alcohol";
import { loadProfile, loadProfilePhoto, saveProfile, saveProfilePhoto, EMPTY_PROFILE, type Profile } from "../../domain/settings/profile";
import { ActivityHistory } from "./ActivityHistory";
import { ActivityWeek } from "./ActivityWeek";
import { goalProgress, listGoals } from "../../domain/me/goals";
import { goalScore, GoalsView, type GoalRow } from "./GoalsView";
import { SPORT_LABEL, SPORTS, type SportId } from "../../domain/me/sports";
import { Avatar, squarePhoto } from "./avatar";
import { fmtDistance, fmtDuration, listWorkouts, type Workout } from "../../domain/me/workouts";

export type MeView = "activity" | "goals";

/** The view last open, so coming back to the profile shows it again. */
let lastView: MeView = "activity";

/** Sessions, time and distance of the workouts in (from, to]. */
function totals(ws: Workout[], from: string, to: string) {
  const in_ = ws.filter((w) => w.day > from && w.day <= to);
  return {
    sessions: in_.length,
    durationS: in_.reduce((s, w) => s + (w.durationS ?? 0), 0),
    distanceM: in_.reduce((s, w) => s + (w.distanceM ?? 0), 0),
  };
}

/**
 * The owner's own page: picture, name and body numbers, then two views. Activity: the last 30
 * days against the 30 before, their sports, and the history of workouts. Goals: every goal with
 * its progress, and adding one.
 */
export function MeScreen({
  db,
  version,
  onEditProfile,
  onChanged,
  view: initialView,
  only,
}: {
  db: SqlDriver;
  version: number;
  onEditProfile: () => void;
  onChanged: () => void;
  /** Open on this view (the Dashboard's "Your activity"); otherwise the one last open. */
  view?: MeView;
  /** One view on its own, without the profile head: Activity is its own section, the goals are You > Targets. */
  only?: MeView;
}) {
  const [chosen, setViewState] = useState<MeView>(initialView ?? lastView);
  const view = only ?? chosen;
  const setView = (v: MeView) => setViewState((lastView = v));
  const [profile, setProfile] = useState<Profile>(EMPTY_PROFILE);
  const [photo, setPhoto] = useState<string | null>(null);
  const [weight, setWeight] = useState<Weight | null>(null);
  const [goals, setGoals] = useState<GoalRow[]>([]);
  const [workouts, setWorkouts] = useState<Workout[]>([]);
  const [msg, setMsg] = useState<Msg>(null);
  const [editingSports, setEditingSports] = useState(false);
  const [sportsDraft, setSportsDraft] = useState<SportId[]>([]);

  const load = useCallback(async () => {
    const day = today();
    const [p, ph, w, g, ws] = await Promise.all([
      loadProfile(db),
      loadProfilePhoto(db),
      latestWeight(db, day),
      listGoals(db, day),
      listWorkouts(db, "1900-01-01", day),
    ]);
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

  const day = today();
  const age = profile.birthDate ? ageOn(profile.birthDate, day) : null;
  const facts = [
    age !== null && `${age} years`,
    profile.heightCm !== null && fmtHeight(profile.heightCm, profile.heightUnit),
    weight && fmtWeight(weight.kg, profile.weightUnit),
  ]
    .filter(Boolean)
    .join(" · ");

  const now30 = totals(workouts, addDays(day, -30), day);
  const prev30 = totals(workouts, addDays(day, -60), addDays(day, -30));
  // Compared with the 30 days before them.
  const vs = "vs before";
  const score = goalScore(goals);
  const views: Choice<MeView>[] = [
    { id: "activity", label: "Activity" },
    { id: "goals", label: score.withData ? `Goals · ${score.met}/${score.withData}` : "Goals" },
  ];

  return (
    <section className="wide-grid me-layout">
      {!only && (
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
      )}
      <MsgLine msg={msg} />

      {!only && <Segmented items={views} value={view} onChange={setView} label="Activity or goals" />}

      {view === "goals" ? (
        <GoalsView db={db} goals={goals} onChanged={load} />
      ) : (
        <>
          {only === "activity" && <ActivityWeek db={db} version={version} />}
          <SectionHeader title="Last 30 days" />
          <div className="viz-tiles me-tiles">
            <StatTile
              label="Workouts"
              value={String(now30.sessions)}
              delta={prev30.sessions ? { value: now30.sessions - prev30.sessions, period: vs, good: "up" } : null}
            />
            <StatTile
              label="Active time"
              value={now30.sessions ? fmtDuration(now30.durationS) : null}
              delta={prev30.durationS ? { value: now30.durationS - prev30.durationS, period: vs, good: "up" } : null}
              formatDelta={fmtDuration}
            />
            {(now30.distanceM > 0 || prev30.distanceM > 0) && (
              <StatTile
                label="Distance"
                value={fmtDistance(now30.distanceM)}
                delta={prev30.distanceM ? { value: now30.distanceM - prev30.distanceM, period: vs, good: "up" } : null}
                formatDelta={fmtDistance}
              />
            )}
          </div>

          {editingSports ? (
            <div className="card stack tight">
              <strong>Your sports</strong>
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
          ) : (
            <div className="row sports-line">
              <span className="small grow">
                <span className="muted">Your sports: </span>
                {profile.sports.length ? profile.sports.map((s) => SPORT_LABEL[s]).join(" · ") : "none picked yet"}
              </span>
              <button
                className="link small accent"
                onClick={() => {
                  setSportsDraft(profile.sports);
                  setEditingSports(true);
                }}
              >
                {profile.sports.length ? "Edit" : "Choose"}
              </button>
            </div>
          )}

          <ActivityHistory workouts={workouts} mySports={profile.sports} />
        </>
      )}
    </section>
  );
}
