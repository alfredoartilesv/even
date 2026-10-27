import { Meter, StackedBar } from "./charts/figures";
import { fmtValue } from "./charts/scale";

/**
 * Nutrition figures: the calorie meter against a target and the macro split. Plain numbers
 * in, so food, meal prep and chat summaries can all use them.
 */

const kcal = (n: number) => Math.round(n).toLocaleString();

/** Today against the target, numbers in text so the color is never the only signal. */
export function CalorieMeter({ eaten, target, fromDrinks = 0 }: { eaten: number; target: number | null; fromDrinks?: number }) {
  const over = target !== null && eaten > target;
  return (
    <>
      <div className="hero">
        <strong>{kcal(eaten)}</strong>
        <span className="muted"> kcal{target !== null && ` of ${kcal(target)}`}</span>
      </div>
      {target !== null && (
        <Meter value={eaten} max={target} label="Calories today">
          <div className={over ? "warning small" : "muted small"}>{over ? `${kcal(eaten - target)} kcal over target` : `${kcal(target - eaten)} kcal left`}</div>
        </Meter>
      )}
      {fromDrinks > 0 && <div className="muted small">including {kcal(fromDrinks)} kcal from drinks</div>}
    </>
  );
}

/** Protein, carbs and fat by their calories (4/4/9 kcal per gram), grams in the legend. Fixed slots: protein 1, carbs 2, fat 3. */
export function MacroSplit({ proteinG, carbsG, fatG }: { proteinG: number | null; carbsG: number | null; fatG: number | null }) {
  if (proteinG === null && carbsG === null && fatG === null) return null;
  const p = proteinG ?? 0;
  const c = carbsG ?? 0;
  const f = fatG ?? 0;
  const parts = [
    { label: `Protein ${fmtValue(p)} g`, value: p * 4, slot: 1 },
    { label: `Carbs ${fmtValue(c)} g`, value: c * 4, slot: 2 },
    { label: `Fat ${fmtValue(f)} g`, value: f * 9, slot: 3 },
  ];
  return <StackedBar parts={parts} format={kcal} unit="kcal" label="Calories by macro" />;
}

/** The text a kcal and macros form holds: what the person typed, numbers parsed on save. */
export interface MacroDraft {
  calories: string;
  proteinG: string;
  carbsG: string;
  fatG: string;
}

/**
 * kcal, protein, carbs and fat as four decimal fields in a grid: a meal in the food log, a portion
 * of a recipe. `kcalHint` is the estimate from the macros, shown when kcal is left empty.
 */
export function MacroInputs({ draft, set, kcalHint = null }: { draft: MacroDraft; set: (patch: Partial<MacroDraft>) => void; kcalHint?: number | null }) {
  const field = (label: string, key: keyof MacroDraft) => (
    <label>
      {label}
      <input
        inputMode="decimal"
        value={draft[key]}
        placeholder={key === "calories" && kcalHint !== null ? `≈ ${kcalHint}` : undefined}
        title={key === "calories" && kcalHint !== null ? "Left empty, kcal is estimated from the macros" : undefined}
        onChange={(e) => set({ [key]: e.target.value })}
      />
    </label>
  );
  return (
    <div className="grid">
      {field("kcal", "calories")}
      {field("Protein g", "proteinG")}
      {field("Carbs g", "carbsG")}
      {field("Fat g", "fatG")}
    </div>
  );
}
