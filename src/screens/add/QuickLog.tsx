import { useContext, useEffect, useState, type FormEvent } from "react";
import type { SqlDriver } from "../../db/driver";
import { deleteDrink, getCurrency, listDrinkTypes, logDrink, servingKcal, type DrinkType } from "../../domain/alcohol/alcohol";
import { deleteFood, logFood, suggestions } from "../../domain/food/food";
import { applyQuickAdd, undoQuickAdd } from "../../domain/food/quickAdd";
import { mealForHour, type Candidate, type Meal } from "../../domain/food/suggest";
import { addMeasurement, deleteMeasurement, getDayNote, listMeasurements, saveDayNote, SCALE } from "../../domain/journal/entries";
import { addDays } from "../../core/tz";
import { failed, fmtMoney, MsgLine, numOrNull, timeZone, today, type Msg } from "../../ui/common";
import { ChipGroup, ScaleRating } from "../../ui/controls";
import { SheetClose } from "../../ui/layout";

export type QuickKind = "food" | "drink" | "checkIn" | "weight";

export const MEALS: { id: Meal; label: string }[] = [
  { id: "breakfast", label: "Breakfast" },
  { id: "lunch", label: "Lunch" },
  { id: "snack", label: "Snack" },
  { id: "dinner", label: "Dinner" },
];

interface Props {
  db: SqlDriver;
  kind: QuickKind;
  version: number;
  onChanged: () => void;
  /** The full form in its section, for anything this one does not cover. */
  onMore: () => void;
}

/** What was just saved, and how to take it back. */
type Done = { text: string; undo: () => Promise<void> } | null;

/**
 * The Add sheet's tiles log right there (the owner's ask, 9 Nov 2026), rather than only opening
 * the section: a favourite drink or a usual food in one tap, a check-in, a weigh-in. Each has Undo,
 * and a link to the full form for the rest.
 */
export function QuickLog({ db, kind, version, onChanged, onMore }: Props) {
  const close = useContext(SheetClose);
  const [done, setDone] = useState<Done>(null);
  const [msg, setMsg] = useState<Msg>(null);
  const run = async (fn: () => Promise<Done>) => {
    setMsg(null);
    try {
      const d = await fn();
      setDone(d);
      onChanged();
    } catch (err) {
      setMsg(failed(err, `quicklog.${kind}`));
    }
  };
  const props = { db, version, run };
  return (
    <div className="quick-log">
      {kind === "food" ? (
        <FoodPart {...props} />
      ) : kind === "drink" ? (
        <DrinkPart {...props} />
      ) : kind === "checkIn" ? (
        <CheckInPart {...props} />
      ) : (
        <WeightPart {...props} />
      )}
      <MsgLine msg={msg} />
      {done && (
        <div className="quick-log-done" role="status">
          <strong className="grow">{done.text}</strong>
          <button
            type="button"
            className="link accent small"
            onClick={() =>
              void done.undo().then(() => {
                setDone(null);
                onChanged();
              })
            }
          >
            Undo
          </button>
        </div>
      )}
      <button
        type="button"
        className="link small quick-log-more"
        onClick={() => {
          close?.();
          onMore();
        }}
      >
        {kind === "food" ? "Open the food log ›" : kind === "drink" ? "Open drinks ›" : kind === "checkIn" ? "Open the journal ›" : "Other measurements ›"}
      </button>
    </div>
  );
}

interface PartProps {
  db: SqlDriver;
  version: number;
  run: (fn: () => Promise<Done>) => Promise<void>;
}

/** The usual foods for this time of day, one tap each, or something new by name and kcal. */
function FoodPart({ db, version, run }: PartProps) {
  const [foods, setFoods] = useState<Candidate[]>([]);
  const [meal, setMeal] = useState<Meal>(() => mealForHour(new Date().getHours()));
  const [name, setName] = useState("");
  const [kcal, setKcal] = useState("");
  useEffect(() => {
    // A saved meal and the entries logged from it share a name: one chip each.
    void suggestions(db, { timeZone: timeZone(), limit: 12 }).then((all) => {
      const seen = new Set<string>();
      setFoods(all.filter((f) => !seen.has(f.name.toLowerCase()) && seen.add(f.name.toLowerCase())).slice(0, 6));
    });
  }, [db, version]);
  const label = MEALS.find((m) => m.id === meal)!.label;
  const add = (e: FormEvent) => {
    e.preventDefault();
    const n = name.trim();
    if (!n) return;
    void run(async () => {
      const id = await logFood(db, { name: n, meal, calories: numOrNull(kcal), proteinG: null, carbsG: null, fatG: null, timeZone: timeZone() });
      setName("");
      setKcal("");
      return { text: `${n} · ${label}`, undo: () => deleteFood(db, id) };
    });
  };
  return (
    <>
      <ChipGroup label="Meal" value={meal} onChange={setMeal} options={MEALS} />
      {foods.length > 0 && (
        <div className="quick-log-picks" role="group" aria-label="Your usual foods">
          {foods.map((f) => (
            <button
              key={f.savedMealId ?? f.lastEntryId ?? f.name}
              type="button"
              className="chip"
              onClick={() =>
                void run(async () => {
                  const undo = await applyQuickAdd(db, [{ kind: "food", part: f.name, count: 1, candidate: f }], { meal, timeZone: timeZone() });
                  return { text: `${f.name} · ${label}`, undo: () => undoQuickAdd(db, undo) };
                })
              }
            >
              {f.name}
              {f.calories !== null && <span className="muted"> · {Math.round(f.calories)}</span>}
            </button>
          ))}
        </div>
      )}
      <form className="quick-log-row" onSubmit={add}>
        <input aria-label="Something new" placeholder="Something new" value={name} maxLength={200} onChange={(e) => setName(e.target.value)} />
        <input
          className="quick-log-num"
          aria-label="Calories"
          placeholder="kcal"
          inputMode="numeric"
          value={kcal}
          onChange={(e) => setKcal(e.target.value.replace(/\D/g, ""))}
        />
        <button type="submit" disabled={!name.trim()}>
          Log
        </button>
      </form>
    </>
  );
}

/** The favourite drinks, most used first: a tap logs one at its usual price. */
function DrinkPart({ db, version, run }: PartProps) {
  const [types, setTypes] = useState<DrinkType[] | null>(null);
  const [currency, setCurrency] = useState("EUR");
  useEffect(() => {
    void Promise.all([listDrinkTypes(db), getCurrency(db)]).then(([t, c]) => {
      setTypes([...t].sort((a, b) => b.uses - a.uses).slice(0, 8));
      setCurrency(c);
    });
  }, [db, version]);
  if (types === null) return null;
  if (types.length === 0) return <p className="muted small">No favourite drinks yet. Add one in Drinks and it shows here.</p>;
  return (
    <div className="quick-log-picks" role="group" aria-label="Your drinks">
      {types.map((t) => (
        <button
          key={t.id}
          type="button"
          className="chip"
          onClick={() =>
            void run(async () => {
              const ids = await logDrink(db, { typeId: t.id, count: 1, timeZone: timeZone() });
              return {
                text: `${t.name} · ${servingKcal(t)} kcal${t.price ? ` · ${fmtMoney(t.price, currency)}` : ""}`,
                undo: async () => {
                  for (const id of ids) await deleteDrink(db, id);
                },
              };
            })
          }
        >
          {t.name}
        </button>
      ))}
    </div>
  );
}

/** Today's mood and energy, starting from what is already saved for today. */
function CheckInPart({ db, version, run }: PartProps) {
  const [mood, setMood] = useState<number | null>(null);
  const [energy, setEnergy] = useState<number | null>(null);
  const [body, setBody] = useState("");
  useEffect(() => {
    void getDayNote(db, today()).then((n) => {
      setMood(n?.mood ?? null);
      setEnergy(n?.energy ?? null);
      setBody(n?.body ?? "");
    });
  }, [db, version]);
  const save = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      const day = today();
      const before = await getDayNote(db, day);
      await saveDayNote(db, { day, mood, energy, body }, day);
      return {
        text: "Check-in saved",
        undo: async () => {
          await saveDayNote(db, { day, mood: before?.mood ?? null, energy: before?.energy ?? null, body: before?.body ?? "" }, day);
        },
      };
    });
  };
  return (
    <form className="quick-log-form" onSubmit={save}>
      <ScaleRating label="Mood" value={mood} onChange={setMood} words={SCALE} />
      <ScaleRating label="Energy" value={energy} onChange={setEnergy} words={SCALE} />
      <input aria-label="A note" placeholder="A note (optional)" value={body} maxLength={4000} onChange={(e) => setBody(e.target.value)} />
      <button type="submit" disabled={mood === null && energy === null && !body.trim()}>
        Save check-in
      </button>
    </form>
  );
}

/** A weigh-in in kg (as the journal keeps it), starting from the last one. */
function WeightPart({ db, version, run }: PartProps) {
  const [value, setValue] = useState("");
  const [last, setLast] = useState<number | null>(null);
  useEffect(() => {
    const t = today();
    void listMeasurements(db, addDays(t, -365), t, "weight").then((ms) => {
      const v = ms.reduce<{ at: number; v: number | null }>((b, m) => (m.atMs > b.at ? { at: m.atMs, v: m.value } : b), { at: -1, v: null }).v;
      setLast(v);
    });
  }, [db, version]);
  const save = (e: FormEvent) => {
    e.preventDefault();
    const kg = Number(value.replace(",", "."));
    void run(async () => {
      const id = await addMeasurement(db, { kind: "weight", value: kg, unit: "kg", timeZone: timeZone() });
      setValue("");
      return { text: `Weight ${kg.toFixed(1)} kg`, undo: () => deleteMeasurement(db, id) };
    });
  };
  return (
    <form className="quick-log-row" onSubmit={save}>
      <input
        aria-label="Weight in kg"
        inputMode="decimal"
        placeholder={last !== null ? `${last.toFixed(1)}` : "kg"}
        value={value}
        onChange={(e) => setValue(e.target.value.replace(/[^\d.,]/g, ""))}
      />
      <span className="muted">kg</span>
      <button type="submit" disabled={!Number.isFinite(Number(value.replace(",", "."))) || !value}>
        Save
      </button>
    </form>
  );
}
