import { useCallback, useEffect, useState, type FormEvent } from "react";
import { addDays, localDateTimeToMs } from "../../core/tz";
import type { SqlDriver } from "../../db/driver";
import { changeRunner, EditActions, fmtDay, fmtMoney, MsgLine, numOrNull, timeZone, today, type Msg } from "../../ui/common";
import { StatTile } from "../../ui/charts";
import { ChipGroup } from "../../ui/controls";
import { Icon } from "../../ui/icons";
import { SectionHeader } from "../../ui/layout";
import {
  deleteDrink,
  deleteDrinkType,
  getCurrency,
  listDrinks,
  listDrinkTypes,
  logDrink,
  saveDrinkType,
  servingKcal,
  setCurrency,
  weightWithoutAlcohol,
  type DrinkEntry,
  type DrinkType,
  type DrinkTypeInput,
  type WeightWithoutAlcohol,
} from "../../domain/alcohol/alcohol";

interface Props {
  db: SqlDriver;
  version: number;
  onChanged: () => void;
}

const PERIODS = [
  { key: "today", label: "Today", days: 1 },
  { key: "week", label: "7 days", days: 7 },
  { key: "month", label: "30 days", days: 30 },
  { key: "year", label: "Year", days: 365 },
] as const;
type Period = (typeof PERIODS)[number]["key"];

const kcal = (n: number) => Math.round(n).toLocaleString();
const kg = (n: number) => n.toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
/** A drink logged for an earlier day lands at this time unless the owner sets another. */
const EVENING = "20:00";
const time = (ms: number) => new Date(ms).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });

interface TypeDraft {
  id?: string;
  name: string;
  volumeMl: string;
  abvPercent: string;
  calories: string;
  price: string;
}
const emptyType: TypeDraft = { name: "", volumeMl: "", abvPercent: "", calories: "", price: "" };
const s = (n: number | null) => (n === null ? "" : String(n));
const toDraft = (t: DrinkType): TypeDraft => ({
  id: t.id,
  name: t.name,
  volumeMl: s(t.volumeMl),
  abvPercent: s(t.abvPercent),
  calories: s(t.calories),
  price: s(t.price),
});
const fromDraft = (d: TypeDraft): DrinkTypeInput => ({
  id: d.id,
  name: d.name,
  volumeMl: Number(d.volumeMl),
  abvPercent: Number(d.abvPercent),
  calories: numOrNull(d.calories),
  price: numOrNull(d.price),
});

/** Name, size, ABV, kcal and price of a drink. Outside AlcoholView so inputs keep focus while typing. */
function TypeFields({ d, set, currency }: { d: TypeDraft; set: (d: TypeDraft) => void; currency: string }) {
  return (
    <>
      <label>
        Drink
        <input value={d.name} onChange={(e) => set({ ...d, name: e.target.value })} placeholder="e.g. Mahou 33 cl" required />
      </label>
      <div className="grid">
        <label>
          ml
          <input inputMode="decimal" value={d.volumeMl} onChange={(e) => set({ ...d, volumeMl: e.target.value })} required />
        </label>
        <label>
          ABV %
          <input inputMode="decimal" value={d.abvPercent} onChange={(e) => set({ ...d, abvPercent: e.target.value })} required />
        </label>
        <label>
          kcal
          <input
            inputMode="decimal"
            value={d.calories}
            placeholder={
              Number(d.volumeMl) > 0 && Number(d.abvPercent) >= 0
                ? `≈ ${servingKcal({ volumeMl: Number(d.volumeMl), abvPercent: Number(d.abvPercent), calories: null })}`
                : undefined
            }
            onChange={(e) => set({ ...d, calories: e.target.value })}
          />
        </label>
        <label>
          Price ({currency})
          <input inputMode="decimal" value={d.price} onChange={(e) => set({ ...d, price: e.target.value })} />
        </label>
      </div>
    </>
  );
}

export function AlcoholView({ db, version, onChanged }: Props) {
  const [period, setPeriod] = useState<Period>("week");
  const [impact, setImpact] = useState<WeightWithoutAlcohol | null>(null);
  const [types, setTypes] = useState<DrinkType[]>([]);
  const [drinks, setDrinks] = useState<DrinkEntry[]>([]);
  const [currency, setCur] = useState("EUR");
  const [msg, setMsg] = useState<Msg>(null);
  const [lastIds, setLastIds] = useState<string[]>([]);

  const [other, setOther] = useState<TypeDraft | null>(null);
  const [count, setCount] = useState("1");
  const [saveAsType, setSaveAsType] = useState(true);
  const [editing, setEditing] = useState<TypeDraft | null>(null);
  const [curInput, setCurInput] = useState<string | null>(null);
  // The day drinks are logged for: today logs "now", an earlier day logs at the time picked under it.
  const [day, setDay] = useState(today());
  const [at, setAt] = useState(EVENING);
  const isToday = day === today();
  const forDay = isToday ? "" : ` for ${fmtDay(day)}`;
  // Picking an earlier day widens a "Today" list to 7 days, so the drink shows up once logged.
  function pickDay(d: string) {
    setDay(d);
    if (d !== today() && period === "today") setPeriod("week");
  }

  const load = useCallback(async () => {
    const to = today();
    const from = addDays(to, -(PERIODS.find((p) => p.key === period)!.days - 1));
    const [w, t, d, c] = await Promise.all([weightWithoutAlcohol(db, from, to), listDrinkTypes(db), listDrinks(db, from, to), getCurrency(db)]);
    setImpact(w);
    setTypes(t);
    setDrinks(d);
    setCur(c);
  }, [db, period]);

  useEffect(() => {
    void load();
  }, [load, version]);

  const money = (n: number) => fmtMoney(n, currency);

  const run = changeRunner({ setMsg, load, onChanged, scope: "alcohol" });

  /** When the drink was had: now for today, otherwise the picked time on the picked day. */
  function drunkAt(): number | undefined {
    if (isToday) return undefined;
    if (day > today()) throw new Error("That day has not happened yet");
    return localDateTimeToMs(day, at, timeZone()).ms;
  }

  async function quickLog(t: DrinkType) {
    await run(async () => setLastIds(await logDrink(db, { typeId: t.id, atMs: drunkAt(), timeZone: timeZone() })), `Logged ${t.name}${forDay}.`);
  }

  async function logOther(e: FormEvent) {
    e.preventDefault();
    if (!other) return;
    const t = fromDraft(other);
    const n = Number(count || 1);
    const ok = await run(
      async () => {
        const typeId = saveAsType ? await saveDrinkType(db, t) : null;
        setLastIds(await logDrink(db, { ...t, typeId, count: n, atMs: drunkAt(), timeZone: timeZone() }));
      },
      `Logged ${n} x ${t.name.trim()}${forDay}${saveAsType ? " and saved the type" : ""}.`,
    );
    if (ok) {
      setOther(null);
      setCount("1");
    }
  }

  async function saveType(e: FormEvent) {
    e.preventDefault();
    if (editing && (await run(() => saveDrinkType(db, fromDraft(editing)), `Saved ${editing.name.trim()}.`))) setEditing(null);
  }

  const t = impact?.totals;
  return (
    <div>
      <SectionHeader title="Log a drink" />
      <div className="drink-when">
        <label>
          Day
          <input type="date" value={day} max={today()} onChange={(e) => pickDay(e.target.value || today())} />
        </label>
        {isToday ? (
          <button type="button" className="link small" onClick={() => pickDay(addDays(today(), -1))}>
            Forgot one yesterday?
          </button>
        ) : (
          <>
            <label>
              Time
              <input type="time" value={at} onChange={(e) => setAt(e.target.value || EVENING)} />
            </label>
            <button type="button" className="link small" onClick={() => pickDay(today())}>
              Back to today
            </button>
          </>
        )}
      </div>
      {types.length === 0 && <p className="muted small">Log a drink once and save it: it gets a one-tap button here.</p>}
      <div className="drink-picks">
        {types.map((d) => (
          <button key={d.id} className="drink-pick secondary" onClick={() => quickLog(d)} aria-label={`Log one ${d.name}${forDay}`}>
            <span className="quick-icon">
              <Icon name="alcohol" size={20} />
            </span>
            <span className="drink-pick-text">
              <strong>{d.name}</strong>
              <span className="muted small">
                {d.volumeMl} ml · {d.abvPercent}% · {servingKcal(d)} kcal{d.price !== null && ` · ${money(d.price)}`}
              </span>
            </span>
          </button>
        ))}
        {!other && (
          <button className="drink-pick other secondary" onClick={() => setOther({ ...emptyType })}>
            <span className="quick-icon">
              <Icon name="plus" size={20} />
            </span>
            <span className="drink-pick-text">
              <strong>Other drink</strong>
              <span className="muted small">size, strength, price</span>
            </span>
          </button>
        )}
      </div>

      {other && (
        <form className="card stack" onSubmit={logOther}>
          <TypeFields d={other} set={setOther} currency={currency} />
          <div className="row">
            <label className="inline">
              How many
              <input className="qty" inputMode="numeric" value={count} onChange={(e) => setCount(e.target.value)} />
            </label>
            <label className="inline">
              <input type="checkbox" checked={saveAsType} onChange={(e) => setSaveAsType(e.target.checked)} />
              Save for one-tap logging
            </label>
          </div>
          <div className="actions">
            <button type="submit">Log{forDay}</button>
            <button type="button" className="secondary" onClick={() => setOther(null)}>
              Cancel
            </button>
          </div>
        </form>
      )}

      <MsgLine msg={msg} />
      {lastIds.length > 0 && (
        <button
          className="link small"
          onClick={() =>
            void run(async () => {
              for (const id of lastIds) await deleteDrink(db, id);
              setLastIds([]);
            }, "Undone.")
          }
        >
          Undo
        </button>
      )}

      <SectionHeader title="How it adds up" />
      <ChipGroup options={PERIODS.map((p) => ({ id: p.key, label: p.label }))} value={period} onChange={setPeriod} label="Period" />

      {t && (
        <div className="viz-tiles">
          <StatTile label="Drinks" value={String(t.drinks)} note={`${t.standardDrinks.toLocaleString(undefined, { maximumFractionDigits: 1 })} standard`} />
          <StatTile label="Calories" value={kcal(t.kcal)} unit="kcal" note={t.kcalEstimated ? "some estimated" : undefined} />
          <StatTile label="Spent" value={money(t.money)} note={t.priced < t.drinks ? `${t.drinks - t.priced} without price` : undefined} />
        </div>
      )}

      {t && impact && (
        <section className="card">
          <h3>Weight without alcohol</h3>
          {impact.weight && impact.expectedKg !== null ? (
            <>
              <p>
                <strong>{kg(impact.expectedKg)} kg</strong> instead of {kg(impact.weight.kg)} kg
                <span className="muted"> ({impact.kgFromAlcohol > 0 ? `−${kg(impact.kgFromAlcohol)} kg` : "no difference"})</span>
              </p>
              <p className="muted small">
                If the {kcal(t.kcal)} kcal from drinks in the last {PERIODS.find((p) => p.key === period)!.label.toLowerCase()} had not been added on top (7,700
                kcal ≈ 1 kg). Weight from {impact.weight.source === "manual" ? "a weigh-in" : "your watch"} on {fmtDay(impact.weight.day)}. An upper bound, not
                a prediction.
              </p>
            </>
          ) : (
            <p className="muted small">Log a weight (or sync one from your watch) to see this.</p>
          )}
        </section>
      )}

      <SectionHeader title="Drinks" />
      {drinks.length ? (
        <ul className="entries">
          {drinks.map((d) => (
            <li key={d.id}>
              <div className="grow">
                <div>{d.name}</div>
                <div className="muted small">
                  {fmtDay(d.localDay)} {time(d.drunkAtMs)} · {d.volumeMl} ml, {d.abvPercent}% · {kcal(d.kcal)} kcal{d.kcalEstimated ? " (est.)" : ""}
                  {d.price !== null && ` · ${money(d.price)}`}
                </div>
              </div>
              <button className="icon-button ghost" aria-label={`Delete ${d.name}`} onClick={() => void run(() => deleteDrink(db, d.id), "Deleted.")}>
                <Icon name="trash" size={18} />
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">No drinks in this period.</p>
      )}

      <SectionHeader title="Your drinks" />
      {editing ? (
        <form className="card stack" onSubmit={saveType}>
          <TypeFields d={editing} set={setEditing} currency={currency} />
          <EditActions
            onCancel={() => setEditing(null)}
            onRemove={editing.id ? () => void run(() => deleteDrinkType(db, editing.id!), "Removed.").then((ok) => ok && setEditing(null)) : undefined}
            confirmRemove={`Remove ${editing.name}? Drinks already logged keep their kcal and price.`}
          />
        </form>
      ) : (
        <>
          <ul className="entries">
            {types.map((d) => (
              <li key={d.id}>
                <div className="grow">
                  <div>
                    {d.name}
                    {d.createdBy === "assistant" && <span className="muted small"> · added by the assistant</span>}
                  </div>
                  <div className="muted small">
                    {d.volumeMl} ml, {d.abvPercent}% · {servingKcal(d)} kcal{d.calories === null ? " (est.)" : ""} ·{" "}
                    {d.price === null ? "no price" : money(d.price)} · {d.uses}×
                  </div>
                </div>
                <button className="secondary" onClick={() => setEditing(toDraft(d))}>
                  Edit
                </button>
              </li>
            ))}
          </ul>
          <div className="actions">
            <button className="secondary" onClick={() => setEditing({ ...emptyType })}>
              New drink type
            </button>
            {curInput === null ? (
              <button className="secondary" onClick={() => setCurInput(currency)}>
                Currency: {currency}
              </button>
            ) : (
              <form
                className="row"
                onSubmit={(e) => {
                  e.preventDefault();
                  void run(() => setCurrency(db, curInput), "Currency saved.").then((ok) => ok && setCurInput(null));
                }}
              >
                <input className="qty" value={curInput} onChange={(e) => setCurInput(e.target.value)} maxLength={3} aria-label="Currency code" />
                <button type="submit">Save</button>
              </form>
            )}
          </div>
        </>
      )}
    </div>
  );
}
