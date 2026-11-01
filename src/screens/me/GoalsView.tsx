import { useState, type FormEvent } from "react";
import type { SqlDriver } from "../../db/driver";
import { deviceId } from "../../db/settings";
import { Meter, StatTile } from "../../ui/charts";
import { failed, fmtDay, MsgLine, plural, today, type Msg } from "../../ui/common";
import { StatusBadge, type Status as BadgeStatus } from "../../ui/controls";
import { Icon } from "../../ui/icons";
import { insertGoal } from "../../domain/journal/journal";
import { fmtGoalValue, GOAL_TEMPLATES, type GoalTemplate } from "../../domain/me/goalTemplates";
import { deleteGoal, type Goal, type Progress, type Status } from "../../domain/me/goals";

const STATUS: Record<Status, { badge: BadgeStatus; word: string }> = {
  met: { badge: "good", word: "met" },
  on_track: { badge: "good", word: "on track" },
  behind: { badge: "warning", word: "not yet" },
  missed: { badge: "critical", word: "over" },
  no_data: { badge: "info", word: "no data yet" },
};
const PERIOD_WORD = { day: "today", week: "this week", month: "this month" } as const;

export interface GoalRow {
  goal: Goal;
  progress: Progress | null;
}

/** Goals met (or on track) out of those with data today: one with nothing logged yet is not a miss. */
export function goalScore(goals: GoalRow[]): { met: number; withData: number } {
  const have = goals.filter((g) => g.progress && g.progress.status !== "no_data");
  return { met: have.filter((g) => g.progress!.status === "met" || g.progress!.status === "on_track").length, withData: have.length };
}

const NUTRITION = ["calories", "protein_g", "carbs_g", "fat_g"];
/** The daily nutrition targets set in the food log, shown together. */
const isNutrition = (g: Goal) => g.targetKind === "food" && g.period === "day" && NUTRITION.includes(g.metric ?? "");
const NUTRITION_LABEL: Record<string, string> = { calories: "Calories", protein_g: "Protein", carbs_g: "Carbs", fat_g: "Fat" };

/** A goal made from a template measures the same thing: the template is taken. */
const taken = (t: GoalTemplate, goals: GoalRow[]) => goals.some((g) => g.goal.metric === t.build(t.defaultValue, "2000-01-01").metric);
const NUTRITION_SLOT: Record<string, number | undefined> = { protein_g: 1, carbs_g: 2, fat_g: 3 };

/**
 * Goals with how they are going: a line on how many are met (tiles on a wide screen), the daily
 * nutrition targets with a bar each, one card per other goal (today or the period so far against
 * the target, a bar, the last 7 days and the streak), then ideas: the goals Even can track that
 * are not set yet, each one tap from the form with its usual target. Nutrition targets are set in
 * the food log.
 */
export function GoalsView({ db, goals, onChanged }: { db: SqlDriver; goals: GoalRow[]; onChanged: () => Promise<void> }) {
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [template, setTemplate] = useState(GOAL_TEMPLATES[0].id);
  const [targetText, setTargetText] = useState(String(GOAL_TEMPLATES[0].defaultValue));
  const [customTitle, setCustomTitle] = useState("");
  const [msg, setMsg] = useState<Msg>(null);

  const score = goalScore(goals);
  const nutrition = goals.filter((g) => isNutrition(g.goal)).sort((a, b) => NUTRITION.indexOf(a.goal.metric!) - NUTRITION.indexOf(b.goal.metric!));
  const others = goals.filter((g) => !isNutrition(g.goal));
  const tpl = GOAL_TEMPLATES.find((t) => t.id === template);
  const ideas = GOAL_TEMPLATES.filter((t) => !taken(t, goals));
  const startFrom = (id: string) => {
    setTemplate(id);
    const t = GOAL_TEMPLATES.find((x) => x.id === id);
    if (t) setTargetText(String(t.defaultValue));
    setAdding(true);
  };
  const first = others.find((g) => g.progress && g.goal.targetNum !== null);
  const best = goals.reduce<GoalRow | null>((b, g) => ((g.progress?.streak ?? 0) > (b?.progress?.streak ?? 0) ? g : b), null);

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
        const v = Number(targetText.replace(",", "."));
        if (!Number.isFinite(v) || v < t.min || v > t.max) throw new Error(`${t.ask} must be between ${t.min} and ${t.max}`);
        await insertGoal(db, t.build(v, today()), stamp);
      }
      setMsg({ kind: "ok", text: "Goal added." });
      setAdding(false);
      await onChanged();
    } catch (err) {
      setMsg(failed(err, "me.goals"));
    }
  }

  return (
    <>
      <p className="muted small narrow-only">
        {!goals.length
          ? "No goals yet. Add one, or ask the assistant to set one up with you."
          : score.withData
            ? `${score.met} of ${score.withData} met or on track today${score.withData < goals.filter((g) => g.progress).length ? "; the rest have nothing logged yet" : ""}.`
            : "Nothing logged for your goals today yet."}
      </p>
      <div className="viz-tiles me-tiles wide-only">
        <StatTile
          label="Goals met today"
          value={String(score.met)}
          unit={`of ${score.withData}`}
          note={score.withData ? "with data today" : "nothing logged yet"}
        />
        {first?.progress && (
          <StatTile
            label={first.goal.title}
            value={first.progress.current === null ? null : fmtGoalValue(first.goal, first.progress.current)}
            note={`${STATUS[first.progress.status].word}${first.progress.last7 ? ` · ${first.progress.last7.met} of the last 7 days` : ""}`}
          />
        )}
        <StatTile
          label="Longest streak"
          value={best?.progress?.streak ? String(best.progress.streak) : null}
          unit="days"
          note={best ? (isNutrition(best.goal) ? `${NUTRITION_LABEL[best.goal.metric!].toLowerCase()} within target` : best.goal.title) : undefined}
        />
      </div>

      {nutrition.length > 0 && (
        <div className={others.length ? "card goal-card span-8" : "card goal-card span-12"}>
          <div className="row">
            <strong className="grow">Daily nutrition</strong>
            <span className="muted small">set in the food log</span>
          </div>
          <dl className="goal-lines">
            {nutrition.map(({ goal: g, progress: p }) => (
              <div key={g.id}>
                <dt>{NUTRITION_LABEL[g.metric!]}</dt>
                <dd>
                  <span className="small">
                    <strong>{p?.current != null ? fmtGoalValue(g, p.current) : "–"}</strong>
                    <span className="muted">
                      {" "}
                      / {g.comparator === "<=" ? "≤" : "≥"} {fmtGoalValue(g, g.targetNum!)}
                    </span>
                  </span>
                  {p?.current != null && (
                    <Meter
                      value={p.current}
                      max={g.targetNum!}
                      label={NUTRITION_LABEL[g.metric!]}
                      slot={NUTRITION_SLOT[g.metric!]}
                      overIsFine={g.comparator === ">="}
                    />
                  )}
                </dd>
                <dd className="muted small">
                  {p?.last7 && p.last7.withData > 0 && `${p.last7.met} of ${plural(p.last7.withData, "day")}`}
                  {p?.streak ? ` · ${p.streak} in a row` : ""}
                </dd>
                <dd>{p && <StatusBadge status={STATUS[p.status].badge}>{STATUS[p.status].word}</StatusBadge>}</dd>
              </div>
            ))}
          </dl>
        </div>
      )}

      {others.map(({ goal: g, progress: p }) => (
        <div key={g.id} className="card goal-card span-4">
          <div className="row">
            <strong className="grow">{g.title}</strong>
            {p && <StatusBadge status={STATUS[p.status].badge}>{STATUS[p.status].word}</StatusBadge>}
            {confirmDelete !== g.id && (
              <button type="button" className="icon-button ghost" aria-label={`Delete ${g.title}`} onClick={() => setConfirmDelete(g.id)}>
                <Icon name="trash" size={18} />
              </button>
            )}
          </div>
          {p && g.targetNum !== null && (
            <>
              <div className="small">
                {p.current === null ? `Nothing ${PERIOD_WORD[g.period]} yet` : `${fmtGoalValue(g, p.current)} ${PERIOD_WORD[g.period]}`}
                <span className="muted">
                  {" "}
                  · {g.comparator === "<=" ? "at most" : "at least"} {fmtGoalValue(g, g.targetNum)}
                </span>
              </div>
              {p.current !== null && <Meter value={p.current} max={g.targetNum} label={g.title} overIsFine={g.comparator === ">="} />}
              {p.last7 && p.last7.withData > 0 && (
                <div className="muted small">
                  Met {p.last7.met} of the last {plural(p.last7.withData, "day")} with data{p.streak ? ` · ${plural(p.streak, "day")} in a row` : ""}
                </div>
              )}
            </>
          )}
          {!p && (
            <div className="muted small">
              Since {fmtDay(g.startDay)}
              {g.notes ? ` · ${g.notes}` : ""}
            </div>
          )}
          {confirmDelete === g.id && (
            <div className="actions compact">
              <button
                className="secondary danger"
                onClick={async () => {
                  await deleteGoal(db, g.id);
                  setConfirmDelete(null);
                  await onChanged();
                }}
              >
                Delete goal
              </button>
              <button className="secondary" onClick={() => setConfirmDelete(null)}>
                Keep
              </button>
            </div>
          )}
        </div>
      ))}

      {ideas.length > 0 && (
        <section className={adding ? "card span-8 wide-only" : "card span-8"}>
          <h3>{goals.length ? "Add a goal" : "Ideas"}</h3>
          <p className="muted small">The goals Even can track; pick one to start from its usual target</p>
          <div className="goal-ideas">
            {ideas.map((t) => (
              <button key={t.id} type="button" className="goal-idea" onClick={() => startFrom(t.id)}>
                <strong>{t.label}</strong>
                <span className="muted small">
                  {t.ask.replace(/ \(.*\)$/, "")}: {t.defaultValue}
                </span>
                <span className="small accent">+ Add</span>
              </button>
            ))}
          </div>
          <button type="button" className="secondary wide-button narrow-only" onClick={() => startFrom("custom")}>
            Something else
          </button>
        </section>
      )}
      <form onSubmit={addGoal} className={adding ? "card stack span-4" : "card stack span-4 wide-only"}>
        <strong>New goal</strong>
        <label>
          Kind
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
        <div className="actions">
          <button type="submit">Add goal</button>
          <button type="button" className="secondary" onClick={() => setAdding(false)}>
            Cancel
          </button>
        </div>
      </form>
      {!ideas.length && !adding && (
        <button type="button" className="wide-button secondary narrow-only" onClick={() => startFrom("custom")}>
          Add a goal
        </button>
      )}
      <MsgLine msg={msg} />
    </>
  );
}
