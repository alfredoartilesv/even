import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { SqlDriver } from "../../../db/driver";
import {
  addMove,
  deleteBatch,
  getPortionsPerDay,
  listMealPreps,
  loadStock,
  logBatch,
  portionsEatenOn,
  setPortionsPerDay,
  undoMove,
  type MealPrep,
  type StockEntry,
} from "../mealPrep";
import { planDefrost, stockAlerts, type Alert, type Location, type MoveKind, type Plan } from "../stock";
import { failed, fmtDay, MsgLine, plural, timeZone, today, type Msg } from "../../../ui/common";
import { StatusBadge, Stepper } from "../../../ui/controls";
import { BatchBar, DefrostTimeline, StockAlerts, StockSummary } from "../../../ui/mealprep/components";

interface Props {
  db: SqlDriver;
  tag: string | null;
  /** Bumped when recipes change elsewhere. */
  version: number;
  /** After eating or cooking here, so the food log and Dashboard reload. */
  onChanged: () => void;
  /** Open Recipes (to cook when stock runs short). */
  onRecipes: () => void;
}

const MOVE_LABEL: Record<MoveKind, string> = { freeze: "froze", thaw: "started defrosting", eat: "ate", discard: "threw out" };

function alertText(a: Alert): string {
  const what = `${plural(a.portions, "portion")} of ${a.name}`;
  switch (a.kind) {
    case "expired":
      return `${what} passed eat-by ${fmtDay(a.eatBy)}. Check it or throw it out.`;
    case "eat_soon":
      return `Eat ${what} by ${fmtDay(a.eatBy)}.`;
    case "thawing":
      return `${what} defrosting, ready ${new Date(a.readyAtMs).toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit" })}.`;
    case "freezer_old":
      return `${what} in the freezer since before ${fmtDay(a.bestBefore)}: past best quality.`;
  }
}

/**
 * What is in the fridge and freezer: the totals and days covered, what needs doing now (eat soon,
 * defrost), the defrost plan by day, then each batch with where its portions are and Eat, Freeze,
 * Defrost. Eating writes the food log. Cooking is logged here or from a recipe.
 */
export function StockView({ db, tag, version, onChanged, onRecipes }: Props) {
  const [stock, setStock] = useState<StockEntry[]>([]);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [perDay, setPerDay] = useState(1);
  const [preps, setPreps] = useState<MealPrep[]>([]);
  const [msg, setMsg] = useState<Msg>(null);
  const [amount, setAmount] = useState<Record<string, number>>({});

  const [cookId, setCookId] = useState("");
  const [cookPortions, setCookPortions] = useState("");
  const [cookFrozen, setCookFrozen] = useState("0");

  const load = useCallback(async () => {
    const [s, ppd, p] = await Promise.all([loadStock(db, { tag }), getPortionsPerDay(db, tag), listMealPreps(db, tag)]);
    const day = today();
    setStock(s);
    setPerDay(ppd);
    setPreps(p);
    setPlan(planDefrost(s, { today: day, nowMs: Date.now(), timeZone: timeZone(), portionsPerDay: ppd, eatenToday: await portionsEatenOn(db, day, tag) }));
  }, [db, tag]);

  useEffect(() => {
    void load();
  }, [load, version]);

  async function act(fn: () => Promise<unknown>, ok: string) {
    try {
      await fn();
      setMsg({ kind: "ok", text: ok });
      await load();
      onChanged();
    } catch (err) {
      setMsg(failed(err, "mealprep"));
    }
  }

  const move = (s: StockEntry, kind: MoveKind, fromLoc?: Location) => {
    const n = amount[s.batch.id] ?? 1;
    return act(
      () => addMove(db, { batchId: s.batch.id, kind, fromLoc, portions: n, timeZone: timeZone() }),
      `${MOVE_LABEL[kind][0].toUpperCase()}${MOVE_LABEL[kind].slice(1)} ${plural(n, "portion")} of ${s.batch.name}.`,
    );
  };

  async function cook(e: FormEvent) {
    e.preventDefault();
    const prep = preps.find((p) => p.id === cookId);
    if (!prep) return setMsg({ kind: "error", text: "Pick what you cooked" });
    await act(
      () =>
        logBatch(db, {
          mealPrepId: prep.id,
          portions: cookPortions ? Number(cookPortions) : undefined,
          frozen: Number(cookFrozen || 0),
          timeZone: timeZone(),
        }),
      `Logged a batch of ${prep.name}.`,
    );
    setCookPortions("");
    setCookFrozen("0");
  }

  const alerts = stockAlerts(stock, today(), Date.now());
  const fridge = stock.reduce((n, s) => n + s.fridgeCount, 0);
  const frozen = stock.reduce((n, s) => n + s.freezerCount, 0);
  const todayStr = today();
  const doNow = plan ? plan.thaw.filter((t) => t.late || t.day === todayStr) : [];

  return (
    <div>
      {plan && <StockSummary plan={plan} fridgeNow={fridge} freezerNow={frozen} perDay={perDay} today={todayStr} />}

      <StockAlerts alerts={alerts.map((a, i) => ({ id: `${a.kind}|${a.batchId}|${i}`, kind: a.kind, text: alertText(a) }))} />

      <section className="card">
        <div className="row">
          <h3 className="grow">Defrost plan</h3>
          <Stepper value={perDay} min={0} max={9} label="Prep portions a day" onChange={(n) => void setPortionsPerDay(db, n, tag).then(load)} />
        </div>
        <p className="muted small">Prep portions you eat a day: the plan says what to take out of the freezer, and when.</p>
        {plan && perDay > 0 ? (
          <>
            {doNow.length > 0 && (
              <ul className="plain">
                {doNow.map((t) => (
                  <li key={`${t.day}|${t.forDay}|${t.batchId}`} className="small">
                    <StatusBadge status={t.late ? "critical" : "warning"}>{t.late ? "Defrost now" : "Today"}</StatusBadge> Take {plural(t.portions, "portion")}{" "}
                    of {t.name} out of the freezer (for {fmtDay(t.forDay)})
                  </li>
                ))}
              </ul>
            )}
            <details className="more" open={plan.short.length > 0}>
              <summary className="small muted">
                {plan.coveredThrough ? `Covered through ${fmtDay(plan.coveredThrough)}` : "Nothing ready for today"}
                {plan.short.length ? ` · short on ${plural(plan.short.length, "day")}` : ""}
              </summary>
              <DefrostTimeline plan={plan} today={todayStr} />
            </details>
            {plan.short.length > 0 && (
              <button type="button" className="link small accent" onClick={onRecipes}>
                Not enough for {fmtDay(plan.short[0].day)}: time to cook ›
              </button>
            )}
          </>
        ) : (
          <p className="muted small">Set how many prep portions you eat a day to get defrost reminders.</p>
        )}
      </section>

      <MsgLine msg={msg} />

      {stock.map((s) => {
        const n = amount[s.batch.id] ?? 1;
        const max = Math.max(1, s.fridgeCount, s.freezerCount);
        return (
          <section key={s.batch.id} className="card">
            <div className="row">
              <div className="grow">
                <strong>{s.batch.name}</strong>
                <div className="muted small">
                  Cooked {fmtDay(s.batch.localDay)} · {s.left} of {s.batch.portions} left
                </div>
              </div>
            </div>
            <BatchBar cooked={s.batch.portions} eaten={s.eaten} fridge={s.fridgeCount} freezer={s.freezerCount} discarded={s.discarded} />
            <ul className="plain small">
              {s.fridge.map((l, i) => (
                <li key={`f${i}`}>
                  Fridge: {l.portions}
                  {l.thawed ? (l.readyAtMs > Date.now() ? " defrosting" : " defrosted") : ""}, eat by {fmtDay(l.eatBy)}
                </li>
              ))}
              {s.freezer.map((l, i) => (
                <li key={`z${i}`}>
                  Freezer: {l.portions}, frozen {fmtDay(l.frozenDay)}, best by {fmtDay(l.bestBefore)}
                </li>
              ))}
            </ul>
            <div className="row">
              <span className="small muted grow">Portions</span>
              <Stepper
                value={Math.min(n, max)}
                min={1}
                max={max}
                label={`Portions of ${s.batch.name}`}
                onChange={(v) => setAmount({ ...amount, [s.batch.id]: v })}
              />
            </div>
            <div className="actions">
              <button disabled={!s.fridgeCount} onClick={() => move(s, "eat")}>
                Eat
              </button>
              <button className="secondary" disabled={!s.fridgeCount} onClick={() => move(s, "freeze")}>
                Freeze
              </button>
              <button className="secondary" disabled={!s.freezerCount} onClick={() => move(s, "thaw")}>
                Defrost
              </button>
              {s.lastMove && (
                <button className="secondary" onClick={() => act(() => undoMove(db, s.lastMove!.id), "Undone.")}>
                  Undo {MOVE_LABEL[s.lastMove.kind]} {s.lastMove.portions}
                </button>
              )}
            </div>
            {/* Rarer moves stay one tap away, so the everyday ones lead. */}
            <details className="more">
              <summary className="small muted">More</summary>
              <div className="actions compact">
                <button className="secondary" disabled={!s.fridgeCount} onClick={() => move(s, "discard", "fridge")}>
                  Toss (fridge)
                </button>
                <button className="secondary" disabled={!s.freezerCount} onClick={() => move(s, "discard", "freezer")}>
                  Toss (freezer)
                </button>
                <button
                  className="secondary danger"
                  onClick={() => {
                    if (confirm(`Delete this batch of ${s.batch.name}? Meals logged from it are removed from the food log too.`)) {
                      void act(() => deleteBatch(db, s.batch.id), "Batch deleted.");
                    }
                  }}
                >
                  Delete batch
                </button>
              </div>
            </details>
          </section>
        );
      })}
      {!stock.length && <p className="muted">No meal prep in stock{tag ? ` tagged ${tag}` : ""}.</p>}

      <form className="card stack" onSubmit={cook}>
        <h3>Log a cook</h3>
        {preps.length ? (
          <>
            <label>
              Recipe
              <select
                value={cookId}
                onChange={(e) => {
                  setCookId(e.target.value);
                  setCookPortions("");
                }}
              >
                <option value="">Choose…</option>
                {preps.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
            <div className="row">
              <label>
                Portions made
                <input
                  type="number"
                  min={1}
                  placeholder={String(preps.find((p) => p.id === cookId)?.portions ?? "")}
                  value={cookPortions}
                  onChange={(e) => setCookPortions(e.target.value)}
                />
              </label>
              <label>
                Straight to the freezer
                <input type="number" min={0} value={cookFrozen} onChange={(e) => setCookFrozen(e.target.value)} />
              </label>
            </div>
            <button type="submit">Log batch</button>
          </>
        ) : (
          <p className="muted small">Add a recipe first, in Recipes.</p>
        )}
      </form>
    </div>
  );
}
