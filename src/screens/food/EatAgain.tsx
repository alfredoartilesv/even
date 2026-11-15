import { useState } from "react";
import type { SqlDriver } from "../../db/driver";
import { usualMeal, type Candidate, type Meal } from "../../domain/food/suggest";
import { Icon, type IconName } from "../../ui/icons";
import { kcal, PhotoThumb } from "./components";

type Slot = Exclude<Meal, "prep">;
const SLOTS: Slot[] = ["breakfast", "lunch", "dinner", "snack"];
const LABEL: Record<Slot, string> = { breakfast: "Breakfast", lunch: "Lunch", dinner: "Dinner", snack: "Snacks" };
const ICON: Record<Slot, IconName> = { breakfast: "coffee", lunch: "bowl", dinner: "food", snack: "apple" };
/** Rows per meal: enough to find the usual ones without a long list. */
const SHOWN = 5;

export interface Logged {
  entryId: string;
  meal: Meal;
}

/**
 * Eat again: the meals you have most, filtered by meal (the one for now first), each with a
 * round + that logs it. The + turns into a check that undoes it, and a bar under the list says
 * what was logged, so the owner sees the tap worked without scrolling up to the message.
 */
export function EatAgain({
  db,
  suggested,
  slot,
  isToday,
  onLog,
  onUndo,
}: {
  db: SqlDriver;
  suggested: Candidate[];
  /** The meal for now on today, or lunch for another day. */
  slot: Meal;
  isToday: boolean;
  onLog: (c: Candidate) => Promise<Logged | null>;
  onUndo: (entryId: string) => Promise<void>;
}) {
  const now: Slot = slot === "prep" ? "lunch" : slot;
  const [chip, setChip] = useState<Slot>(now);
  const [logged, setLogged] = useState<(Logged & { key: string; calories: number | null }) | null>(null);
  const order = [now, ...SLOTS.filter((s) => s !== now)];
  // A meal never given a slot shows with the meal for now, so it is never out of reach.
  const slotOf = (c: Candidate): Slot => {
    const m = usualMeal(c);
    return m && m !== "prep" ? m : now;
  };
  const rows = suggested.filter((c) => slotOf(c) === chip).slice(0, SHOWN);

  const log = async (c: Candidate) => {
    const r = await onLog(c);
    if (r) setLogged({ ...r, key: c.key, calories: c.calories });
  };
  const undo = async () => {
    if (!logged) return;
    await onUndo(logged.entryId);
    setLogged(null);
  };

  return (
    <section className="eat-again" aria-label="Eat again">
      <div className="eat-again-head">
        <h3>Eat again</h3>
        <span className="muted small">Your usual meals</span>
      </div>
      <div className="chips eat-again-chips" role="group" aria-label="Meal">
        {order.map((s) => (
          <button key={s} type="button" className={chip === s ? `chip active ${s}` : "chip"} aria-pressed={chip === s} onClick={() => setChip(s)}>
            {LABEL[s]}
            {isToday && s === now ? " now" : ""}
          </button>
        ))}
      </div>
      {rows.length === 0 ? (
        <p className="muted small eat-again-empty">Nothing you usually have for {LABEL[chip].toLowerCase()} yet. Meals you log twice show up here.</p>
      ) : (
        <ul className="eat-again-list">
          {rows.map((c) => {
            const done = logged?.key === c.key;
            const s = slotOf(c);
            const facts = [c.calories !== null ? `${kcal(c.calories)} kcal` : null, c.proteinG !== null ? `${Math.round(c.proteinG)} g protein` : null].filter(
              Boolean,
            );
            const usual = usualMeal(c);
            const habit = [usual && usual !== "prep" ? `Usually ${usual}` : null, c.uses > 1 ? `${c.uses}× this month` : null].filter(Boolean).join(" · ");
            return (
              <li key={c.key} className="eat-again-row">
                {c.photoId ? (
                  <PhotoThumb db={db} id={c.photoId} size={42} />
                ) : (
                  <span className={`eat-again-icon ${s}`} aria-hidden>
                    <Icon name={ICON[s]} size={22} />
                  </span>
                )}
                <span className="eat-again-text">
                  <span className="eat-again-name">
                    {c.name}
                    {c.savedMealId && (
                      <span className="eat-again-star" aria-label="Saved meal">
                        {" "}
                        ★
                      </span>
                    )}
                  </span>
                  {facts.length > 0 && <span className="muted small block">{facts.join(" · ")}</span>}
                  {isToday && c.loggedToday ? (
                    <span className="eat-again-had small block">✓ Had it today</span>
                  ) : (
                    habit && <span className="eat-again-usual small block">{habit}</span>
                  )}
                </span>
                <button
                  type="button"
                  className={done ? "eat-again-add done" : "eat-again-add"}
                  aria-label={done ? `Undo logging ${c.name}` : `Log ${c.name}`}
                  onClick={() => void (done ? undo() : log(c))}
                >
                  <Icon name={done ? "check" : "plus"} size={22} />
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {logged && (
        <div className="eat-again-toast" role="status">
          <span>
            Logged for {logged.meal}
            {logged.calories !== null ? ` · ${kcal(logged.calories)} kcal` : ""}
          </span>
          <button type="button" className="link accent" onClick={() => void undo()}>
            Undo
          </button>
        </div>
      )}
    </section>
  );
}
