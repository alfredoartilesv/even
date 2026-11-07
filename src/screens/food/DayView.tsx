import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { SqlDriver } from "../../db/driver";
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
} from "../../domain/food/food";
import { drinkKcalByDay } from "../../domain/alcohol/alcohol";
import { eatPortions, loadStock, type StockEntry } from "../../domain/mealprep/mealPrep";
import { mealForHour, usualMeal, type Candidate } from "../../domain/food/suggest";
import { addDays, localDateTimeToMs } from "../../core/tz";
import { failed, fmtDay, MsgWithUndo, numOrNull, plural, timeZone, today, type Msg } from "../../ui/common";
import { PeriodNav, SectionHeader } from "../../ui/layout";
import { MacroBars } from "../../ui/nutrition";
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

/** The share of calories the macro targets typed give protein, carbs and fat; undefined (30/40/30) unless all three are numbers. */
function splitOf(t: Record<Nutrient, string>): [number, number, number] | undefined {
  const g = [t.proteinG, t.carbsG, t.fatG].map((v) => Number(v.replace(",", ".")));
  if (g.some((v) => !(v > 0))) return undefined;
  const k = [g[0] * 4, g[1] * 4, g[2] * 9];
  const total = k[0] + k[1] + k[2];
  return [k[0] / total, k[1] / total, k[2] / total];
}

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
  // The meal prep chip tapped just now: it stays pressed, and tapping it again puts the portion back.
  const [ate, setAte] = useState<{ batchId: string; entryId: string } | null>(null);
  // Macro targets follow the kcal typed (30/40/30) until one of them is edited by hand.
  const [macrosTouched, setMacrosTouched] = useState(false);
  // The split they keep: the saved targets' own when the form opened (typing kcal digit by digit would round it away).
  const [split, setSplit] = useState<[number, number, number] | undefined>(undefined);

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
    setReady(st);
  }, [db, day]);

  useEffect(() => {
    void load();
  }, [load, version]);

  // A different day: start the form afresh and drop the undo of something logged elsewhere.
  useEffect(() => {
    setUndo(null);
    setAte(null);
    setMsg(null);
    setTime("");
  }, [day]);

  const reload = () => {
    void load();
    onChanged();
  };

  // " yesterday", " on Mon, Oct 26", or nothing for today.
  const on = isToday ? "" : fmtDay(day) === "yesterday" ? " yesterday" : ` on ${fmtDay(day)}`;

  /** Log something; resolves to the new entry's id, or null when it failed (the message says why). */
  async function run(fn: () => Promise<string>, ok: string): Promise<string | null> {
    try {
      const id = await fn();
      setUndo(id);
      setMsg({ kind: "ok", text: ok });
      reload();
      return id;
    } catch (err) {
      setMsg(failed(err, "food"));
      return null;
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

  /** Eat one fridge portion: it leaves stock and lands in the log (meal prep slot). Tapped again right after, it goes back. */
  async function eatPrep(s: StockEntry) {
    if (ate?.batchId === s.batch.id) {
      try {
        await deleteFood(db, ate.entryId);
        setAte(null);
        setUndo(null);
        setMsg({ kind: "ok", text: `Put the portion of ${s.batch.name} back in the fridge.` });
        reload();
      } catch (err) {
        setMsg(failed(err, "food"));
      }
      return;
    }
    const id = await run(() => {
      const tz = timeZone();
      return eatPortions(db, { batchId: s.batch.id, portions: 1, atMs: logTimeFor(day, mealForHour(new Date().getHours()), tz), timeZone: tz });
    }, `Ate a portion of ${s.batch.name}${on}. Tap it again to undo.`);
    if (id) setAte({ batchId: s.batch.id, entryId: id });
  }

  async function add(e: FormEvent) {
    e.preventDefault();
    const f = parseDraft(draft);
    const tz = timeZone();
    const logged = await run(
      async () => {
        const atMs = time ? localDateTimeToMs(day, time, tz).ms : logTimeFor(day, f.meal, tz);
        if (atMs > Date.now() + 60_000) throw new Error("That time has not happened yet");
        const id = await logFood(db, { ...f, atMs, timeZone: tz });
        if (bookmark || photo) await saveEntryAsMeal(db, id, photo);
        return id;
      },
      `Logged ${f.name.trim()}${on}${bookmark || photo ? " and saved it" : ""}.`,
    );
    if (!logged) return;
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
  // Batches with fridge portions, and the one just eaten from even if that was its last, so it can be tapped back.
  const prep = ready.filter((b) => b.fridgeCount > 0 || b.batch.id === ate?.batchId);

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

      <div className="wide-grid">
        <div className="span-8 wide-col">
          <section className="card left-card" aria-label="What is left">
            <div className="left-head">
              <span className="left-big">
                {targets.calories !== null ? kcal(Math.abs(targets.calories - (totals.calories ?? 0))) : kcal(totals.calories ?? 0)}
                <span className="muted">
                  {targets.calories === null ? " kcal eaten" : (totals.calories ?? 0) > targets.calories ? " kcal over" : " kcal left"}
                </span>
              </span>
              {targets.calories !== null && (
                <span className="muted small">
                  {kcal(totals.calories ?? 0)} of {kcal(targets.calories)}
                  {drinks ? ` · ${kcal(drinks)} from drinks` : ""}
                </span>
              )}
            </div>
            <MacroBars
              mode="left"
              grams={{ protein: totals.proteinG, carbs: totals.carbsG, fat: totals.fatG }}
              targets={{ protein: targets.proteinG, carbs: targets.carbsG, fat: targets.fatG }}
            />
          </section>

          {editTargets === null ? (
            <button
              className="link small accent"
              onClick={() => {
                setEditTargets(Object.fromEntries(NUTRIENTS.map((n) => [n, str(targets[n])])) as never);
                const open = Object.fromEntries(NUTRIENTS.map((n) => [n, str(targets[n])])) as Record<Nutrient, string>;
                setSplit(splitOf(open));
                setMacrosTouched(false);
              }}
            >
              {noTargets ? "Set daily targets for calories and macros" : "Change targets"}
            </button>
          ) : (
            <form className="card stack" onSubmit={saveTargets}>
              <strong>Daily targets</strong>
              <div className="grid">
                {NUTRIENTS.map((n) => (
                  <label key={n}>
                    {TARGET_LABEL[n]}
                    <input
                      inputMode="decimal"
                      value={editTargets[n]}
                      onChange={(e) => {
                        const v = e.target.value;
                        if (n !== "calories") {
                          setMacrosTouched(true);
                          return setEditTargets({ ...editTargets, [n]: v });
                        }
                        const k = Number(v.replace(",", "."));
                        if (macrosTouched || !(k > 0)) return setEditTargets({ ...editTargets, calories: v });
                        const m = macrosFromCalories(k, split);
                        setEditTargets({ calories: v, proteinG: String(m.proteinG), carbsG: String(m.carbsG), fatG: String(m.fatG) });
                      }}
                    />
                  </label>
                ))}
              </div>
              {macrosTouched ? (
                <button
                  type="button"
                  className="link small accent"
                  disabled={!(Number(editTargets.calories.replace(",", ".")) > 0)}
                  onClick={() => {
                    const m = macrosFromCalories(Number(editTargets.calories.replace(",", ".")));
                    setEditTargets({ ...editTargets, proteinG: String(m.proteinG), carbsG: String(m.carbsG), fatG: String(m.fatG) });
                    const open = Object.fromEntries(NUTRIENTS.map((n) => [n, str(targets[n])])) as Record<Nutrient, string>;
                    setSplit(splitOf(open));
                    setMacrosTouched(false);
                  }}
                >
                  Fill macros from kcal again (30% protein, 40% carbs, 30% fat)
                </button>
              ) : (
                <span className="muted small">
                  Macros follow the kcal, keeping their split (30% protein, 40% carbs, 30% fat to start), until you change one.
                </span>
              )}
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
          <section className="card day-meals" aria-label="Meals">
            <div className="row group-head">
              <h2>{cap(fmtDay(day))}</h2>
              <span className="muted small">
                {entries.length ? `${entries.length} ${entries.length === 1 ? "entry" : "entries"} · ${kcal(food)} kcal` : ""}
              </span>
            </div>
            <EntryList db={db} entries={entries} timeZone={timeZone()} {...entryActions(db, reload, setMsg, day)} />
          </section>
        </div>

        <div className="span-4 wide-col">
          {prep.length > 0 && (
            <section>
              <SectionHeader title="From your meal prep" action="Stock" onAction={onStock} />
              <div className="suggest column">
                {prep.map((s) => {
                  const pressed = ate?.batchId === s.batch.id;
                  return (
                    <button
                      key={s.batch.id}
                      className={pressed ? "suggestion pressed" : "suggestion secondary"}
                      aria-pressed={pressed}
                      onClick={() => void eatPrep(s)}
                    >
                      <span>
                        {pressed ? `✓ Ate 1 · ${s.batch.name}` : `Eat 1 · ${s.batch.name}`}
                        <span className="muted small block">{pressed ? "Tap again to undo" : `${plural(s.fridgeCount, "portion")} in the fridge`}</span>
                      </span>
                    </button>
                  );
                })}
              </div>
            </section>
          )}
          {adding ? null : (
            <button className="wide-button" onClick={() => setAdding(true)}>
              Log a meal{on}
            </button>
          )}
          {suggested.length > 0 && (
            <section className="eat-again">
              <h3>Eat again</h3>
              <div className="suggest column">
                {suggested.map((c) => (
                  <button
                    key={c.key}
                    className={isToday && c.loggedToday ? "suggestion secondary dim" : "suggestion secondary"}
                    onClick={() => void quickLog(c)}
                  >
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
        </div>

        {adding ? (
          <form className="card stack span-12" onSubmit={add}>
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
        ) : null}
      </div>
    </div>
  );
}
