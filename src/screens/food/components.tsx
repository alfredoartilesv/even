import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import type { SqlDriver } from "../../db/driver";
import { photoDataUrl, type FoodEntry, type Macros, type PhotoInput, type SavedMeal } from "../../domain/food/food";
import { localDay } from "../../core/tz";
import { MEALS, type Meal } from "../../domain/food/suggest";
import { failed, fmtDay, numOrNull } from "../../ui/common";
import { estimateKcal, MacroSteppers } from "../../ui/nutrition";
import { downscalePhoto, photoInputUrl } from "./photo";
import { Icon, type IconName } from "../../ui/icons";

export const MEAL_LABEL: Record<Meal, string> = { breakfast: "Breakfast", lunch: "Lunch", dinner: "Dinner", snack: "Snack", prep: "Meal prep" };
export const kcal = (n: number | null) => (n === null ? "–" : Math.round(n).toLocaleString());
const time = (ms: number) => new Date(ms).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });

// Photos are loaded one at a time from SQLite; keep the ones already shown.
const photoCache = new Map<string, string | null>();

export function PhotoThumb({ db, id, size = 48 }: { db: SqlDriver; id: string | null; size?: number }) {
  const [url, setUrl] = useState<string | null>(id ? (photoCache.get(id) ?? null) : null);
  useEffect(() => {
    if (!id) return setUrl(null);
    if (photoCache.has(id)) return setUrl(photoCache.get(id)!);
    let live = true;
    void photoDataUrl(db, id).then((u) => {
      photoCache.set(id, u);
      if (live) setUrl(u);
    });
    return () => {
      live = false;
    };
  }, [db, id]);
  // No photo: nothing, so a list without pictures has no empty boxes; one still loading keeps its place.
  if (!id) return null;
  if (!url) return <div className="thumb empty" style={{ width: size, height: size }} aria-hidden />;
  return <img className="thumb" src={url} width={size} height={size} alt="" />;
}

/** Take or choose a photo. On the phone, capture opens the camera. */
export function PhotoPicker({ value, onChange }: { value: PhotoInput | null; onChange: (p: PhotoInput | null) => void }) {
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="photo-picker">
      {value && <img className="thumb" src={photoInputUrl(value)} width={72} height={72} alt="Meal photo" />}
      <label className="file-button">
        {value ? "Retake photo" : "Add photo"}
        <input
          type="file"
          accept="image/*"
          capture="environment"
          onChange={async (e) => {
            const f = e.target.files?.[0];
            e.target.value = "";
            if (!f) return;
            try {
              setError(null);
              onChange(await downscalePhoto(f));
            } catch (err) {
              setError(failed(err, "food.photo")!.text);
            }
          }}
        />
      </label>
      {value && (
        <button type="button" className="secondary" onClick={() => onChange(null)}>
          Remove photo
        </button>
      )}
      {error && <span className="error small">{error}</span>}
    </div>
  );
}

/** "13:05": the local clock time of an instant, for a time field. */
export const clockOf = (ms: number, timeZone: string) =>
  new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone }).format(ms);

export interface MealDraft {
  name: string;
  meal: Meal | null;
  calories: string;
  proteinG: string;
  carbsG: string;
  fatG: string;
  notes: string;
  /** When it was eaten, editing an entry: its local day and "HH:MM". Moving it changes these. */
  day?: string;
  time?: string;
}

export const emptyDraft = (meal: Meal | null): MealDraft => ({ name: "", meal, calories: "", proteinG: "", carbsG: "", fatG: "", notes: "" });

const str = (n: number | null) => (n === null ? "" : String(n));
export const draftFrom = (m: Macros & { name: string; meal: Meal | null; notes: string | null }): MealDraft => ({
  name: m.name,
  meal: m.meal,
  calories: str(m.calories),
  proteinG: str(m.proteinG),
  carbsG: str(m.carbsG),
  fatG: str(m.fatG),
  notes: m.notes ?? "",
});

/**
 * Parse the form. Bad numbers come back as NaN and the db layer rejects them with a message.
 * Empty kcal with macros filled in is estimated from the macros (4/4/9 kcal per gram).
 */
export const parseDraft = (d: MealDraft) => ({
  name: d.name,
  meal: d.meal,
  calories: numOrNull(d.calories) ?? estimateKcal(d),
  proteinG: numOrNull(d.proteinG),
  carbsG: numOrNull(d.carbsG),
  fatG: numOrNull(d.fatG),
  notes: d.notes,
});

/** Name, slot, macros and notes. The caller adds its own buttons and extras as children. */
/** Each meal's icon, the same as Eat again's rows. */
export const MEAL_ICON: Record<Meal, IconName> = { breakfast: "coffee", lunch: "bowl", dinner: "food", snack: "apple", prep: "mealprep" };

/**
 * A meal's fields (the owner's design, 15 Nov 2026): the name beside the meal's icon, the meal as
 * buttons with icons, calories and macros as steppers (typed, or − and +), what the caller adds
 * (when it was eaten), then the notes, folded until there is one or the owner opens them.
 */
export function MealFields({
  draft,
  onChange,
  saved,
  allowPrep = false,
  children,
}: {
  draft: MealDraft;
  onChange: (d: MealDraft) => void;
  /** Offered as name completions; picking one fills the macros. */
  saved?: SavedMeal[];
  allowPrep?: boolean;
  /** Shown between the numbers and the notes: the day and time of a logged meal. */
  children?: ReactNode;
}) {
  const set = (patch: Partial<MealDraft>) => onChange({ ...draft, ...patch });
  const [noteOpen, setNoteOpen] = useState(Boolean(draft.notes));
  return (
    <div className="meal-form stack">
      <div className="meal-form-head">
        <span className={`tap-icon ${draft.meal ?? ""}`} aria-hidden>
          <Icon name={draft.meal ? MEAL_ICON[draft.meal] : "food"} size={22} />
        </span>
        <input
          className="meal-form-name"
          aria-label="What did you eat?"
          placeholder="What did you eat?"
          list={saved ? "saved-meal-names" : undefined}
          value={draft.name}
          onChange={(e) => {
            const name = e.target.value;
            const hit = saved?.find((s) => s.name.toLowerCase() === name.trim().toLowerCase());
            onChange(hit ? { ...draftFrom(hit), meal: draft.meal ?? hit.meal, name } : { ...draft, name });
          }}
          required
        />
        {saved && (
          <datalist id="saved-meal-names">
            {saved.map((s) => (
              <option key={s.id} value={s.name} />
            ))}
          </datalist>
        )}
      </div>
      <div className="meal-form-meals" role="radiogroup" aria-label="Meal">
        {MEALS.filter((m) => allowPrep || m !== "prep" || draft.meal === "prep").map((m) => (
          <button
            type="button"
            key={m}
            role="radio"
            aria-checked={draft.meal === m}
            className={draft.meal === m ? `on ${m}` : m}
            onClick={() => set({ meal: draft.meal === m ? null : m })}
          >
            <Icon name={MEAL_ICON[m]} size={20} />
            {MEAL_LABEL[m]}
          </button>
        ))}
      </div>
      <MacroSteppers draft={draft} set={set} />
      {children}
      {noteOpen ? (
        <label>
          Notes
          <input value={draft.notes} autoFocus={!draft.notes} onChange={(e) => set({ notes: e.target.value })} />
        </label>
      ) : (
        <button type="button" className="link meal-form-line" onClick={() => setNoteOpen(true)}>
          <Icon name="note" size={18} />
          <span className="grow">Add a note</span>
          <Icon name="plus" size={18} />
        </button>
      )}
    </div>
  );
}

/** When a logged meal was eaten as one line, "Today, 20:00", with the day and time fields behind Change. */
export function WhenLine({ day, at, today, onChange }: { day: string; at: string; today: string; onChange: (day: string, at: string) => void }) {
  const [open, setOpen] = useState(false);
  if (!open)
    return (
      <div className="meal-form-line">
        <Icon name="calendar" size={18} />
        <span className="grow">
          {day === today ? "Today" : cap(fmtDay(day))}, {at}
        </span>
        <button type="button" className="link accent" onClick={() => setOpen(true)}>
          Change
        </button>
      </div>
    );
  return (
    <div className="grid">
      <label>
        Day
        <input type="date" value={day} max={today} onChange={(x) => onChange(x.target.value, at)} />
      </label>
      <label>
        Time
        <input type="time" value={at} onChange={(x) => onChange(day, x.target.value)} />
      </label>
    </div>
  );
}

/** Save across the form, Cancel and Delete (when there is one) under it at either end. */
export function FormFooter({ save = "Save", onCancel, onDelete }: { save?: string; onCancel: () => void; onDelete?: () => void }) {
  return (
    <div className="form-footer">
      <button type="submit" className="form-footer-save">
        {save}
      </button>
      <div className="form-footer-row">
        <button type="button" className="link" onClick={onCancel}>
          Cancel
        </button>
        {onDelete && (
          <button type="button" className="link danger" onClick={onDelete}>
            <Icon name="trash" size={16} /> Delete
          </button>
        )}
      </div>
    </div>
  );
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

interface EntryActions {
  onAgain: (e: FoodEntry) => void;
  onSave: (e: FoodEntry) => void;
  onUpdate: (e: FoodEntry, d: MealDraft) => Promise<boolean>;
  onDelete: (e: FoodEntry) => void;
}

/** A day's entries grouped by meal, each with log-again, bookmark, edit (time and day too) and delete. */
export function EntryList({ db, entries, timeZone, ...act }: { db: SqlDriver; entries: FoodEntry[]; timeZone: string } & EntryActions) {
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<MealDraft | null>(null);
  const groups = [...MEALS, null].map((m) => ({ meal: m, items: entries.filter((e) => e.meal === m) })).filter((g) => g.items.length);
  if (!entries.length) return <p className="muted small">Nothing logged on this day yet.</p>;

  async function submit(e: FormEvent, entry: FoodEntry) {
    e.preventDefault();
    if (draft && (await act.onUpdate(entry, draft))) setEditing(null);
  }

  return (
    <>
      {groups.map((g) => (
        <div key={g.meal ?? "other"}>
          <div className="row group-head">
            <h3>{g.meal ? MEAL_LABEL[g.meal] : "Other"}</h3>
            <span className="muted small">{kcal(g.items.reduce((n, e) => n + (e.calories ?? 0), 0))} kcal</span>
          </div>
          <ul className="entries">
            {g.items.map((e) =>
              editing === e.id && draft ? (
                <li key={e.id}>
                  <form className="stack tight grow" onSubmit={(ev) => submit(ev, e)}>
                    <MealFields draft={draft} onChange={setDraft} allowPrep={e.meal === "prep"}>
                      {!e.fromPrep && (
                        <WhenLine
                          day={draft.day ?? e.localDay}
                          at={draft.time ?? ""}
                          today={localDay(Date.now(), timeZone)}
                          onChange={(day, at) => setDraft({ ...draft, day, time: at })}
                        />
                      )}
                    </MealFields>
                    <FormFooter onCancel={() => setEditing(null)} onDelete={() => act.onDelete(e)} />
                  </form>
                </li>
              ) : (
                <li key={e.id}>
                  <PhotoThumb db={db} id={e.photoId} />
                  <div className="grow">
                    <div>{e.name}</div>
                    <div className="muted small">
                      {time(e.eatenAtMs)} · {kcal(e.calories)} kcal{e.proteinG !== null && ` · ${kcal(e.proteinG)} g protein`}
                      {e.notes && ` · ${e.notes}`}
                    </div>
                    <div className="entry-actions">
                      <button className="secondary" onClick={() => act.onAgain(e)}>
                        Again
                      </button>
                      <button className="secondary" onClick={() => act.onSave(e)} aria-pressed={Boolean(e.savedMealId)}>
                        {e.savedMealId ? "★ Starred" : "☆ Star"}
                      </button>
                      <button
                        className="secondary"
                        onClick={() => {
                          setDraft({ ...draftFrom(e), day: e.localDay, time: clockOf(e.eatenAtMs, timeZone) });
                          setEditing(e.id);
                        }}
                      >
                        Edit
                      </button>
                      <button className="icon-button ghost" aria-label={`Delete ${e.name}`} onClick={() => act.onDelete(e)}>
                        <Icon name="trash" size={18} />
                      </button>
                    </div>
                  </div>
                </li>
              ),
            )}
          </ul>
        </div>
      ))}
    </>
  );
}
