import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { SqlDriver } from "../../../db/driver";
import { deleteSavedMeal, listSavedMeals, localHour, logSavedMeal, saveMeal, type PhotoInput, type SavedMeal } from "../food";
import { mealForHour } from "../suggest";
import { failed, fmtDay, MsgLine, timeZone, today, type Msg } from "../../../ui/common";
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

export function SavedView({ db, version, onChanged }: Props) {
  const [meals, setMeals] = useState<SavedMeal[]>([]);
  const [servings, setServings] = useState<Record<string, string>>({});
  const [editing, setEditing] = useState<Editing | null>(null);
  const [msg, setMsg] = useState<Msg>(null);

  const load = useCallback(async () => setMeals(await listSavedMeals(db)), [db]);
  useEffect(() => {
    void load();
  }, [load, version]);

  async function run(fn: () => Promise<unknown>, ok: string) {
    try {
      await fn();
      setMsg({ kind: "ok", text: ok });
      await load();
      onChanged();
      return true;
    } catch (err) {
      setMsg(failed(err, "food"));
      return false;
    }
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!editing) return;
    const m = parseDraft(editing.draft);
    if (await run(() => saveMeal(db, { id: editing.id, ...m, photo: editing.photo }), `Saved ${m.name.trim()}.`)) setEditing(null);
  }

  if (editing) {
    return (
      <form className="stack" onSubmit={submit}>
        <h3>{editing.id ? "Edit saved meal" : "New saved meal"}</h3>
        {editing.photo === undefined && editing.photoId && <PhotoThumb db={db} id={editing.photoId} size={120} />}
        <PhotoPicker
          value={editing.photo ?? null}
          onChange={(p) => setEditing({ ...editing, photo: p, photoId: p ? editing.photoId : null })}
        />
        <MealFields draft={editing.draft} onChange={(d) => setEditing({ ...editing, draft: d })} />
        <MsgLine msg={msg} />
        <div className="actions">
          <button type="submit">Save</button>
          <button type="button" className="secondary" onClick={() => setEditing(null)}>
            Cancel
          </button>
          {editing.id && (
            <button
              type="button"
              className="secondary danger"
              onClick={() => {
                if (confirm("Remove this saved meal and its photo? Meals already logged stay in the history.")) {
                  void run(() => deleteSavedMeal(db, editing.id!), "Removed.").then((ok) => ok && setEditing(null));
                }
              }}
            >
              Remove
            </button>
          )}
        </div>
      </form>
    );
  }

  return (
    <div>
      <div className="row">
        <p className="muted small">Tap ☆ Save on any logged meal, or add one here.</p>
        <button onClick={() => setEditing({ draft: emptyDraft(null), photo: undefined, photoId: null })}>New</button>
      </div>
      <MsgLine msg={msg} />
      <div className="saved-grid">
        {meals.map((m) => (
          <section key={m.id} className="card saved">
            <button className="link" onClick={() => setEditing({ id: m.id, draft: draftFrom(m), photo: undefined, photoId: m.photoId })}>
              <PhotoThumb db={db} id={m.photoId} size={96} />
              <strong>{m.name}</strong>
            </button>
            <div className="muted small">
              {kcal(m.calories)} kcal{m.meal && ` · ${MEAL_LABEL[m.meal]}`}
            </div>
            <div className="muted small">
              {m.uses ? `Eaten ${m.uses}×, last ${fmtDay(new Date(m.lastMs!).toLocaleDateString("en-CA"), today())}` : "Not eaten yet"}
            </div>
            <div className="row">
              <input
                className="qty"
                inputMode="decimal"
                aria-label="Servings"
                placeholder="1"
                value={servings[m.id] ?? ""}
                onChange={(e) => setServings({ ...servings, [m.id]: e.target.value })}
              />
              <button
                onClick={() => {
                  const tz = timeZone();
                  const k = servings[m.id] ? Number(servings[m.id]) : 1;
                  void run(
                    () => logSavedMeal(db, m.id, { servings: k, meal: m.meal ?? mealForHour(localHour(Date.now(), tz)), timeZone: tz }),
                    `Logged ${m.name}.`,
                  );
                }}
              >
                Log
              </button>
            </div>
          </section>
        ))}
      </div>
      {!meals.length && <p className="muted">No saved meals yet.</p>}
    </div>
  );
}
