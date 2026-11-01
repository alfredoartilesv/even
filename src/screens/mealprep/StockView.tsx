import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { SqlDriver } from "../../db/driver";
import {
  addMove,
  deleteBatch,
  getPortionsPerDay,
  listMealPreps,
  loadStock,
  logBatch,
  portionsEatenOn,
  undoMove,
  type MealPrep,
  type StockEntry,
} from "../../domain/mealprep/mealPrep";
import { planDefrost, stockAlerts, type Alert, type Location, type MoveKind, type Plan } from "../../domain/mealprep/stock";
import { failed, fmtDay, MsgLine, plural, timeZone, today, type Msg } from "../../ui/common";
import { ChipGroup, Stepper } from "../../ui/controls";
import { addDays, localDateTimeToMs } from "../../core/tz";
import { BatchBar, batchColors, PlanStrip, StockAlerts, StockSummary } from "../../ui/mealprep/components";
import { Legend } from "../../ui/charts";
import { SectionHeader } from "../../ui/layout";

interface Props {
  db: SqlDriver;
  tag: string | null;
  /** Bumped when recipes change elsewhere. */
  version: number;
  /** After eating or cooking here, so the food log and Dashboard reload. */
  onChanged: () => void;
  /** Open Recipes (to cook when stock runs short). */
  onRecipes: () => void;
  /** Open the tupper plan, day by day. */
  onPlan: () => void;
}

const MOVE_LABEL: Record<MoveKind, string> = { freeze: "froze", thaw: "started defrosting", eat: "ate", discard: "threw out" };
/** A move button once pressed: what it did, in a word. */
const DONE: Record<MoveKind, string> = { eat: "Ate", freeze: "Froze", thaw: "Defrosting", discard: "Tossed" };

/** A move made from this screen just now: its button stays pressed, and tapping it again undoes it. */
interface Done {
  batchId: string;
  moveId: string;
  kind: MoveKind;
  fromLoc?: Location;
  portions: number;
}

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
 * defrost), the next two weeks at a glance (the Plan view has them day by day), then each batch with where its portions are and Eat, Freeze,
 * Defrost. Eating writes the food log. Cooking is logged here or from a recipe.
 */
export function StockView({ db, tag, version, onChanged, onRecipes, onPlan }: Props) {
  const [stock, setStock] = useState<StockEntry[]>([]);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [perDay, setPerDay] = useState(1);
  const [preps, setPreps] = useState<MealPrep[]>([]);
  const [msg, setMsg] = useState<Msg>(null);
  const [amount, setAmount] = useState<Record<string, number>>({});
  const [done, setDone] = useState<Done | null>(null);

  // Log a cook: the recipe, portions made, how many go straight to the freezer, and when (today or yesterday).
  const [cookId, setCookId] = useState("");
  const [cookPortions, setCookPortions] = useState(4);
  const [cookFrozen, setCookFrozen] = useState(0);
  const [cookDay, setCookDay] = useState<"today" | "yesterday">("today");

  const load = useCallback(async () => {
    const [s, ppd, p] = await Promise.all([loadStock(db, { tag }), getPortionsPerDay(db, tag), listMealPreps(db, tag)]);
    const day = today();
    setStock(s);
    setPerDay(ppd);
    setPreps(p);
    setPlan(
      planDefrost(s, {
        today: day,
        nowMs: Date.now(),
        timeZone: timeZone(),
        portionsPerDay: ppd,
        eatenToday: await portionsEatenOn(db, day, tag),
        horizonDays: 14,
      }),
    );
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

  const pressed = (s: StockEntry, kind: MoveKind, fromLoc?: Location) =>
    done !== null && done.batchId === s.batch.id && done.kind === kind && done.fromLoc === fromLoc ? done : null;

  /** Make the move, or, when its button is still pressed from just now, take it back. */
  const move = (s: StockEntry, kind: MoveKind, fromLoc?: Location) => {
    const was = pressed(s, kind, fromLoc);
    if (was) {
      return act(
        async () => {
          await undoMove(db, was.moveId);
          setDone(null);
        },
        `Undone: ${MOVE_LABEL[kind]} ${plural(was.portions, "portion")} of ${s.batch.name}.`,
      );
    }
    const n = amount[s.batch.id] ?? 1;
    return act(
      async () => {
        const moveId = await addMove(db, { batchId: s.batch.id, kind, fromLoc, portions: n, timeZone: timeZone() });
        setDone({ batchId: s.batch.id, moveId, kind, fromLoc, portions: n });
      },
      `${MOVE_LABEL[kind][0].toUpperCase()}${MOVE_LABEL[kind].slice(1)} ${plural(n, "portion")} of ${s.batch.name}. Tap again to undo.`,
    );
  };

  /** A move button: its verb, or pressed with what it did (tap again to undo). */
  const moveButton = (s: StockEntry, kind: MoveKind, verb: string, available: number, primary = false, fromLoc?: Location) => {
    const p = pressed(s, kind, fromLoc);
    return (
      <button
        className={p ? "pressed" : primary ? undefined : "secondary"}
        aria-pressed={Boolean(p)}
        disabled={!p && !available}
        title={p ? "Tap again to undo" : undefined}
        onClick={() => move(s, kind, fromLoc)}
      >
        {p ? `✓ ${DONE[kind]} ${p.portions}` : verb}
      </button>
    );
  };

  async function cook(e: FormEvent) {
    e.preventDefault();
    const prep = preps.find((p) => p.id === cookId);
    if (!prep) return setMsg({ kind: "error", text: "Pick what you cooked" });
    const tz = timeZone();
    await act(
      () =>
        logBatch(db, {
          mealPrepId: prep.id,
          portions: cookPortions,
          frozen: cookFrozen,
          // Yesterday's cook is put at 19:00, when most batches are made.
          cookedAtMs: cookDay === "today" ? undefined : localDateTimeToMs(addDays(today(), -1), "19:00", tz).ms,
          timeZone: tz,
        }),
      `Logged ${plural(cookPortions, "portion")} of ${prep.name}${cookFrozen ? `, ${cookFrozen} in the freezer` : ""}.`,
    );
    setCookId("");
    setCookFrozen(0);
    setCookDay("today");
  }

  const pickCook = (p: MealPrep) => {
    setCookId(p.id === cookId ? "" : p.id);
    setCookPortions(p.portions);
    setCookFrozen(0);
  };

  const cooked = preps.find((p) => p.id === cookId) ?? null;
  const alerts = stockAlerts(stock, today(), Date.now());
  const fridge = stock.reduce((n, s) => n + s.fridgeCount, 0);
  const frozen = stock.reduce((n, s) => n + s.freezerCount, 0);
  const todayStr = today();
  const colors = batchColors(stock.map((st) => st.batch.id));

  return (
    <div>
      {plan && <StockSummary plan={plan} fridgeNow={fridge} freezerNow={frozen} perDay={perDay} today={todayStr} />}

      <StockAlerts alerts={alerts.map((a, i) => ({ id: `${a.kind}|${a.batchId}|${i}`, kind: a.kind, text: alertText(a) }))} />

      {plan && perDay > 0 && (
        <section className="card">
          <SectionHeader title="Next 14 days" action="Plan" onAction={onPlan} />
          <PlanStrip plan={plan} today={todayStr} colors={colors} />
          <Legend items={stock.map((st) => ({ label: st.batch.name, slot: colors.get(st.batch.id) ?? 1, mark: "rect" as const }))} />
          {plan.short.length > 0 && (
            <button type="button" className="link small accent" onClick={onRecipes}>
              Not enough for {fmtDay(plan.short[0].day)}: time to cook ›
            </button>
          )}
        </section>
      )}

      <MsgLine msg={msg} />

      <div className="batch-grid">
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
                {moveButton(s, "eat", "Eat", s.fridgeCount, true)}
                {moveButton(s, "freeze", "Freeze", s.fridgeCount)}
                {moveButton(s, "thaw", "Defrost", s.freezerCount)}
              </div>
              {/* Rarer moves stay one tap away, so the everyday ones lead. */}
              <details className="more">
                <summary className="small muted">More</summary>
                <div className="actions compact">
                  {moveButton(s, "discard", "Toss (fridge)", s.fridgeCount, false, "fridge")}
                  {moveButton(s, "discard", "Toss (freezer)", s.freezerCount, false, "freezer")}
                  {s.lastMove && s.lastMove.id !== done?.moveId && (
                    <button className="secondary" onClick={() => act(() => undoMove(db, s.lastMove!.id), "Undone.")}>
                      Undo last: {MOVE_LABEL[s.lastMove.kind]} {s.lastMove.portions}
                    </button>
                  )}
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
      </div>
      {!stock.length && <p className="muted">No meal prep in stock{tag ? ` tagged ${tag}` : ""}.</p>}

      <form className="card stack cook-card" onSubmit={cook}>
        <h3>Log a cook</h3>
        {preps.length ? (
          <>
            <div className="small muted">What did you cook?</div>
            <div className="chips" role="radiogroup" aria-label="Recipe cooked">
              {preps.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  role="radio"
                  aria-checked={p.id === cookId}
                  className={p.id === cookId ? "chip active" : "chip"}
                  onClick={() => pickCook(p)}
                >
                  {p.name}
                </button>
              ))}
            </div>
            {cooked && (
              <>
                <div className="row">
                  <span className="grow">Portions made</span>
                  <Stepper
                    value={cookPortions}
                    min={1}
                    max={50}
                    label="Portions made"
                    onChange={(n) => {
                      setCookPortions(n);
                      setCookFrozen(Math.min(cookFrozen, n));
                    }}
                  />
                </div>
                <div className="row">
                  <span className="grow">Straight to the freezer</span>
                  <Stepper value={cookFrozen} min={0} max={cookPortions} label="Portions to freeze" onChange={setCookFrozen} />
                </div>
                <div className="row">
                  <span className="grow">Cooked</span>
                  <ChipGroup
                    label="When it was cooked"
                    options={[
                      { id: "today", label: "Today" },
                      { id: "yesterday", label: "Yesterday" },
                    ]}
                    value={cookDay}
                    onChange={setCookDay}
                  />
                </div>
                <BatchBar cooked={cookPortions} eaten={0} fridge={cookPortions - cookFrozen} freezer={cookFrozen} discarded={0} />
                <p className="muted small">
                  Keeps {cooked.fridgeDays} days in the fridge, {cooked.freezerDays} in the freezer.
                </p>
                <button type="submit">Log batch of {cooked.name}</button>
              </>
            )}
          </>
        ) : (
          <p className="muted small">
            Add a recipe first, in{" "}
            <button type="button" className="link accent" onClick={onRecipes}>
              Recipes
            </button>
            .
          </p>
        )}
      </form>
    </div>
  );
}
