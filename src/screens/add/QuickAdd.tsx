import { useContext, useEffect, useMemo, useState, type FormEvent } from "react";
import type { SqlDriver } from "../../db/driver";
import { getCurrency, listDrinkTypes, servingKcal, type DrinkType } from "../../domain/alcohol/alcohol";
import { suggestions } from "../../domain/food/food";
import { applyQuickAdd, parseQuickAdd, undoQuickAdd, type QuickLine, type QuickUndo } from "../../domain/food/quickAdd";
import { mealForHour, type Meal } from "../../domain/food/suggest";
import type { Candidate } from "../../domain/food/suggest";
import { failed, fmtMoney, MsgLine, timeZone, type Msg } from "../../ui/common";
import { ChipGroup, MoneyInput } from "../../ui/controls";
import { Icon } from "../../ui/icons";
import { SheetClose } from "../../ui/layout";

const SLOTS: { id: Meal; label: string }[] = [
  { id: "breakfast", label: "Breakfast" },
  { id: "lunch", label: "Lunch" },
  { id: "snack", label: "Snack" },
  { id: "dinner", label: "Dinner" },
];

interface Props {
  db: SqlDriver;
  /** Coach, with what it could not work out, while Coach is on. */
  onCoach?: (text: string) => void;
  /** Bumped after a change elsewhere, so the examples and the known foods follow. */
  version: number;
  onChanged: () => void;
  /** Done: close the sheet (the phone), or nothing (Today's bar stays). */
  onDone?: () => void;
  /** The bar on a wide Today: one line, the preview opens under it. */
  compact?: boolean;
}

/**
 * Quick add (handoff 0.7): type what you ate or drank, or pick an example from your own
 * data; "Here is what I understood" lists each part with its numbers (a drink's price can change,
 * food gets a meal), then Log it, with Undo. Parts it does not know go to Coach, or are added by
 * hand. Nothing leaves the device (domain/food/quickAdd.ts).
 */
export function QuickAdd({ db, onCoach, version, onChanged, onDone: done_, compact = false }: Props) {
  const sheetClose = useContext(SheetClose);
  const onDone = done_ ?? sheetClose ?? undefined;
  const [text, setText] = useState("");
  const [lines, setLines] = useState<QuickLine[] | null>(null);
  const [foods, setFoods] = useState<Candidate[]>([]);
  const [drinks, setDrinks] = useState<DrinkType[]>([]);
  const [currency, setCurrency] = useState("EUR");
  const [meal, setMeal] = useState<Meal>(() => mealForHour(new Date().getHours()));
  const [prices, setPrices] = useState<Record<string, number>>({});
  const [done, setDone] = useState<{ undo: QuickUndo; text: string } | null>(null);
  const [msg, setMsg] = useState<Msg>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const tz = timeZone();
    void Promise.all([suggestions(db, { timeZone: tz, limit: 40 }), listDrinkTypes(db), getCurrency(db)]).then(([f, d, c]) => {
      setFoods(f);
      setDrinks(d);
      setCurrency(c);
    });
  }, [db, version]);

  // Examples from the owner's own data: what they eat most and their usual drink.
  const examples = useMemo(() => {
    const out: string[] = [];
    const top = [...foods].sort((a, b) => b.uses - a.uses).slice(0, 2);
    for (const f of top) out.push(f.name);
    const d = [...drinks].sort((a, b) => b.uses - a.uses)[0];
    if (d) out.push(d.name);
    return out;
  }, [foods, drinks]);

  const understand = (t: string) => {
    setText(t);
    setDone(null);
    setMsg(null);
    setLines(t.trim() ? parseQuickAdd(t, { foods, drinks }) : null);
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    understand(text);
  };

  const price = (t: DrinkType) => prices[t.id] ?? t.price ?? 0;
  const known = (lines ?? []).filter((l) => l.kind !== "unknown");
  const unknown = (lines ?? []).filter((l) => l.kind === "unknown");
  const kcal = known.reduce(
    (n, l) => n + (l.kind === "food" ? (l.candidate.calories ?? 0) * l.count : l.kind === "drink" ? servingKcal(l.type) * l.count : 0),
    0,
  );
  const hasFood = known.some((l) => l.kind === "food");
  const spend = known.reduce((n, l) => n + (l.kind === "drink" ? price(l.type) * l.count : 0), 0);

  async function log() {
    setBusy(true);
    try {
      const undo = await applyQuickAdd(db, known, { meal, timeZone: timeZone(), drinkPrice: (t) => price(t) || null });
      const what = [
        hasFood && `${SLOTS.find((s) => s.id === meal)!.label} logged`,
        known.some((l) => l.kind === "drink") && `drink${known.filter((l) => l.kind === "drink").length > 1 ? "s" : ""} logged`,
      ]
        .filter(Boolean)
        .join(", ");
      setDone({ undo, text: `${what.charAt(0).toUpperCase()}${what.slice(1)}${kcal ? ` · ${Math.round(kcal).toLocaleString()} kcal` : ""}` });
      setLines(null);
      setText("");
      onChanged();
    } catch (err) {
      setMsg(failed(err, "quickadd"));
    } finally {
      setBusy(false);
    }
  }

  const line = (l: QuickLine, i: number) => {
    if (l.kind === "food")
      return (
        <div key={i} className="quick-line">
          <span className="grow">
            <strong>
              {l.count > 1 ? `${l.count} × ` : ""}
              {l.candidate.name}
            </strong>
            <span className="muted small block">{l.candidate.savedMealId ? "saved meal" : "as you logged it before"}</span>
          </span>
          <span className="quick-num">{l.candidate.calories !== null ? `${Math.round(l.candidate.calories * l.count)} kcal` : "–"}</span>
        </div>
      );
    if (l.kind === "drink")
      return (
        <div key={i} className="quick-line">
          <span className="grow">
            <strong>
              {l.count > 1 ? `${l.count} × ` : ""}
              {l.type.name}
            </strong>
            <span className="muted small block">
              {l.type.volumeMl} ml · {l.type.abvPercent}%
            </span>
          </span>
          <span className="quick-num">{servingKcal(l.type) * l.count} kcal</span>
        </div>
      );
    return null;
  };

  return (
    <div className={compact ? "quick compact" : "quick"}>
      <form onSubmit={submit} className="add-ask">
        <Icon name={compact ? "plus" : "sparkle"} size={20} />
        <label className="sr-only" htmlFor={compact ? "quick-bar" : "quick-sheet"}>
          Tell Even what you ate or drank
        </label>
        <input
          id={compact ? "quick-bar" : "quick-sheet"}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onBlur={() => text.trim() && understand(text)}
          placeholder={compact ? "Tell Even what you ate or drank" : "For example: 2 eggs, toast and a coffee"}
          autoComplete="off"
        />
        <button type="submit" disabled={!text.trim()}>
          Add
        </button>
      </form>
      {examples.length > 0 && (
        <div className="quick-examples" role="group" aria-label="Examples">
          {examples.map((x) => (
            <button key={x} type="button" className={text === x ? "chip active" : "chip"} aria-pressed={text === x} onClick={() => understand(x)}>
              {x}
            </button>
          ))}
        </div>
      )}

      {lines && (
        <section className="card quick-preview" aria-labelledby="quick-understood">
          <div className="quick-preview-head">
            <h2 id="quick-understood">Here is what I understood</h2>
            <button type="button" className="icon-button ghost" aria-label="Not now" onClick={() => understand("")}>
              <Icon name="close" size={18} />
            </button>
          </div>
          {known.map(line)}
          {unknown.length > 0 && (
            <div className="quick-unknown">
              <span className="muted small">Not known yet: {unknown.map((u) => `“${u.part}”`).join(", ")}.</span>
              {onCoach && (
                <button type="button" className="link accent small" onClick={() => onCoach(unknown.map((u) => u.part).join(", "))}>
                  Ask Coach to estimate it ›
                </button>
              )}
            </div>
          )}
          {known.length > 0 && (
            <>
              <div className="quick-total">
                <span className="muted">Total</span>
                <strong>
                  {kcal ? `${Math.round(kcal).toLocaleString()} kcal` : ""}
                  {spend ? ` · ${fmtMoney(spend, currency)}` : ""}
                </strong>
              </div>
              {hasFood && <ChipGroup label="Meal" value={meal} onChange={setMeal} options={SLOTS} />}
              {known
                .filter((l): l is Extract<QuickLine, { kind: "drink" }> => l.kind === "drink")
                .map((l) => (
                  <div key={l.type.id} className="stepper-field">
                    <label className="muted small" htmlFor={`quick-price-${l.type.id}`}>
                      Price of {l.type.name}
                    </label>
                    <MoneyInput
                      id={`quick-price-${l.type.id}`}
                      label={`Price of ${l.type.name}`}
                      value={price(l.type)}
                      onChange={(v) => setPrices({ ...prices, [l.type.id]: v })}
                      currency={currency}
                    />
                  </div>
                ))}
              <button type="button" disabled={busy} onClick={() => void log()}>
                {busy ? "Logging…" : spend ? `Log it · ${fmtMoney(spend, currency)}` : "Log it"}
              </button>
              <span className="muted small">These come from what you logged before. Check anything that looks off.</span>
            </>
          )}
        </section>
      )}
      <MsgLine msg={msg} />

      {done && (
        <section className="card quick-done" role="status">
          <span className="next-check" aria-hidden>
            <Icon name="food" size={18} />
          </span>
          <span className="grow">
            <strong>{done.text}</strong>
          </span>
          <button
            type="button"
            className="link accent"
            onClick={async () => {
              await undoQuickAdd(db, done.undo);
              setDone(null);
              onChanged();
            }}
          >
            Undo
          </button>
          {!compact && (
            <>
              <button type="button" className="secondary" onClick={() => setDone(null)}>
                Add another
              </button>
              {onDone && <button onClick={onDone}>Done</button>}
            </>
          )}
        </section>
      )}
    </div>
  );
}
