import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { SqlDriver } from "../../../db/driver";
import { DEFAULT_MEAL_PREP, deleteMealPrep, listMealPreps, logBatch, normalizeTag, saveMealPrep, type MealPrep, type MealPrepInput } from "../mealPrep";
import { addRecipesToShopping, formatQuantity, normalizeUnit } from "../shopping";
import { kcalFromMacros } from "../../../core/health";
import { failed, MsgLine, numOrNull, plural, timeZone, type Msg } from "../../../ui/common";
import { Stepper } from "../../../ui/controls";
import { estimateKcal, MacroInputs } from "../../../ui/nutrition";

interface Props {
  db: SqlDriver;
  tag: string | null;
  allTags: string[];
  version: number;
  /** Called after a recipe is saved or deleted, a batch is cooked, or the shopping list changes. */
  onChanged: () => void;
  /** Open the shopping list, or Stock (after cooking). */
  onShopping: () => void;
  onStock: () => void;
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

/** A new recipe that starts as a copy of another. */
function copyDraft(p: MealPrep): Draft {
  const d = toDraft(p);
  return { ...d, id: undefined, name: `${p.name} (copy)`, ingredients: d.ingredients.map((i) => ({ ...i, id: undefined })) };
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
    calories: num(d.calories, "Calories") ?? estimateKcal(d),
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

const ingredientText = (p: MealPrep) =>
  p.ingredients
    .map((i) => {
      const n = normalizeUnit(i.quantity, i.unit);
      const q = formatQuantity(n.quantity, n.unit);
      return q ? `${i.name} ${q}` : i.name;
    })
    .join(", ");

/** "520 kcal · P 42 · C 50 · F 14 g a portion", from what the recipe has. */
function macroLine(p: Pick<MealPrep, "calories" | "proteinG" | "carbsG" | "fatG">): string | null {
  const k = p.calories ?? kcalFromMacros(p);
  const g = [p.proteinG !== null && `P ${p.proteinG}`, p.carbsG !== null && `C ${p.carbsG}`, p.fatG !== null && `F ${p.fatG}`].filter(Boolean);
  if (k === null && !g.length) return null;
  return `${[k !== null && `${Math.round(k)} kcal`, g.length && `${g.join(" · ")} g`].filter(Boolean).join(" · ")} a portion`;
}

/** What "Cook" asks: portions made and how many go straight in the freezer. */
interface Cook {
  id: string;
  portions: number;
  frozen: number;
}

/**
 * Recipes: each card says what a portion holds, how long it keeps and what goes in it, with Edit,
 * Cook (records a batch into Stock) and Duplicate. Set batches on the recipes you will cook and
 * add all their ingredients to the shopping list in one go.
 */
export function RecipesView({ db, tag, allTags, version, onChanged, onShopping, onStock }: Props) {
  const [preps, setPreps] = useState<MealPrep[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [tagInput, setTagInput] = useState("");
  const [batches, setBatches] = useState<Record<string, number>>({});
  const [cooking, setCooking] = useState<Cook | null>(null);
  const [search, setSearch] = useState("");
  const [msg, setMsg] = useState<Msg>(null);
  const [next, setNext] = useState<"shopping" | "stock" | null>(null);

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
      setMsg(failed(err, "mealprep"));
    }
  }

  async function cook(e: FormEvent) {
    e.preventDefault();
    if (!cooking) return;
    const p = preps.find((x) => x.id === cooking.id);
    try {
      await logBatch(db, { mealPrepId: cooking.id, portions: cooking.portions, frozen: cooking.frozen, timeZone: timeZone() });
      setMsg({
        kind: "ok",
        text: `Cooked ${plural(cooking.portions, "portion")} of ${p?.name ?? "the recipe"}${cooking.frozen ? `, ${cooking.frozen} in the freezer` : ""}.`,
      });
      setNext("stock");
      setCooking(null);
      onChanged();
    } catch (err) {
      setMsg(failed(err, "mealprep"));
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
      setNext("shopping");
      onChanged();
    } catch (err) {
      setMsg(failed(err, "mealprep"));
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
          <MacroInputs draft={draft} set={set} kcalHint={estimateKcal(draft)} />
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

  const q = search.trim().toLowerCase();
  const shown = q ? preps.filter((p) => p.name.toLowerCase().includes(q) || p.ingredients.some((i) => i.name.toLowerCase().includes(q))) : preps;
  const picked = Object.values(batches).filter((n) => n > 0).length;

  return (
    <div>
      <div className="row">
        <p className="muted small grow">Pick how many batches you will cook, then put their ingredients on the shopping list.</p>
        <button onClick={() => setDraft(toDraft())}>New recipe</button>
      </div>
      {preps.length > 5 && <input type="search" placeholder="Find a recipe or ingredient" value={search} onChange={(e) => setSearch(e.target.value)} />}
      <div className="row">
        <MsgLine msg={msg} />
        {next && (
          <button type="button" className="link small accent" onClick={next === "shopping" ? onShopping : onStock}>
            {next === "shopping" ? "Open the shopping list ›" : "Open Stock ›"}
          </button>
        )}
      </div>
      {shown.map((p) => (
        <section key={p.id} className="card recipe-card">
          <div className="row">
            <strong className="grow">{p.name}</strong>
            <span className="muted small">{plural(p.portions, "portion")}</span>
          </div>
          {macroLine(p) && <div className="small">{macroLine(p)}</div>}
          <div className="muted small">
            Fridge {p.fridgeDays} d · freezer {p.freezerDays} d{p.thawHours ? ` · defrost ${p.thawHours} h` : ""}
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
            <details className="more">
              <summary className="small muted">{plural(p.ingredients.length, "ingredient")}</summary>
              <div className="small">{ingredientText(p)}</div>
            </details>
          )}
          {p.notes && <div className="muted small clamp">{p.notes}</div>}

          {cooking?.id === p.id ? (
            <form className="stack tight cook-form" onSubmit={cook}>
              <div className="row">
                <span className="small grow">Portions made</span>
                <Stepper
                  value={cooking.portions}
                  min={1}
                  max={50}
                  label="Portions made"
                  onChange={(n) => setCooking({ ...cooking, portions: n, frozen: Math.min(cooking.frozen, n) })}
                />
              </div>
              <div className="row">
                <span className="small grow">Straight to the freezer</span>
                <Stepper
                  value={cooking.frozen}
                  min={0}
                  max={cooking.portions}
                  label="Portions to freeze"
                  onChange={(n) => setCooking({ ...cooking, frozen: n })}
                />
              </div>
              <div className="actions">
                <button type="submit">Log batch</button>
                <button type="button" className="secondary" onClick={() => setCooking(null)}>
                  Cancel
                </button>
              </div>
            </form>
          ) : (
            <div className="recipe-actions">
              <div className="actions compact">
                <button className="secondary" onClick={() => setDraft(toDraft(p))}>
                  Edit
                </button>
                <button className="secondary" onClick={() => setCooking({ id: p.id, portions: p.portions, frozen: 0 })}>
                  Cook
                </button>
                <button className="secondary" onClick={() => setDraft(copyDraft(p))}>
                  Duplicate
                </button>
              </div>
              <Stepper
                value={batches[p.id] ?? 0}
                min={0}
                max={20}
                label={`Batches of ${p.name} to shop for`}
                onChange={(n) => setBatches({ ...batches, [p.id]: n })}
              />
            </div>
          )}
        </section>
      ))}
      {!shown.length && <p className="muted">{q ? "No recipe matches." : `No recipes${tag ? ` tagged ${tag}` : ""} yet. Add one with New recipe.`}</p>}
      {preps.length > 0 && (
        <div className="sticky-action">
          <button className="wide-button" disabled={!picked} onClick={toShopping}>
            {picked ? `Add ${plural(picked, "recipe")} to the shopping list` : "Set batches to shop for"}
          </button>
        </div>
      )}
    </div>
  );
}
