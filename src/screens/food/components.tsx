import { useEffect, useState, type FormEvent } from "react";
import type { SqlDriver } from "../../db/driver";
import { photoDataUrl, type FoodEntry, type Macros, type PhotoInput, type SavedMeal } from "../../db/food";
import { addDays } from "../../lib/tz";
import { MEALS, type Meal } from "../../meals/suggest";
import { fmtDay, numOrNull } from "../mealprep/common";
import { downscalePhoto, photoInputUrl } from "./photo";

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
              setError((err as Error).message);
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

/** Today against the target: a single meter, numbers in text so the color is never the only signal. */
export function CalorieMeter({ eaten, target, macros }: { eaten: number; target: number | null; macros: Macros }) {
  const over = target !== null && eaten > target;
  const pct = target ? Math.min(100, (eaten / target) * 100) : 0;
  return (
    <div className="meter-card">
      <div className="hero">
        <strong>{kcal(eaten)}</strong>
        <span className="muted"> kcal{target !== null && ` of ${kcal(target)}`}</span>
      </div>
      {target !== null && (
        <>
          <div className="meter" role="meter" aria-valuemin={0} aria-valuemax={target} aria-valuenow={eaten} aria-label="Calories today">
            <div className={over ? "fill over" : "fill"} style={{ width: `${pct}%` }} />
          </div>
          <div className={over ? "warning small" : "muted small"}>
            {over ? `${kcal(eaten - target)} kcal over target` : `${kcal(target - eaten)} kcal left`}
          </div>
        </>
      )}
      <div className="macros small">
        <span>Protein {kcal(macros.proteinG)} g</span>
        <span>Carbs {kcal(macros.carbsG)} g</span>
        <span>Fat {kcal(macros.fatG)} g</span>
      </div>
    </div>
  );
}

/** Seven days of calories, one bar a day, the target as a dashed line. Tap a bar to open the day. */
export function WeekChart({
  days,
  target,
  selected,
  onSelect,
}: {
  days: { day: string; calories: number | null }[];
  target: number | null;
  selected: string;
  onSelect: (day: string) => void;
}) {
  const max = Math.max(target ?? 0, ...days.map((d) => d.calories ?? 0), 1) * 1.1;
  const y = (v: number) => `${(v / max) * 100}%`;
  return (
    <div className="week">
      <div className="plot">
        {target !== null && (
          <div className="target" style={{ bottom: y(target) }}>
            <span className="small muted">target {kcal(target)}</span>
          </div>
        )}
        {days.map((d) => {
          const v = d.calories ?? 0;
          const over = target !== null && v > target;
          const label = `${fmtDay(d.day)}: ${d.calories === null ? "nothing logged" : `${kcal(v)} kcal${over ? ", over target" : ""}`}`;
          return (
            <button key={d.day} className={d.day === selected ? "col selected" : "col"} onClick={() => onSelect(d.day)} aria-label={label} title={label}>
              {d.day === selected && d.calories !== null && <span className="value small">{kcal(v)}</span>}
              <span className={over ? "bar over" : "bar"} style={{ height: v ? y(v) : 0 }} />
            </button>
          );
        })}
      </div>
      <div className="axis">
        {days.map((d) => (
          <span key={d.day} className={d.day === selected ? "small" : "small muted"}>
            {new Date(`${d.day}T12:00:00Z`).toLocaleDateString(undefined, { weekday: "narrow", timeZone: "UTC" })}
          </span>
        ))}
      </div>
    </div>
  );
}

export const weekEnding = (day: string) => Array.from({ length: 7 }, (_, i) => addDays(day, i - 6));

export interface MealDraft {
  name: string;
  meal: Meal | null;
  calories: string;
  proteinG: string;
  carbsG: string;
  fatG: string;
  notes: string;
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

/** Parse the form. Bad numbers come back as NaN and the db layer rejects them with a message. */
export const parseDraft = (d: MealDraft) => ({
  name: d.name,
  meal: d.meal,
  calories: numOrNull(d.calories),
  proteinG: numOrNull(d.proteinG),
  carbsG: numOrNull(d.carbsG),
  fatG: numOrNull(d.fatG),
  notes: d.notes,
});

/** Name, slot, macros and notes. The caller adds its own buttons and extras as children. */
export function MealFields({
  draft,
  onChange,
  saved,
  allowPrep = false,
}: {
  draft: MealDraft;
  onChange: (d: MealDraft) => void;
  /** Offered as name completions; picking one fills the macros. */
  saved?: SavedMeal[];
  allowPrep?: boolean;
}) {
  const set = (patch: Partial<MealDraft>) => onChange({ ...draft, ...patch });
  return (
    <>
      <label>
        What did you eat?
        <input
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
      </label>
      <div className="chips">
        {MEALS.filter((m) => allowPrep || m !== "prep" || draft.meal === "prep").map((m) => (
          <button type="button" key={m} className={draft.meal === m ? "chip active" : "chip"} onClick={() => set({ meal: draft.meal === m ? null : m })}>
            {MEAL_LABEL[m]}
          </button>
        ))}
      </div>
      <div className="grid">
        <label>
          kcal
          <input inputMode="decimal" value={draft.calories} onChange={(e) => set({ calories: e.target.value })} />
        </label>
        <label>
          Protein g
          <input inputMode="decimal" value={draft.proteinG} onChange={(e) => set({ proteinG: e.target.value })} />
        </label>
        <label>
          Carbs g
          <input inputMode="decimal" value={draft.carbsG} onChange={(e) => set({ carbsG: e.target.value })} />
        </label>
        <label>
          Fat g
          <input inputMode="decimal" value={draft.fatG} onChange={(e) => set({ fatG: e.target.value })} />
        </label>
      </div>
      <label>
        Notes
        <input value={draft.notes} onChange={(e) => set({ notes: e.target.value })} />
      </label>
    </>
  );
}

interface EntryActions {
  onAgain: (e: FoodEntry) => void;
  onSave: (e: FoodEntry) => void;
  onUpdate: (e: FoodEntry, d: MealDraft) => Promise<boolean>;
  onDelete: (e: FoodEntry) => void;
}

/** A day's entries grouped by meal, each with log-again, bookmark, edit and delete. */
export function EntryList({ db, entries, ...act }: { db: SqlDriver; entries: FoodEntry[] } & EntryActions) {
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<MealDraft | null>(null);
  const groups = [...MEALS, null].map((m) => ({ meal: m, items: entries.filter((e) => e.meal === m) })).filter((g) => g.items.length);
  if (!entries.length) return <p className="muted">Nothing logged.</p>;

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
                    <MealFields draft={draft} onChange={setDraft} allowPrep={e.meal === "prep"} />
                    <div className="actions">
                      <button type="submit">Save</button>
                      <button type="button" className="secondary" onClick={() => setEditing(null)}>
                        Cancel
                      </button>
                    </div>
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
                    <div className="actions compact">
                      <button className="secondary" onClick={() => act.onAgain(e)}>
                        Eat again
                      </button>
                      <button className="secondary" onClick={() => act.onSave(e)} aria-pressed={Boolean(e.savedMealId)}>
                        {e.savedMealId ? "★ Saved" : "☆ Save"}
                      </button>
                      <button
                        className="secondary"
                        onClick={() => {
                          setDraft(draftFrom(e));
                          setEditing(e.id);
                        }}
                      >
                        Edit
                      </button>
                      <button className="secondary danger" onClick={() => act.onDelete(e)}>
                        Delete
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
