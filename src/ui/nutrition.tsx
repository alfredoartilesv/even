import { Meter, StackedBar } from "./charts/figures";
import { seriesColor } from "./charts/frame";
import { kcalFromMacros } from "../core/health";
import { numOrNull } from "./common";
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
          <div className={over ? "warning small" : "muted small"}>
            {over ? `${kcal(eaten - target)} kcal over target` : `${kcal(target - eaten)} kcal left`}
          </div>
        </Meter>
      )}
      {fromDrinks > 0 && <div className="muted small">including {kcal(fromDrinks)} kcal from drinks</div>}
    </>
  );
}

export interface MacroNumbers {
  calories: number | null;
  proteinG: number | null;
  carbsG: number | null;
  fatG: number | null;
}

/** Per macro: label, unit, color slot (protein 1, carbs 2, fat 3, as in MacroSplit) and whether the target is a floor. */
const BUDGET: { key: keyof MacroNumbers; label: string; unit: string; slot?: number; floor?: boolean }[] = [
  { key: "calories", label: "Calories", unit: "kcal" },
  { key: "proteinG", label: "Protein", unit: "g", slot: 1, floor: true },
  { key: "carbsG", label: "Carbs", unit: "g", slot: 2 },
  { key: "fatG", label: "Fat", unit: "g", slot: 3 },
];

/** What a budget tile says in big type and underneath: left, over, to go, or just the amount without a target. */
export function budgetText(eaten: number, target: number | null, unit: string, floor = false): { big: string; small: string; over: boolean } {
  const n = (v: number) => kcal(v);
  if (target === null) return { big: n(eaten), small: `${unit} eaten · no target`, over: false };
  const left = target - eaten;
  if (floor)
    return left > 0
      ? { big: n(left), small: `${unit} to go · ${n(eaten)} of ${n(target)}`, over: false }
      : { big: n(eaten), small: `${unit} · target met`, over: false };
  return left >= 0
    ? { big: n(left), small: `${unit} left · ${n(eaten)} of ${n(target)}`, over: false }
    : { big: n(-left), small: `${unit} over · ${n(eaten)} of ${n(target)}`, over: true };
}

/**
 * The day's budget, one tile per number: calories across the top, protein, carbs and fat under it.
 * Each says what is left (or over, or still to go for protein) in big type, eaten of target under
 * it, and a bar filling toward the target in the macro's own color. Without a target a tile shows
 * what was eaten. Text carries every number, so color is never the only signal.
 */
export function MacroBudget({ eaten, targets, fromDrinks = 0 }: { eaten: MacroNumbers; targets: MacroNumbers; fromDrinks?: number }) {
  return (
    <div className="macro-tiles" role="group" aria-label="What is left today">
      {BUDGET.map((b) => {
        const e = eaten[b.key] ?? 0;
        const t = targets[b.key];
        const text = budgetText(e, t, b.unit, b.floor);
        return (
          <div key={b.key} className={b.key === "calories" ? "macro-tile wide" : "macro-tile"}>
            <div className="small macro-label">
              {b.slot && <span className="viz-key rect" style={{ background: seriesColor(b.slot) }} aria-hidden />}
              {b.label}
            </div>
            <div className="viz-tile-value">
              <strong className={text.over ? "warning" : undefined}>{text.big}</strong>
            </div>
            {/* "kcal left" under the number, "1,500 of 2,000" on its own line so narrow tiles do not break it mid-phrase. */}
            {text.small.split(" · ").map((line, i) => (
              <div key={i} className={i === 0 && text.over ? "small warning" : "small muted"}>
                {line}
              </div>
            ))}
            {t !== null && <Meter value={e} max={t} label={`${b.label}: ${text.big} ${text.small}`} slot={b.slot} overIsFine={b.floor} />}
            {b.key === "calories" && fromDrinks > 0 && <div className="muted small">including {kcal(fromDrinks)} kcal from drinks</div>}
          </div>
        );
      })}
    </div>
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

/** kcal from the macros typed so far, when they are all valid numbers (4/4/9 kcal per gram); null otherwise. */
export function estimateKcal(d: Pick<MacroDraft, "proteinG" | "carbsG" | "fatG">): number | null {
  const m = { proteinG: numOrNull(d.proteinG), carbsG: numOrNull(d.carbsG), fatG: numOrNull(d.fatG) };
  if (Object.values(m).some((v) => v !== null && !(v >= 0))) return null;
  const k = kcalFromMacros(m);
  return k === null ? null : Math.round(k);
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
