import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { SqlDriver } from "../../../db/driver";
import {
  dayFood,
  deleteFood,
  getNutritionTargets,
  listSavedMeals,
  logFood,
  logSavedMeal,
  logTimeFor,
  macrosFromCalories,
  NUTRIENTS,
  relogFood,
  saveEntryAsMeal,
  setNutritionTarget,
  suggestions,
  type FoodEntry,
  type Nutrient,
  type NutritionTargets,
  type PhotoInput,
  type SavedMeal,
} from "../food";
import { drinkKcalByDay } from "../../alcohol/alcohol";
import { eatPortions, loadStock, type StockEntry } from "../../mealprep/mealPrep";
import { mealForHour, usualMeal, type Candidate } from "../suggest";
import { addDays, localDateTimeToMs } from "../../../core/tz";
import { failed, fmtDay, MsgWithUndo, numOrNull, plural, timeZone, today, type Msg } from "../../../ui/common";
import { PeriodNav, SectionHeader } from "../../../ui/layout";
import { MacroBudget, MacroSplit } from "../../../ui/nutrition";
import { emptyDraft, EntryList, kcal, MealFields, parseDraft, PhotoPicker, PhotoThumb, type MealDraft } from "./components";
import { entryActions } from "./entryActions";

interface Props {
  db: SqlDriver;
  version: number;
  onChanged: () => void;
  /** The day open in the log; owned by the meal prep screen so History can open a day here. */
  day: string;
  onDay: (day: string) => void;
  /** Opens meal prep Stock (to cook or defrost). */
  onStock: () => void;
}

const sum = (entries: FoodEntry[], k: Nutrient) => {
  const vals = entries.map((e) => e[k]).filter((v): v is number => v !== null);
  return vals.length ? vals.reduce((a, b) => a + b, 0) : null;
};

const TARGET_LABEL: Record<Nutrient, string> = {
  calories: "kcal a day",
  proteinG: "Protein g (at least)",
  carbsG: "Carbs g (at most)",
  fatG: "Fat g (at most)",
};
const str = (n: number | null) => (n === null ? "" : String(n));
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * The food log for one day, today by default: what is left of the day's calories and macros,
 * one-tap logging (meal prep portions in the fridge, meals eaten often), the form for anything
 * else, and the day's entries. Any past day can be opened and logged to; on a past day a meal is
 * logged at its slot's usual time unless a time is given.
 */
export function DayView({ db, version, onChanged, day, onDay, onStock }: Props) {
  const [entries, setEntries] = useState<FoodEntry[]>([]);
  const [drinks, setDrinks] = useState(0);
  const [targets, setTargets] = useState<NutritionTargets>({ calories: null, proteinG: null, carbsG: null, fatG: null });
  const [editTargets, setEditTargets] = useState<Record<Nutrient, string> | null>(null);
  const [suggested, setSuggested] = useState<Candidate[]>([]);
  const [saved, setSaved] = useState<SavedMeal[]>([]);
  const [ready, setReady] = useState<StockEntry[]>([]);
  const [msg, setMsg] = useState<Msg>(null);
  const [undo, setUndo] = useState<string | null>(null);

  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState<MealDraft>(() => emptyDraft(mealForHour(new Date().getHours())));
  const [time, setTime] = useState("");
  const [photo, setPhoto] = useState<PhotoInput | null>(null);
  const [bookmark, setBookmark] = useState(false);

  const now = today();
  const isToday = day === now;

  const load = useCallback(async () => {
    const tz = timeZone();
    const [e, t, s, sv, dk, st] = await Promise.all([
      dayFood(db, day),
      getNutritionTargets(db),
      suggestions(db, { timeZone: tz }),
      listSavedMeals(db),
      drinkKcalByDay(db, day, day),
      loadStock(db),
    ]);
    setDrinks(dk.get(day) ?? 0);
    setEntries(e);
    setTargets(t);
    setSuggested(s);
    setSaved(sv);
    setReady(st.filter((b) => b.fridgeCount > 0));
  }, [db, day]);

  useEffect(() => {
    void load();
  }, [load, version]);

  // A different day: start the form afresh and drop the undo of something logged elsewhere.
  useEffect(() => {
    setUndo(null);
    setMsg(null);
    setTime("");
  }, [day]);

  const reload = () => {
    void load();
    onChanged();
  };

  // " yesterday", " on Mon, Oct 26", or nothing for today.
  const on = isToday ? "" : fmtDay(day) === "yesterday" ? " yesterday" : ` on ${fmtDay(day)}`;

  async function run(fn: () => Promise<string>, ok: string) {
    try {
      const id = await fn();
      setUndo(id);
      setMsg({ kind: "ok", text: ok });
      reload();
      return true;
    } catch (err) {
      setMsg(failed(err, "food"));
      return false;
    }
  }

  const quickLog = (c: Candidate) => {
    const tz = timeZone();
    const meal = isToday ? mealForHour(new Date().getHours()) : (usualMeal(c) ?? mealForHour(12));
    const atMs = logTimeFor(day, meal, tz);
    return run(
      () => (c.savedMealId ? logSavedMeal(db, c.savedMealId, { meal, atMs, timeZone: tz }) : relogFood(db, c.lastEntryId!, { atMs, timeZone: tz })),
      `Logged ${c.name}${on}.`,
    );
  };

  /** Eat one fridge portion: it leaves stock and lands in the log (meal prep slot). */
  const eatPrep = (s: StockEntry) =>
    run(
      () => {
        const tz = timeZone();
        return eatPortions(db, { batchId: s.batch.id, portions: 1, atMs: logTimeFor(day, mealForHour(new Date().getHours()), tz), timeZone: tz });
      },
      `Ate a portion of ${s.batch.name}${on}. ${plural(s.fridgeCount - 1, "portion")} left in the fridge.`,
    );

  async function add(e: FormEvent) {
    e.preventDefault();
    const f = parseDraft(draft);
    const tz = timeZone();
    const ok = await run(
      async () => {
        const atMs = time ? localDateTimeToMs(day, time, tz).ms : logTimeFor(day, f.meal, tz);
        if (atMs > Date.now() + 60_000) throw new Error("That time has not happened yet");
        const id = await logFood(db, { ...f, atMs, timeZone: tz });
        if (bookmark || photo) await saveEntryAsMeal(db, id, photo);
        return id;
      },
      `Logged ${f.name.trim()}${on}${bookmark || photo ? " and saved it" : ""}.`,
    );
    if (!ok) return;
    setDraft(emptyDraft(isToday ? mealForHour(new Date().getHours()) : null));
    setTime("");
    setPhoto(null);
    setBookmark(false);
    setAdding(false);
  }

  async function saveTargets(e: FormEvent) {
    e.preventDefault();
    if (!editTargets) return;
    try {
      for (const n of NUTRIENTS) {
        const v = numOrNull(editTargets[n]);
        if (v !== null && Number.isNaN(v)) throw new Error("Targets must be numbers");
        await setNutritionTarget(db, n, v, now);
      }
      setEditTargets(null);
      setMsg({ kind: "ok", text: "Targets saved." });
      reload();
    } catch (err) {
      setMsg(failed(err, "food"));
    }
  }

  const food = sum(entries, "calories") ?? 0;
  const totals = { calories: food + drinks, proteinG: sum(entries, "proteinG"), carbsG: sum(entries, "carbsG"), fatG: sum(entries, "fatG") };
  const noTargets = NUTRIENTS.every((n) => targets[n] === null);

  return (
    <div>
      <PeriodNav
        title={cap(fmtDay(day))}
        unit="day"
        onPrev={() => onDay(addDays(day, -1))}
        onNext={() => onDay(addDays(day, 1))}
        nextDisabled={isToday}
        onCurrent={isToday ? null : () => onDay(now)}
        currentLabel="Back to today"
      />

      <MacroBudget eaten={totals} targets={targets} fromDrinks={drinks} />
      {(totals.proteinG ?? 0) + (totals.carbsG ?? 0) + (totals.fatG ?? 0) > 0 && (
        <div className="meter-card">
          <MacroSplit proteinG={totals.proteinG} carbsG={totals.carbsG} fatG={totals.fatG} />
        </div>
      )}

      {editTargets === null ? (
        <button className="link small accent" onClick={() => setEditTargets(Object.fromEntries(NUTRIENTS.map((n) => [n, str(targets[n])])) as never)}>
          {noTargets ? "Set daily targets for calories and macros" : "Change targets"}
        </button>
      ) : (
        <form className="card stack" onSubmit={saveTargets}>
          <strong>Daily targets</strong>
          <div className="grid">
            {NUTRIENTS.map((n) => (
              <label key={n}>
                {TARGET_LABEL[n]}
                <input inputMode="decimal" value={editTargets[n]} onChange={(e) => setEditTargets({ ...editTargets, [n]: e.target.value })} />
              </label>
            ))}
          </div>
          <button
            type="button"
            className="link small accent"
            disabled={!(Number(editTargets.calories) > 0)}
            onClick={() => {
              const m = macrosFromCalories(Number(editTargets.calories));
              setEditTargets({ ...editTargets, proteinG: String(m.proteinG), carbsG: String(m.carbsG), fatG: String(m.fatG) });
            }}
          >
            Fill macros from kcal (30% protein, 40% carbs, 30% fat)
          </button>
          <span className="muted small">Leave a field empty to remove that target. Targets also show as goals on your profile.</span>
          <div className="actions">
            <button type="submit">Save targets</button>
            <button type="button" className="secondary" onClick={() => setEditTargets(null)}>
              Cancel
            </button>
          </div>
        </form>
      )}

      <MsgWithUndo
        msg={msg}
        onUndo={
          undo
            ? async () => {
                await deleteFood(db, undo);
                setUndo(null);
                setMsg({ kind: "ok", text: "Undone." });
                reload();
              }
            : null
        }
      />

      {ready.length > 0 && (
        <section>
          <SectionHeader title="From your meal prep" action="Stock" onAction={onStock} />
          <div className="suggest">
            {ready.map((s) => (
              <button key={s.batch.id} className="suggestion secondary" onClick={() => void eatPrep(s)}>
                <span>
                  Eat 1 · {s.batch.name}
                  <span className="muted small block">{plural(s.fridgeCount, "portion")} in the fridge</span>
                </span>
              </button>
            ))}
          </div>
        </section>
      )}

      {suggested.length > 0 && (
        <section>
          <h3>Eat again</h3>
          <div className="suggest">
            {suggested.map((c) => (
              <button key={c.key} className={isToday && c.loggedToday ? "suggestion secondary dim" : "suggestion secondary"} onClick={() => void quickLog(c)}>
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

      {adding ? (
        <form className="card stack" onSubmit={add}>
          <MealFields draft={draft} onChange={setDraft} saved={saved} />
          <label>
            <span>
              Time <span className="muted small">{isToday ? "optional, now if empty" : "optional, the meal's usual time if empty"}</span>
            </span>
            <input type="time" value={time} onChange={(e) => setTime(e.target.value)} />
          </label>
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
            <button type="submit">Log meal{on}</button>
            <button type="button" className="secondary" onClick={() => setAdding(false)}>
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <button className="wide-button" onClick={() => setAdding(true)}>
          Log a meal{on}
        </button>
      )}

      <div className="row group-head">
        <h2>{cap(fmtDay(day))}</h2>
        <span className="muted small">{entries.length ? `${entries.length} ${entries.length === 1 ? "entry" : "entries"} · ${kcal(food)} kcal` : ""}</span>
      </div>
      <EntryList db={db} entries={entries} timeZone={timeZone()} {...entryActions(db, reload, setMsg, day)} />
    </div>
  );
}
