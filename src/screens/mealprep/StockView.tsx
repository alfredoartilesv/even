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
  setPortionsPerDay,
  undoMove,
  type MealPrep,
  type StockEntry,
} from "../../db/mealPrep";
import { planDefrost, stockAlerts, type Alert, type Location, type MoveKind, type Plan } from "../../mealprep/stock";
import { fmtDay, MsgLine, plural, timeZone, today, type Msg } from "./common";

interface Props {
  db: SqlDriver;
  tag: string | null;
  /** Bumped when recipes change elsewhere. */
  version: number;
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

export function StockView({ db, tag, version }: Props) {
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
    setPlan(
      planDefrost(s, { today: day, nowMs: Date.now(), timeZone: timeZone(), portionsPerDay: ppd, eatenToday: await portionsEatenOn(db, day, tag) }),
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
    } catch (err) {
      setMsg({ kind: "error", text: (err as Error).message });
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

  return (
    <div>
      <div className="totals">
        <div>
          <strong>{fridge + frozen}</strong>
          <span className="muted small">meals left</span>
        </div>
        <div>
          <strong>{fridge}</strong>
          <span className="muted small">in the fridge</span>
        </div>
        <div>
          <strong>{frozen}</strong>
          <span className="muted small">frozen</span>
        </div>
      </div>

      <section className="card">
        <div className="row">
          <h3>Defrost plan</h3>
          <label className="inline">
            Portions a day
            <input
              type="number"
              min={0}
              max={9}
              value={perDay}
              onChange={(e) => {
                const n = Number(e.target.value);
                if (!Number.isInteger(n) || n < 0) return;
                void setPortionsPerDay(db, n, tag).then(load);
              }}
            />
          </label>
        </div>
        {plan && perDay > 0 ? (
          <>
            <p className="small">
              {plan.coveredThrough
                ? `Covered through ${fmtDay(plan.coveredThrough)}${plan.short.length ? "" : " (whole week)"}.`
                : "Nothing ready for today."}
            </p>
            {plan.thaw.length ? (
              <ul className="plain">
                {plan.thaw.map((t) => (
                  <li key={`${t.day}|${t.forDay}|${t.batchId}`} className={t.day === todayStr ? "warning" : ""}>
                    <strong>{t.day === todayStr ? "Today" : fmtDay(t.day)}</strong>: move {plural(t.portions, "portion")} of {t.name} to the fridge
                    (for {fmtDay(t.forDay)}){t.late && ", it will be ready late"}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted small">Nothing to defrost this week.</p>
            )}
            {plan.short.length > 0 && (
              <p className="warning small">
                Not enough for {plan.short.map((s) => fmtDay(s.day)).join(", ")}. Time to cook.
              </p>
            )}
            {plan.waste.map((w) => (
              <p key={`${w.batchId}|${w.eatBy}`} className="warning small">
                {plural(w.portions, "portion")} of {w.name} will not get eaten by {fmtDay(w.eatBy)}. Freeze them now?
              </p>
            ))}
          </>
        ) : (
          <p className="muted small">Set how many prep portions you eat a day to get defrost reminders.</p>
        )}
      </section>

      {alerts.length > 0 && (
        <ul className="plain">
          {alerts.map((a, i) => (
            <li key={i} className={a.kind === "expired" ? "error small" : a.kind === "thawing" ? "muted small" : "warning small"}>
              {alertText(a)}
            </li>
          ))}
        </ul>
      )}

      <MsgLine msg={msg} />

      {stock.map((s) => (
        <section key={s.batch.id} className="card">
          <div className="row">
            <div>
              <strong>{s.batch.name}</strong>
              <div className="muted small">
                Cooked {fmtDay(s.batch.localDay)}, {s.left} of {s.batch.portions} left
              </div>
            </div>
            <input
              type="number"
              min={1}
              aria-label="Portions"
              className="qty"
              value={amount[s.batch.id] ?? 1}
              onChange={(e) => setAmount({ ...amount, [s.batch.id]: Math.max(1, Math.trunc(Number(e.target.value) || 1)) })}
            />
          </div>
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
            <button className="secondary" disabled={!s.fridgeCount} onClick={() => move(s, "discard", "fridge")}>
              Toss (fridge)
            </button>
            <button className="secondary" disabled={!s.freezerCount} onClick={() => move(s, "discard", "freezer")}>
              Toss (freezer)
            </button>
            {s.lastMove && (
              <button className="secondary" onClick={() => act(() => undoMove(db, s.lastMove!.id), "Undone.")}>
                Undo {MOVE_LABEL[s.lastMove.kind]} {s.lastMove.portions}
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
        </section>
      ))}
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
