import { useState, type FormEvent } from "react";
import type { SqlDriver } from "../../db/driver";
import { saveSuggestion, suggestionMeal } from "../../domain/food/food";
import { usualMeal, type Candidate, type Meal } from "../../domain/food/suggest";
import { failed, MsgLine, type Msg } from "../../ui/common";
import { Icon, type IconName } from "../../ui/icons";
import { draftFrom, kcal, MealFields, parseDraft, PhotoThumb, type MealDraft } from "./components";
import { DoneBar, QuickRow } from "./QuickRows";

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
 * round + that logs it and a pencil that edits it for next time. The + turns into a check that
 * undoes it, and a bar under the list says what was logged, so the tap shows where it was made.
 */
export function EatAgain({
  db,
  suggested,
  slot,
  isToday,
  onLog,
  onUndo,
  onSaved,
}: {
  db: SqlDriver;
  suggested: Candidate[];
  /** The meal for now on today, or lunch for another day. */
  slot: Meal;
  isToday: boolean;
  onLog: (c: Candidate) => Promise<Logged | null>;
  onUndo: (entryId: string) => Promise<void>;
  /** An edit was saved: reload the suggestions. */
  onSaved: () => void;
}) {
  const now: Slot = slot === "prep" ? "lunch" : slot;
  const [chip, setChip] = useState<Slot>(now);
  const [logged, setLogged] = useState<(Logged & { key: string; calories: number | null }) | null>(null);
  const [editing, setEditing] = useState<{ key: string; draft: MealDraft } | null>(null);
  const [msg, setMsg] = useState<Msg>(null);
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
  const edit = async (c: Candidate) => {
    setMsg(null);
    if (editing?.key === c.key) return setEditing(null);
    try {
      setEditing({ key: c.key, draft: draftFrom({ notes: null, ...(await suggestionMeal(db, c)) }) });
    } catch (err) {
      setMsg(failed(err, "food"));
    }
  };
  const save = async (e: FormEvent, c: Candidate) => {
    e.preventDefault();
    if (!editing) return;
    try {
      await saveSuggestion(db, c, parseDraft(editing.draft));
      setEditing(null);
      setMsg(null);
      onSaved();
    } catch (err) {
      setMsg(failed(err, "food"));
    }
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
        <ul className="tap-list">
          {rows.map((c) => {
            const s = slotOf(c);
            const facts = [c.calories !== null ? `${kcal(c.calories)} kcal` : null, c.proteinG !== null ? `${Math.round(c.proteinG)} g protein` : null].filter(
              Boolean,
            );
            const usual = usualMeal(c);
            const habit = [usual && usual !== "prep" ? `Usually ${usual}` : null, c.uses > 1 ? `${c.uses}× this month` : null].filter(Boolean).join(" · ");
            const open = editing?.key === c.key ? editing : null;
            return (
              <QuickRow
                key={c.key}
                picture={
                  c.photoId ? (
                    <PhotoThumb db={db} id={c.photoId} size={42} />
                  ) : (
                    <span className={`tap-icon ${s}`} aria-hidden>
                      <Icon name={ICON[s]} size={22} />
                    </span>
                  )
                }
                title={
                  <>
                    {c.name}
                    {c.savedMealId && (
                      <span className="eat-again-star" aria-label="Saved meal">
                        {" "}
                        ★
                      </span>
                    )}
                  </>
                }
                done={logged?.key === c.key}
                label={`Log ${c.name}`}
                onTap={() => void (logged?.key === c.key ? undo() : log(c))}
                onEdit={() => void edit(c)}
                editing={
                  open && (
                    <form className="tap-edit stack" onSubmit={(e) => void save(e, c)}>
                      <MealFields draft={open.draft} onChange={(d) => setEditing({ key: c.key, draft: d })} />
                      <p className="muted small">
                        {c.savedMealId ? "Changes this saved meal." : "Saves it as a saved meal."} Meals already logged stay as they were.
                      </p>
                      <MsgLine msg={msg} />
                      <div className="actions">
                        <button type="submit">Save</button>
                        <button type="button" className="secondary" onClick={() => setEditing(null)}>
                          Cancel
                        </button>
                      </div>
                    </form>
                  )
                }
              >
                {facts.length > 0 && <span className="muted small block">{facts.join(" · ")}</span>}
                {isToday && c.loggedToday ? (
                  <span className="tap-had small block">✓ Had it today</span>
                ) : (
                  habit && <span className="tap-sub small block">{habit}</span>
                )}
              </QuickRow>
            );
          })}
        </ul>
      )}
      {!editing && <MsgLine msg={msg} />}
      {logged && <DoneBar text={`Logged for ${logged.meal}${logged.calories !== null ? ` · ${kcal(logged.calories)} kcal` : ""}`} onUndo={() => void undo()} />}
    </section>
  );
}
