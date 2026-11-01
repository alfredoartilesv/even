import { useCallback, useEffect, useState } from "react";
import { addDays } from "../../core/tz";
import type { SqlDriver } from "../../db/driver";
import {
  getPortionsPerDay,
  listMealPreps,
  loadStock,
  portionsEatenOn,
  setPortionsPerDay,
  type MealPrep,
  type StockEntry,
} from "../../domain/mealprep/mealPrep";
import { addRecipesToShopping, formatQuantity, listShopping, type ShoppingItem } from "../../domain/mealprep/shopping";
import { planDefrost, type Plan } from "../../domain/mealprep/stock";
import { StatTile } from "../../ui/charts";
import { changeRunner, fmtDay, MsgLine, plural, timeZone, today, type Msg } from "../../ui/common";
import { ChipGroup } from "../../ui/controls";
import { SectionHeader } from "../../ui/layout";
import { batchColors, PlanDays } from "../../ui/mealprep/components";
import { daysCovered } from "../../ui/mealprep/timeline";

interface Props {
  db: SqlDriver;
  version: number;
  onChanged: () => void;
  onRecipes: () => void;
  onShopping: () => void;
}

/** Two weeks ahead: long enough to see when the tuppers run out and the next cook is due. */
const HORIZON = 14;

/**
 * Which recipe to cook next: the one with the fewest portions left in stock, then the one cooked
 * longest ago, so the tuppers rotate.
 */
function nextRecipe(preps: MealPrep[], stock: StockEntry[]): MealPrep | null {
  const left = (p: MealPrep) => stock.filter((s) => s.batch.mealPrepId === p.id).reduce((n, s) => n + s.left, 0);
  const lastCook = (p: MealPrep) => Math.max(0, ...stock.filter((s) => s.batch.mealPrepId === p.id).map((s) => s.batch.cookedAtMs));
  return [...preps].sort((a, b) => left(a) - left(b) || lastCook(a) - lastCook(b))[0] ?? null;
}

/**
 * The tupper plan: how many days the fridge and freezer cover at the tuppers eaten a day, which
 * one is eaten each day of the next two weeks, the night to take each out of the freezer, and
 * what to cook before they run out.
 */
export function PlanView({ db, version, onChanged, onRecipes, onShopping }: Props) {
  const [stock, setStock] = useState<StockEntry[]>([]);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [perDay, setPerDay] = useState(1);
  const [preps, setPreps] = useState<MealPrep[]>([]);
  const [shopping, setShopping] = useState<ShoppingItem[]>([]);
  const [msg, setMsg] = useState<Msg>(null);

  const load = useCallback(async () => {
    const day = today();
    const [s, ppd, p, list, eaten] = await Promise.all([loadStock(db), getPortionsPerDay(db), listMealPreps(db), listShopping(db), portionsEatenOn(db, day)]);
    setStock(s);
    setPerDay(ppd);
    setPreps(p);
    setShopping(list);
    setPlan(planDefrost(s, { today: day, nowMs: Date.now(), timeZone: timeZone(), portionsPerDay: ppd, eatenToday: eaten, horizonDays: HORIZON }));
  }, [db]);

  useEffect(() => {
    void load();
  }, [load, version]);

  const run = changeRunner({ setMsg, load, onChanged, scope: "mealprep" });
  const day = today();
  if (!plan) return null;

  const fridge = stock.reduce((n, s) => n + s.fridgeCount, 0);
  const frozen = stock.reduce((n, s) => n + s.freezerCount, 0);
  const covered = perDay > 0 ? daysCovered(plan, day) : 0;
  const colors = batchColors(stock.map((s) => s.batch.id));
  const nextThaw = plan.thaw[0] ?? null;
  const cookBy = plan.coveredThrough ?? day;
  const recipe = nextRecipe(preps, stock);
  const coversFrom = plan.coveredThrough ? addDays(plan.coveredThrough, 1) : day;
  const coversDays = recipe && perDay > 0 ? Math.max(1, Math.floor(recipe.portions / perDay)) : 0;
  const toBuy = shopping.filter((i) => !i.checked);
  // 1 or 2 a day is the usual choice (lunch, dinner or both); a value set elsewhere stays pickable.
  const choices = [...new Set([1, 2, perDay])].sort((a, b) => a - b).map((n) => ({ id: n, label: String(n) }));

  const nightOf = (d: string) =>
    d === day ? "Tonight" : `${new Date(`${d}T12:00:00Z`).toLocaleDateString(undefined, { weekday: "short", timeZone: "UTC" })} night`;

  return (
    <div className="plan-view">
      <div className="viz-tiles plan-tiles">
        <StatTile
          label="Covered"
          value={String(covered)}
          unit={covered === 1 ? "day" : "days"}
          note={plan.coveredThrough ? `through ${fmtDay(plan.coveredThrough)}` : "nothing ready today"}
        />
        <StatTile label="Tuppers" value={String(fridge + frozen)} note={`${fridge} fridge · ${frozen} freezer`} />
        {nextThaw && (
          <div className="viz-tile wide-only">
            <div className="muted small">Defrost next</div>
            <div className="viz-tile-value">
              <strong>{nextThaw.late ? "Now" : nightOf(nextThaw.day)}</strong>
            </div>
            <div className="muted small">
              {nextThaw.portions} {nextThaw.name.toLowerCase()}, for {fmtDay(nextThaw.forDay)}
            </div>
          </div>
        )}
        <div className="viz-tile plan-per-day">
          <div className="plan-per-day-text">
            <strong>Tuppers a day</strong>
            <span className="muted small">lunch, dinner or both</span>
          </div>
          <ChipGroup
            options={choices}
            value={perDay}
            label="Tuppers a day"
            onChange={(n) => void run(() => setPortionsPerDay(db, n), `${plural(n, "tupper")} a day.`)}
          />
        </div>
      </div>

      {nextThaw && (
        <p className="plan-banner small narrow-only">
          <strong>{nextThaw.late ? "Defrost now:" : `${nightOf(nextThaw.day)}:`}</strong> take {nextThaw.portions} {nextThaw.name.toLowerCase()} out of the
          freezer for {fmtDay(nextThaw.forDay)}.
        </p>
      )}
      <MsgLine msg={msg} />

      <section>
        <div className="section-head">
          <div>
            <h2>Next {HORIZON} days</h2>
            <div className="muted small">Which tupper you eat each day, and when to defrost</div>
          </div>
        </div>
        {perDay > 0 ? (
          <PlanDays plan={plan} today={day} horizon={HORIZON} colors={colors} />
        ) : (
          <p className="muted small">Set how many tuppers you eat a day to get a plan.</p>
        )}
      </section>

      <div className="wide-grid">
        <section className="card span-6">
          <h3>Cook next</h3>
          <p className="muted small">{plan.coveredThrough ? `Your tuppers run out after ${fmtDay(plan.coveredThrough)}` : "Nothing in stock for today"}</p>
          {recipe ? (
            <>
              <div className="plan-cook">
                <strong>Cook by {fmtDay(cookBy)}</strong>
                <span className="small">
                  One batch of {recipe.name.toLowerCase()} ({plural(recipe.portions, "portion")}) covers {fmtDay(coversFrom)}
                  {coversDays > 1 ? ` to ${fmtDay(addDays(coversFrom, coversDays - 1))}` : ""}.
                </span>
              </div>
              <div className="actions two">
                <button
                  type="button"
                  onClick={() =>
                    void run(() => addRecipesToShopping(db, [{ mealPrepId: recipe.id, batches: 1 }]), `Added ${recipe.name} to the shopping list.`)
                  }
                >
                  Add to shopping list
                </button>
                <button type="button" className="secondary" onClick={onRecipes}>
                  Pick a recipe
                </button>
              </div>
            </>
          ) : (
            <button type="button" className="secondary" onClick={onRecipes}>
              Add a recipe
            </button>
          )}
        </section>
        <section className="card span-6 wide-only">
          <SectionHeader title="Shopping list" action="Shopping" onAction={onShopping} />
          <p className="muted small">
            {toBuy.length} to buy · {shopping.length - toBuy.length} ticked
          </p>
          {toBuy.length ? (
            <ul className="plain plan-shopping">
              {toBuy.map((i) => (
                <li key={i.id}>
                  <span>{i.name}</span>
                  <span className="muted">{formatQuantity(i.quantity, i.unit)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted small">Nothing to buy.</p>
          )}
        </section>
      </div>
      <p className="muted small">The plan says when to take each tupper out of the freezer; change tuppers a day and it follows.</p>
    </div>
  );
}
