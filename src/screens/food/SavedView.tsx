import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { SqlDriver } from "../../db/driver";
import {
  deleteSavedMeal,
  listSavedMeals,
  localHour,
  logSavedMeal,
  relogFood,
  saveEntryAsMeal,
  saveMeal,
  suggestions,
  type PhotoInput,
  type SavedMeal,
} from "../../domain/food/food";
import { mealForHour, type Candidate } from "../../domain/food/suggest";
import { changeRunner, EditActions, fmtDay, MsgLine, timeZone, type Msg } from "../../ui/common";
import { draftFrom, emptyDraft, kcal, MEAL_LABEL, MealFields, parseDraft, PhotoPicker, PhotoThumb, type MealDraft } from "./components";

interface Props {
  db: SqlDriver;
  version: number;
  onChanged: () => void;
}

interface Editing {
  id?: string;
  draft: MealDraft;
  /** undefined = photo unchanged. */
  photo: PhotoInput | null | undefined;
  photoId: string | null;
}

const blank = (): Editing => ({ draft: emptyDraft(null), photo: undefined, photoId: null });
/** "Eaten most this month" shows this many meals not saved yet. */
const MOST = 3;

/**
 * Saved meals, logged again in one tap with servings, and the meals eaten most in the last 30
 * days that are not saved yet, each one ☆ Save away. A phone opens the form over the list; a wide
 * screen keeps it beside the list, ready for a new meal.
 */
export function SavedView({ db, version, onChanged }: Props) {
  const [meals, setMeals] = useState<SavedMeal[]>([]);
  const [most, setMost] = useState<Candidate[]>([]);
  const [servings, setServings] = useState<Record<string, string>>({});
  const [editing, setEditing] = useState<Editing | null>(null);
  const [fresh, setFresh] = useState<Editing>(blank);
  const [msg, setMsg] = useState<Msg>(null);

  const load = useCallback(async () => {
    const [m, c] = await Promise.all([listSavedMeals(db), suggestions(db, { timeZone: timeZone(), limit: 100 })]);
    setMeals(m);
    setMost(
      c
        .filter((x) => !x.savedMealId && x.lastEntryId)
        .sort((a, b) => b.uses - a.uses)
        .slice(0, MOST),
    );
  }, [db]);
  useEffect(() => {
    void load();
  }, [load, version]);

  const run = changeRunner({ setMsg, load, onChanged, scope: "food" });
  // The form edits a saved meal when one is open, otherwise it is the wide screen's new meal.
  const form = editing ?? fresh;
  const setForm = (e: Editing) => (editing ? setEditing(e) : setFresh(e));

  async function submit(e: FormEvent) {
    e.preventDefault();
    const m = parseDraft(form.draft);
    if (await run(() => saveMeal(db, { id: form.id, ...m, photo: form.photo }), `Saved ${m.name.trim()}.`)) {
      setEditing(null);
      setFresh(blank());
    }
  }

  const logMeal = (m: SavedMeal) => {
    const tz = timeZone();
    const k = servings[m.id] ? Number(servings[m.id]) : 1;
    void run(() => logSavedMeal(db, m.id, { servings: k, meal: m.meal ?? mealForHour(localHour(Date.now(), tz)), timeZone: tz }), `Logged ${m.name}.`);
  };

  return (
    <div className="wide-grid">
      <div className={editing ? "span-8 wide-col wide-only" : "span-8 wide-col"}>
        <section className="card">
          <div className="section-head">
            <div>
              <h2>Saved meals</h2>
              <div className="muted small">
                <span className="narrow-only">Log again in one tap</span>
                <span className="wide-only">
                  {meals.length} {meals.length === 1 ? "meal" : "meals"}, logged in one tap with servings
                </span>
              </div>
            </div>
            <button className="narrow-only" onClick={() => setEditing(blank())}>
              New
            </button>
          </div>
          <MsgLine msg={msg} />
          <ul className="plain saved-list">
            {meals.map((m) => (
              <li key={m.id} className="saved-row">
                <button className="link saved-open" onClick={() => setEditing({ id: m.id, draft: draftFrom(m), photo: undefined, photoId: m.photoId })}>
                  <PhotoThumb db={db} id={m.photoId} size={56} />
                  <span className="saved-text">
                    <strong>{m.name}</strong>
                    <span className="muted small">
                      {kcal(m.calories)} kcal{m.meal && ` · ${MEAL_LABEL[m.meal]}`} ·{" "}
                      {m.uses ? `eaten ${m.uses}×, last ${fmtDay(new Date(m.lastMs!).toLocaleDateString("en-CA"))}` : "not eaten yet"}
                    </span>
                  </span>
                </button>
                <span className="saved-log">
                  <input
                    className="qty"
                    inputMode="decimal"
                    aria-label={`Servings of ${m.name}`}
                    placeholder="1"
                    value={servings[m.id] ?? ""}
                    onChange={(e) => setServings({ ...servings, [m.id]: e.target.value })}
                  />
                  <button onClick={() => logMeal(m)}>Log</button>
                </span>
              </li>
            ))}
          </ul>
          {!meals.length && <p className="muted small">No saved meals yet.</p>}
        </section>

        <section className="card">
          <h2>Eaten most this month</h2>
          <p className="muted small">Save one to log it again in one tap</p>
          {most.length ? (
            <ul className="plain saved-list most">
              {most.map((c) => (
                <li key={c.key} className="saved-row">
                  <span className="saved-text grow">
                    <span>{c.name}</span>
                    <span className="muted small">
                      {kcal(c.calories)} kcal · {c.uses}× this month
                    </span>
                  </span>
                  <span className="saved-log">
                    <button
                      className="secondary wide-only"
                      onClick={() => void run(() => relogFood(db, c.lastEntryId!, { timeZone: timeZone() }), `Logged ${c.name}.`)}
                    >
                      Log again
                    </button>
                    <button className="link accent" onClick={() => void run(() => saveEntryAsMeal(db, c.lastEntryId!), `Saved ${c.name}.`)}>
                      ☆ Save
                    </button>
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted small">Meals logged twice or more in 30 days show up here.</p>
          )}
        </section>
        <p className="muted small narrow-only">Tap ☆ Save on any logged meal to add it here.</p>
      </div>

      <form className={editing ? "card stack span-4" : "card stack span-4 wide-only"} onSubmit={submit}>
        <h3>{form.id ? "Edit saved meal" : "New saved meal"}</h3>
        {!form.id && <p className="muted small">Tap ☆ Save on any logged meal, or add one here.</p>}
        {form.photo === undefined && form.photoId && <PhotoThumb db={db} id={form.photoId} size={120} />}
        <PhotoPicker value={form.photo ?? null} onChange={(p) => setForm({ ...form, photo: p, photoId: p ? form.photoId : null })} />
        <MealFields draft={form.draft} onChange={(d) => setForm({ ...form, draft: d })} />
        {editing && <MsgLine msg={msg} />}
        <EditActions
          onCancel={() => (editing ? setEditing(null) : setFresh(blank()))}
          onRemove={form.id ? () => void run(() => deleteSavedMeal(db, form.id!), "Removed.").then((ok) => ok && setEditing(null)) : undefined}
          confirmRemove="Remove this saved meal and its photo? Meals already logged stay in the history."
        />
      </form>
    </div>
  );
}
