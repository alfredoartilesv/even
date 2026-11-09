import { useCallback, useEffect, useState } from "react";
import { addDays } from "../../core/tz";
import type { SqlDriver } from "../../db/driver";
import {
  addMove,
  undoMove,
  getPortionsPerDay,
  listMealPreps,
  loadStock,
  portionsEatenOn,
  setPortionsPerDay,
  type MealPrep,
  type StockEntry,
} from "../../domain/mealprep/mealPrep";
import { addRecipesToShopping, listShopping, type ShoppingItem } from "../../domain/mealprep/shopping";
import { planSkips, PREP_MEALS, setPrepMeals, skipCounts, skipTupper, type DaySkips, type PrepMeal } from "../../domain/mealprep/skips";
import { planDefrost, type Plan } from "../../domain/mealprep/stock";
import { seriesColor } from "../../ui/charts";
import { changeRunner, fmtDay, MsgLine, plural, timeZone, today, type Msg } from "../../ui/common";
import { ChipGroup } from "../../ui/controls";
import { Icon } from "../../ui/icons";
import { batchColors, DayStrip } from "../../ui/mealprep/components";
import { daysCovered, timelineDays } from "../../ui/mealprep/timeline";

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
  const [picked, setPicked] = useState(today());
  const [thawed, setThawed] = useState<{ moveId: string; name: string; forDay: string } | null>(null);
  const [added, setAdded] = useState(0);
  const [meals, setMeals] = useState<PrepMeal[]>([]);
  const [skips, setSkips] = useState<Map<string, DaySkips>>(new Map());

  const load = useCallback(async () => {
    const day = today();
    const [s, ppd, p, list, eaten] = await Promise.all([loadStock(db), getPortionsPerDay(db), listMealPreps(db), listShopping(db), portionsEatenOn(db, day)]);
    const { meals: m, days: sk } = await planSkips(db, day, HORIZON, ppd);
    setMeals(m);
    setSkips(sk);
    setStock(s);
    setPerDay(ppd);
    setPreps(p);
    setShopping(list);
    setPlan(
      planDefrost(s, {
        today: day,
        nowMs: Date.now(),
        timeZone: timeZone(),
        portionsPerDay: ppd,
        eatenToday: eaten,
        skips: skipCounts(sk),
        horizonDays: HORIZON,
      }),
    );
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

  const days = timelineDays(plan, day, HORIZON);
  const sel = days.find((d) => d.day === picked) ?? days[0];
  const selSkips = skips.get(sel.day) ?? { manual: 0, ateOut: [] };
  const recipesShown = [...new Map(plan.meals.map((m) => [m.batchId, m.name])).entries()];

  return (
    <div className="plan-view">
      <p className="plan-status muted small">
        {plural(fridge + frozen, "tupper")} ready ({fridge} fridge, {frozen} freezer) ·{" "}
        {plan.coveredThrough ? `${plural(covered, "day")} covered, through ${fmtDay(plan.coveredThrough)}` : "nothing ready today"}
      </p>
      <div className="plan-board">
        <div className="plan-col">
          {nextThaw && !thawed && (
            <section className="card plan-tonight" aria-label="Tonight">
              <span className="plan-tonight-icon" aria-hidden>
                <Icon name="box" size={20} />
              </span>
              <span className="grow">
                <strong>{nextThaw.late ? "Defrost now:" : `${nightOf(nextThaw.day)}:`}</strong> take {plural(nextThaw.portions, "")}
                {nextThaw.name.toLowerCase()} out of the freezer for {fmtDay(nextThaw.forDay)}.
              </span>
              <button
                type="button"
                onClick={() =>
                  void run(async () => {
                    const moveId = await addMove(db, { batchId: nextThaw.batchId, kind: "thaw", portions: nextThaw.portions, timeZone: timeZone() });
                    setThawed({ moveId, name: nextThaw.name, forDay: nextThaw.forDay });
                  }, "")
                }
              >
                Done
              </button>
            </section>
          )}
          {thawed && (
            <section className="card plan-tonight done" role="status">
              <span className="grow">
                <strong>Thawing.</strong> {thawed.name} will be ready for {fmtDay(thawed.forDay)}.
              </span>
              <button
                type="button"
                className="link accent"
                onClick={() =>
                  void run(async () => {
                    await undoMove(db, thawed.moveId);
                    setThawed(null);
                  }, "")
                }
              >
                Undo
              </button>
            </section>
          )}
          <section className="card plan-days-card" aria-labelledby="plan-days">
            <div className="plan-days-head">
              <h2 id="plan-days">Next {HORIZON} days</h2>
              <span className="plan-legend">
                {recipesShown.map(([id, name]) => (
                  <span key={id} className="small">
                    <span className="day-dot" style={{ background: seriesColor(colors.get(id) ?? 1) }} aria-hidden />
                    {name}
                  </span>
                ))}
              </span>
            </div>
            {perDay > 0 ? (
              <DayStrip days={days} value={sel.day} onChange={setPicked} colors={colors} today={day} />
            ) : (
              <p className="muted small">Set how many tuppers you eat a day to get a plan.</p>
            )}
            <div className="plan-per-day">
              <span className="grow">
                <strong>Tuppers a day</strong>
                <span className="muted small"> lunch, dinner or both</span>
              </span>

              <ChipGroup
                options={choices}
                value={perDay}
                label="Tuppers a day"
                onChange={(n) => void run(() => setPortionsPerDay(db, n), `${plural(n, "tupper")} a day.`)}
              />
            </div>
            {perDay > 0 && (
              <div className="plan-per-day stacked">
                <span>
                  <strong>Tuppers are for</strong>
                  <span className="muted small block">Log one of these as something else (eating out) and its tupper moves on.</span>
                </span>
                <div className="chips" role="group" aria-label="Meals the tuppers are for">
                  {PREP_MEALS.map((m) => (
                    <button
                      key={m}
                      type="button"
                      className={meals.includes(m) ? "chip active" : "chip"}
                      aria-pressed={meals.includes(m)}
                      onClick={() => void run(() => setPrepMeals(db, meals.includes(m) ? meals.filter((x) => x !== m) : [...meals, m]), "")}
                    >
                      {m.charAt(0).toUpperCase() + m.slice(1)}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </section>
        </div>

        <div className="plan-col">
          <section className="card plan-selected" aria-label={fmtDay(sel.day, day)}>
            <div className="plan-selected-head">
              <span className="muted small">{sel.day === day ? "Today" : fmtDay(sel.day, day)}</span>
              {sel.meals[0] && <span className="next-pill">{sel.meals[0].from === "thawed" ? "Thawed" : "Fridge"}</span>}
            </div>
            {sel.meals.length ? (
              sel.meals.map((m, i) => (
                <div key={i} className="plan-selected-meal">
                  <strong className="next-name">
                    {m.portions > 1 ? `${m.portions} × ` : ""}
                    {m.name}
                  </strong>
                  <span className="muted small">
                    {m.from === "thawed" && m.thawDay
                      ? `Out of the freezer ${nightOf(m.thawDay).toLowerCase()}`
                      : m.eatBy
                        ? `Eat by ${fmtDay(m.eatBy, day)}`
                        : ""}
                  </span>
                </div>
              ))
            ) : selSkips.manual + selSkips.ateOut.length > 0 ? (
              <>
                <strong className="next-name">{selSkips.manual ? "Tupper skipped" : "Eating out"}</strong>
                <span className="muted small">The tuppers move on a day.</span>
              </>
            ) : (
              <>
                <strong className="next-name">No tupper</strong>
                <span className="muted small">Cook before then, or plan something else.</span>
              </>
            )}
            {sel.takeOut.map((t, i) => (
              <span key={i} className="plan-thaw small">
                {t.late ? "Defrost now: " : "Tonight: "}take {t.portions} {t.name.toLowerCase()} out of the freezer for {fmtDay(t.forDay, day)}.
              </span>
            ))}
            {selSkips.ateOut.length > 0 && (
              <span className="plan-skip small">
                You logged {selSkips.ateOut.join(" and ")} as something else, so {selSkips.ateOut.length > 1 ? "those tuppers move" : "that tupper moves"} on.
              </span>
            )}
            {perDay > 0 && (
              <div className="plan-skip-actions">
                {selSkips.manual > 0 && (
                  <span className="plan-skip small grow">
                    {plural(selSkips.manual, "tupper")} skipped.{" "}
                    <button type="button" className="link accent small" onClick={() => void run(() => skipTupper(db, sel.day, day, -1), "")}>
                      Undo
                    </button>
                  </span>
                )}
                {sel.meals.length > 0 && (
                  <button type="button" className="secondary" onClick={() => void run(() => skipTupper(db, sel.day, day, 1), "")}>
                    Skip a tupper {sel.day === day ? "today" : "this day"}
                  </button>
                )}
              </div>
            )}
          </section>

          <section className="card plan-cook-card" aria-labelledby="cook-next">
            <h2 id="cook-next">Cook next</h2>
            {recipe ? (
              <>
                <p>
                  <strong>By {fmtDay(cookBy)}.</strong> One batch of {recipe.name.toLowerCase()} ({plural(recipe.portions, "portion")}) covers{" "}
                  {fmtDay(coversFrom)}
                  {coversDays > 1 ? ` to ${fmtDay(addDays(coversFrom, coversDays - 1))}` : ""}.
                </p>
                {added ? (
                  <div className="drink-added" role="status">
                    <span>
                      <strong>{plural(added, "item")} added.</strong> Ready when you shop.
                    </span>
                    <button type="button" className="link accent" onClick={onShopping}>
                      Open list
                    </button>
                  </div>
                ) : (
                  <div className="actions two">
                    <button
                      type="button"
                      onClick={() =>
                        void run(async () => {
                          const before = (await listShopping(db)).length;
                          await addRecipesToShopping(db, [{ mealPrepId: recipe.id, batches: 1 }]);
                          setAdded(Math.max(1, (await listShopping(db)).length - before));
                        }, "")
                      }
                    >
                      Add ingredients to the list
                    </button>
                    <button type="button" className="secondary" onClick={onRecipes}>
                      Pick another recipe
                    </button>
                  </div>
                )}
              </>
            ) : (
              <button type="button" className="secondary" onClick={onRecipes}>
                Add a recipe
              </button>
            )}
            <span className="muted small">{toBuy.length ? `${plural(toBuy.length, "item")} on your shopping list.` : "Nothing on your shopping list."}</span>
          </section>
        </div>
      </div>
      <MsgLine msg={msg} />
    </div>
  );
}
