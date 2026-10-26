import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { SqlDriver } from "../../../db/driver";
import { DEFAULT_MEAL_PREP, deleteMealPrep, listMealPreps, normalizeTag, saveMealPrep, type MealPrep, type MealPrepInput } from "../mealPrep";
import { addRecipesToShopping, formatQuantity, normalizeUnit } from "../shopping";
import { MsgLine, numOrNull, plural, type Msg } from "../../../ui/common";

interface Props {
  db: SqlDriver;
  tag: string | null;
  allTags: string[];
  version: number;
  /** Called after a recipe is saved or deleted, or the shopping list changes. */
  onChanged: () => void;
}

const SUGGESTED_TAGS = ["breakfast", "lunch", "dinner", "snack"];

/** Form state: numbers as strings so fields can be empty while typing. */
interface Draft {
  id?: string;
  name: string;
  portions: string;
  fridgeDays: string;
  freezerDays: string;
  thawHours: string;
  calories: string;
  proteinG: string;
  carbsG: string;
  fatG: string;
  notes: string;
  tags: string[];
  ingredients: { id?: string; name: string; quantity: string; unit: string }[];
}

const s = (n: number | null) => (n === null ? "" : String(n));

function toDraft(p?: MealPrep): Draft {
  const v = p ?? { ...DEFAULT_MEAL_PREP, name: "", ingredients: [] };
  return {
    id: p?.id,
    name: v.name,
    portions: s(v.portions),
    fridgeDays: s(v.fridgeDays),
    freezerDays: s(v.freezerDays),
    thawHours: s(v.thawHours),
    calories: s(v.calories),
    proteinG: s(v.proteinG),
    carbsG: s(v.carbsG),
    fatG: s(v.fatG),
    notes: v.notes ?? "",
    tags: v.tags,
    ingredients: v.ingredients.map((i) => ({ id: i.id, name: i.name, quantity: s(i.quantity), unit: i.unit ?? "" })),
  };
}

function fromDraft(d: Draft): MealPrepInput {
  const int = (v: string, what: string) => {
    const n = Number(v);
    if (v.trim() === "" || !Number.isInteger(n)) throw new Error(`${what} must be a whole number`);
    return n;
  };
  const num = (v: string, what: string) => {
    const n = numOrNull(v);
    if (n !== null && !(n >= 0)) throw new Error(`${what} must be a number`);
    return n;
  };
  return {
    id: d.id,
    name: d.name,
    portions: int(d.portions, "Portions"),
    fridgeDays: int(d.fridgeDays, "Fridge days"),
    freezerDays: int(d.freezerDays, "Freezer days"),
    thawHours: int(d.thawHours, "Thaw hours"),
    calories: num(d.calories, "Calories"),
    proteinG: num(d.proteinG, "Protein"),
    carbsG: num(d.carbsG, "Carbs"),
    fatG: num(d.fatG, "Fat"),
    notes: d.notes,
    tags: d.tags,
    ingredients: d.ingredients
      .filter((i) => i.name.trim())
      .map((i) => ({ id: i.id, name: i.name, quantity: num(i.quantity, `Quantity for ${i.name}`), unit: i.unit })),
  };
}

export function RecipesView({ db, tag, allTags, version, onChanged }: Props) {
  const [preps, setPreps] = useState<MealPrep[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [tagInput, setTagInput] = useState("");
  const [batches, setBatches] = useState<Record<string, number>>({});
  const [msg, setMsg] = useState<Msg>(null);

  const load = useCallback(async () => setPreps(await listMealPreps(db, tag)), [db, tag]);
  useEffect(() => {
    void load();
  }, [load, version]);

  function addTag(raw: string) {
    if (!draft) return;
    const t = normalizeTag(raw);
    if (t && !draft.tags.includes(t)) setDraft({ ...draft, tags: [...draft.tags, t].sort() });
    setTagInput("");
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!draft) return;
    try {
      const input = fromDraft({ ...draft, tags: tagInput.trim() ? [...draft.tags, tagInput] : draft.tags });
      await saveMealPrep(db, input);
      setMsg({ kind: "ok", text: `Saved ${input.name.trim()}.` });
      setDraft(null);
      setTagInput("");
      onChanged();
    } catch (err) {
      setMsg({ kind: "error", text: (err as Error).message });
    }
  }

  async function remove() {
    if (!draft?.id || !confirm(`Delete ${draft.name}? Batches already cooked stay in stock.`)) return;
    await deleteMealPrep(db, draft.id);
    setDraft(null);
    setMsg({ kind: "ok", text: "Deleted." });
    onChanged();
  }

  async function toShopping() {
    const picks = Object.entries(batches)
      .filter(([, n]) => n > 0)
      .map(([mealPrepId, n]) => ({ mealPrepId, batches: n }));
    if (!picks.length) return setMsg({ kind: "error", text: "Set how many batches of each recipe you will cook." });
    try {
      const lines = await addRecipesToShopping(db, picks);
      setBatches({});
      setMsg({ kind: "ok", text: `Added ${plural(lines, "ingredient")} to the shopping list.` });
      onChanged();
    } catch (err) {
      setMsg({ kind: "error", text: (err as Error).message });
    }
  }

  if (draft) {
    const set = (patch: Partial<Draft>) => setDraft({ ...draft, ...patch });
    const tagOptions = [...new Set([...SUGGESTED_TAGS, ...allTags])].filter((t) => !draft.tags.includes(t));
    return (
      <form className="stack" onSubmit={save}>
        <h3>{draft.id ? "Edit recipe" : "New recipe"}</h3>
        <label>
          Name
          <input value={draft.name} onChange={(e) => set({ name: e.target.value })} required />
        </label>

        <div className="grid">
          <label>
            Portions per batch
            <input type="number" min={1} value={draft.portions} onChange={(e) => set({ portions: e.target.value })} />
          </label>
          <label>
            Fridge days
            <input type="number" min={1} value={draft.fridgeDays} onChange={(e) => set({ fridgeDays: e.target.value })} />
          </label>
          <label>
            Freezer days
            <input type="number" min={1} value={draft.freezerDays} onChange={(e) => set({ freezerDays: e.target.value })} />
          </label>
          <label>
            Defrost hours
            <input type="number" min={0} value={draft.thawHours} onChange={(e) => set({ thawHours: e.target.value })} />
          </label>
        </div>

        <fieldset>
          <legend className="small">Per portion (optional, goes to the food log when you eat one)</legend>
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
        </fieldset>

        <div>
          <div className="small">Tags</div>
          <div className="chips">
            {draft.tags.map((t) => (
              <button type="button" key={t} className="chip active" onClick={() => set({ tags: draft.tags.filter((x) => x !== t) })}>
                {t} ×
              </button>
            ))}
            {tagOptions.map((t) => (
              <button type="button" key={t} className="chip" onClick={() => addTag(t)}>
                + {t}
              </button>
            ))}
          </div>
          <input
            placeholder="New tag, then Enter"
            value={tagInput}
            onChange={(e) => setTagInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === ",") {
                e.preventDefault();
                addTag(tagInput);
              }
            }}
          />
        </div>

        <div className="stack tight">
          <div className="small">Ingredients for one batch</div>
          {draft.ingredients.map((ing, i) => {
            const upd = (patch: Partial<Draft["ingredients"][number]>) =>
              set({ ingredients: draft.ingredients.map((x, j) => (j === i ? { ...x, ...patch } : x)) });
            return (
              <div key={ing.id ?? `new${i}`} className="ingredient">
                <input aria-label="Ingredient" placeholder="Ingredient" value={ing.name} onChange={(e) => upd({ name: e.target.value })} />
                <input aria-label="Quantity" placeholder="Qty" inputMode="decimal" value={ing.quantity} onChange={(e) => upd({ quantity: e.target.value })} />
                <input aria-label="Unit" placeholder="Unit" value={ing.unit} onChange={(e) => upd({ unit: e.target.value })} />
                <button
                  type="button"
                  className="secondary"
                  aria-label={`Remove ${ing.name || "ingredient"}`}
                  onClick={() => set({ ingredients: draft.ingredients.filter((_, j) => j !== i) })}
                >
                  ×
                </button>
              </div>
            );
          })}
          <button type="button" className="secondary" onClick={() => set({ ingredients: [...draft.ingredients, { name: "", quantity: "", unit: "" }] })}>
            Add ingredient
          </button>
        </div>

        <label>
          Notes
          <textarea rows={3} value={draft.notes} onChange={(e) => set({ notes: e.target.value })} />
        </label>

        <MsgLine msg={msg} />
        <div className="actions">
          <button type="submit">Save</button>
          <button type="button" className="secondary" onClick={() => setDraft(null)}>
            Cancel
          </button>
          {draft.id && (
            <button type="button" className="secondary danger" onClick={remove}>
              Delete
            </button>
          )}
        </div>
      </form>
    );
  }

  return (
    <div>
      <div className="row">
        <p className="muted small">Set batches, then add the ingredients to your shopping list.</p>
        <button onClick={() => setDraft(toDraft())}>New recipe</button>
      </div>
      <MsgLine msg={msg} />
      {preps.map((p) => (
        <section key={p.id} className="card">
          <div className="row">
            <button className="link" onClick={() => setDraft(toDraft(p))}>
              <strong>{p.name}</strong>
            </button>
            <label className="inline">
              Batches
              <input
                type="number"
                min={0}
                className="qty"
                value={batches[p.id] ?? 0}
                onChange={(e) => setBatches({ ...batches, [p.id]: Math.max(0, Math.trunc(Number(e.target.value) || 0)) })}
              />
            </label>
          </div>
          <div className="muted small">
            {plural(p.portions, "portion")}, fridge {p.fridgeDays} d, freezer {p.freezerDays} d
            {p.calories !== null && `, ${p.calories} kcal`}
          </div>
          {p.tags.length > 0 && (
            <div className="chips">
              {p.tags.map((t) => (
                <span key={t} className="chip static">
                  {t}
                </span>
              ))}
            </div>
          )}
          {p.ingredients.length > 0 && (
            <div className="muted small">
              {p.ingredients
                .map((i) => {
                  const n = normalizeUnit(i.quantity, i.unit);
                  const q = formatQuantity(n.quantity, n.unit);
                  return q ? `${i.name} ${q}` : i.name;
                })
                .join(", ")}
            </div>
          )}
        </section>
      ))}
      {!preps.length && <p className="muted">No recipes{tag ? ` tagged ${tag}` : ""} yet.</p>}
      {preps.length > 0 && <button onClick={toShopping}>Add to shopping list</button>}
    </div>
  );
}
