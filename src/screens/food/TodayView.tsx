import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { SqlDriver } from "../../db/driver";
import {
  dayFood,
  deleteFood,
  getCalorieGoal,
  listSavedMeals,
  localHour,
  logFood,
  logSavedMeal,
  relogFood,
  saveEntryAsMeal,
  setCalorieGoal,
  suggestions,
  type FoodEntry,
  type PhotoInput,
  type SavedMeal,
} from "../../db/food";
import { mealForHour, type Candidate } from "../../meals/suggest";
import { MsgLine, numOrNull, timeZone, today, type Msg } from "../mealprep/common";
import { CalorieMeter, emptyDraft, EntryList, kcal, MealFields, parseDraft, PhotoPicker, PhotoThumb, type MealDraft } from "./components";
import { entryActions } from "./useEntryActions";

interface Props {
  db: SqlDriver;
  version: number;
  onChanged: () => void;
}

const sum = (entries: FoodEntry[], k: "calories" | "proteinG" | "carbsG" | "fatG") => {
  const vals = entries.map((e) => e[k]).filter((v): v is number => v !== null);
  return vals.length ? vals.reduce((a, b) => a + b, 0) : null;
};

export function TodayView({ db, version, onChanged }: Props) {
  const [entries, setEntries] = useState<FoodEntry[]>([]);
  const [target, setTarget] = useState<number | null>(null);
  const [goalInput, setGoalInput] = useState<string | null>(null);
  const [suggested, setSuggested] = useState<Candidate[]>([]);
  const [saved, setSaved] = useState<SavedMeal[]>([]);
  const [msg, setMsg] = useState<Msg>(null);
  const [lastLogged, setLastLogged] = useState<string | null>(null);

  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState<MealDraft>(emptyDraft(mealForHour(new Date().getHours())));
  const [photo, setPhoto] = useState<PhotoInput | null>(null);
  const [bookmark, setBookmark] = useState(false);

  const load = useCallback(async () => {
    const tz = timeZone();
    const [e, g, s, sv] = await Promise.all([dayFood(db, today()), getCalorieGoal(db), suggestions(db, { timeZone: tz }), listSavedMeals(db)]);
    setEntries(e);
    setTarget(g?.target ?? null);
    setSuggested(s);
    setSaved(sv);
  }, [db]);

  useEffect(() => {
    void load();
  }, [load, version]);

  const reload = () => {
    void load();
    onChanged();
  };

  async function quickLog(c: Candidate) {
    try {
      const tz = timeZone();
      const id = c.savedMealId
        ? await logSavedMeal(db, c.savedMealId, { meal: mealForHour(localHour(Date.now(), tz)), timeZone: tz })
        : await relogFood(db, c.lastEntryId!, { timeZone: tz });
      setLastLogged(id);
      setMsg({ kind: "ok", text: `Logged ${c.name}.` });
      reload();
    } catch (err) {
      setMsg({ kind: "error", text: (err as Error).message });
    }
  }

  async function add(e: FormEvent) {
    e.preventDefault();
    try {
      const f = parseDraft(draft);
      const id = await logFood(db, { ...f, timeZone: timeZone() });
      if (bookmark || photo) await saveEntryAsMeal(db, id, photo);
      setLastLogged(id);
      setMsg({ kind: "ok", text: `Logged ${f.name.trim()}${bookmark || photo ? " and saved it" : ""}.` });
      setDraft(emptyDraft(mealForHour(new Date().getHours())));
      setPhoto(null);
      setBookmark(false);
      setAdding(false);
      reload();
    } catch (err) {
      setMsg({ kind: "error", text: (err as Error).message });
    }
  }

  async function saveGoal(e: FormEvent) {
    e.preventDefault();
    try {
      const n = numOrNull(goalInput ?? "");
      await setCalorieGoal(db, n, today());
      setGoalInput(null);
      reload();
    } catch (err) {
      setMsg({ kind: "error", text: (err as Error).message });
    }
  }

  const eaten = sum(entries, "calories") ?? 0;

  return (
    <div>
      <CalorieMeter eaten={eaten} target={target} macros={{ calories: eaten, proteinG: sum(entries, "proteinG"), carbsG: sum(entries, "carbsG"), fatG: sum(entries, "fatG") }} />
      {goalInput === null ? (
        <button className="link small muted" onClick={() => setGoalInput(target === null ? "" : String(target))}>
          {target === null ? "Set a daily calorie target" : "Change target"}
        </button>
      ) : (
        <form className="row" onSubmit={saveGoal}>
          <label className="inline">
            Daily target
            <input inputMode="numeric" className="qty wide" value={goalInput} onChange={(e) => setGoalInput(e.target.value)} placeholder="kcal" autoFocus />
          </label>
          <div className="actions">
            <button type="submit">Save</button>
            <button type="button" className="secondary" onClick={() => setGoalInput(null)}>
              Cancel
            </button>
          </div>
          <span className="muted small">Leave empty to remove the target.</span>
        </form>
      )}

      {suggested.length > 0 && (
        <section>
          <h3>Eat again</h3>
          <div className="suggest">
            {suggested.map((c) => (
              <button key={c.key} className={c.loggedToday ? "suggestion secondary dim" : "suggestion secondary"} onClick={() => quickLog(c)}>
                <PhotoThumb db={db} id={c.photoId} size={40} />
                <span>
                  {c.savedMealId && "★ "}
                  {c.name}
                  <span className="muted small block">
                    {kcal(c.calories)} kcal{c.uses > 1 && ` · ${c.uses}× this month`}
                  </span>
                </span>
              </button>
            ))}
          </div>
        </section>
      )}

      <MsgLine msg={msg} />
      {lastLogged && (
        <button
          className="link small"
          onClick={async () => {
            await deleteFood(db, lastLogged);
            setLastLogged(null);
            setMsg({ kind: "ok", text: "Undone." });
            reload();
          }}
        >
          Undo
        </button>
      )}

      {adding ? (
        <form className="card stack" onSubmit={add}>
          <MealFields draft={draft} onChange={setDraft} saved={saved} />
          <PhotoPicker
            value={photo}
            onChange={(p) => {
              setPhoto(p);
              if (p) setBookmark(true);
            }}
          />
          <label className="inline">
            <input type="checkbox" checked={bookmark || Boolean(photo)} disabled={Boolean(photo)} onChange={(e) => setBookmark(e.target.checked)} />
            Save to favourites{photo ? " (photos are kept with saved meals)" : ""}
          </label>
          <div className="actions">
            <button type="submit">Log meal</button>
            <button type="button" className="secondary" onClick={() => setAdding(false)}>
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <button className="wide-button" onClick={() => setAdding(true)}>
          Log a meal
        </button>
      )}

      <h2>Today</h2>
      <EntryList db={db} entries={entries} {...entryActions(db, reload, setMsg)} />
    </div>
  );
}
