import { useCallback, useEffect, useState, type FormEvent } from "react";
import { addDays, localDateTimeToMs } from "../../core/tz";
import type { SqlDriver } from "../../db/driver";
import { changeRunner, EditActions, fmtDay, fmtMoney, MsgLine, numOrNull, timeZone, today, type Msg } from "../../ui/common";
import { StatTile } from "../../ui/charts";
import { ChipGroup } from "../../ui/controls";
import { Icon } from "../../ui/icons";
import { SectionHeader } from "../../ui/layout";
import { listGoals } from "../../domain/me/goals";
import { AddDrink, draftFrom, DrinksWeek, type Draft } from "./AddDrink";
import {
  deleteDrink,
  deleteDrinkType,
  getCurrency,
  listDrinks,
  listDrinkTypes,
  saveDrinkType,
  servingKcal,
  setCurrency,
  typeUsesSince,
  updateDrink,
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
  /** Favourites open as their own page on a phone: the screen shows the way back. */
  managing: boolean;
  onManage: (open: boolean) => void;
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
/** The drinks list shows this many before "All n". */
const FIRST = 5;

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
const toDraft = (t: Pick<DrinkType, "name" | "volumeMl" | "abvPercent" | "calories" | "price"> & { id?: string }): TypeDraft => ({
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

/** A logged drink open for editing: its values, and its day and time. */
interface DrinkDraft extends TypeDraft {
  entryId: string;
  day: string;
  at: string;
}

/** Name, size, ABV, kcal and price of a drink. Outside AlcoholView so inputs keep focus while typing. */
function TypeFields({ d, set, currency }: { d: TypeDraft; set: (d: TypeDraft) => void; currency: string }) {
  return (
    <>
      <label>
        Name
        <input value={d.name} onChange={(e) => set({ ...d, name: e.target.value })} placeholder="e.g. Mahou 33 cl" required />
      </label>
      <div className="drink-fields">
        <label>
          ml
          <input inputMode="decimal" value={d.volumeMl} onChange={(e) => set({ ...d, volumeMl: e.target.value })} required />
        </label>
        <label>
          ABV %
          <input inputMode="decimal" value={d.abvPercent} onChange={(e) => set({ ...d, abvPercent: e.target.value })} required />
        </label>
        <label>
          kcal est.
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
          Price {currency === "EUR" ? "€" : currency}
          <input inputMode="decimal" value={d.price} onChange={(e) => set({ ...d, price: e.target.value })} />
        </label>
      </div>
    </>
  );
}

/**
 * Drinks: favourites logged in one tap (on a day picked first, for one forgotten), a one-off form
 * for anything else, what the period adds up to, the drinks logged (each can be changed or
 * deleted) and the favourites themselves. On a wide screen the one-off form and the favourites sit
 * beside the rest; on a phone they open on demand.
 */
export function AlcoholView({ db, version, onChanged, managing, onManage }: Props) {
  const [period, setPeriod] = useState<Period>("week");
  const [impact, setImpact] = useState<WeightWithoutAlcohol | null>(null);
  const [types, setTypes] = useState<DrinkType[]>([]);
  const [recent, setRecent] = useState<Map<string, number>>(new Map());
  const [drinks, setDrinks] = useState<DrinkEntry[]>([]);
  const [week, setWeek] = useState<DrinkEntry[]>([]);
  const [currency, setCur] = useState("EUR");
  const [msg, setMsg] = useState<Msg>(null);
  const [lastIds, setLastIds] = useState<string[]>([]);
  const [showAll, setShowAll] = useState(false);

  const [draft, setDraft] = useState<Draft | null>(null);
  const [limit, setLimit] = useState<number | null>(null);
  const [editingFav, setEditingFav] = useState<TypeDraft | null>(null);
  const [editingDrink, setEditingDrink] = useState<DrinkDraft | null>(null);
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
    const weekFrom = addDays(to, -6);
    const [w, t, r, d, wk, c, goals] = await Promise.all([
      weightWithoutAlcohol(db, from, to),
      listDrinkTypes(db),
      typeUsesSince(db, weekFrom),
      listDrinks(db, from, to),
      listDrinks(db, weekFrom, to),
      getCurrency(db),
      listGoals(db, to),
    ]);
    // The weekly limit from the goals: drinks, or grams of alcohol as standard drinks (10 g).
    const g = goals.find((x) => x.targetKind === "drink" && x.period === "week" && x.comparator === "<=" && x.targetNum !== null);
    setLimit(g ? (g.metric === "alcohol_g" ? Math.round(g.targetNum! / 10) : g.targetNum) : null);
    setImpact(w);
    setTypes(t);
    setRecent(r);
    setDrinks(d);
    setWeek(wk);
    setCur(c);
  }, [db, period]);

  useEffect(() => {
    void load();
  }, [load, version]);

  const money = (n: number) => fmtMoney(n, currency);
  const run = changeRunner({ setMsg, load, onChanged, scope: "alcohol" });
  const periodLabel = PERIODS.find((p) => p.key === period)!.label;

  /** When the drink was had: now for today, otherwise the picked time on the picked day. */
  function drunkAt(): number | undefined {
    if (isToday) return undefined;
    if (day > today()) throw new Error("That day has not happened yet");
    return localDateTimeToMs(day, at, timeZone()).ms;
  }

  async function saveFav(e: FormEvent) {
    e.preventDefault();
    if (editingFav && (await run(() => saveDrinkType(db, fromDraft(editingFav)), `Saved ${editingFav.name.trim()}.`))) setEditingFav(null);
  }

  async function saveDrink(e: FormEvent) {
    e.preventDefault();
    if (!editingDrink) return;
    const d = editingDrink;
    const ok = await run(
      () => updateDrink(db, d.entryId, { ...fromDraft(d), atMs: localDateTimeToMs(d.day, d.at, timeZone()).ms, timeZone: timeZone() }),
      `Saved ${d.name.trim()}.`,
    );
    if (ok) setEditingDrink(null);
  }

  const editDrink = (d: DrinkEntry) => {
    const hhmm = new Date(d.drunkAtMs).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false });
    setEditingDrink({ ...toDraft({ ...d, calories: d.kcalEstimated ? null : Math.round(d.kcal) }), entryId: d.id, day: d.localDay, at: hhmm });
  };

  const usedLine = (t: DrinkType) => `${recent.get(t.id) ?? 0}× in 7 days`;
  const typeLine = (t: Pick<DrinkType, "volumeMl" | "abvPercent" | "calories" | "price">) =>
    `${t.volumeMl} ml · ${t.abvPercent}% · ${servingKcal(t)} kcal${t.price !== null ? ` · ${money(t.price)}` : ""}`;
  const t = impact?.totals;
  const shown = showAll ? drinks : drinks.slice(0, FIRST);
  const favourite = editingDrink ? types.find((x) => x.id === drinks.find((d) => d.id === editingDrink.entryId)?.typeId) : undefined;

  const favourites = (
    <section className="card">
      <h3>Favourites</h3>
      <p className="muted small">Shown first under Drinks, one tap to add</p>
      {types.length === 0 && <p className="muted small">Log a one-off drink with Also save as a favourite, or add one here.</p>}
      <ul className="entries">
        {types.map((d) => (
          <li key={d.id}>
            <div className="grow">
              <div>
                {d.name}
                {d.createdBy === "assistant" && <span className="muted small"> · added by the assistant</span>}
              </div>
              <div className="muted small">
                {typeLine(d)} · {usedLine(d)}
              </div>
            </div>
            <button className="secondary" onClick={() => setEditingFav(toDraft(d))}>
              Edit
            </button>
          </li>
        ))}
      </ul>
      {editingFav && (
        <form className="stack edit-panel" onSubmit={saveFav}>
          <strong>{editingFav.id ? `Editing favourite: ${editingFav.name}` : "New favourite"}</strong>
          <TypeFields d={editingFav} set={setEditingFav} currency={currency} />
          <p className="muted small">Drinks already logged keep their own values; edit those from the list.</p>
          <EditActions
            onCancel={() => setEditingFav(null)}
            onRemove={editingFav.id ? () => void run(() => deleteDrinkType(db, editingFav.id!), "Removed.").then((ok) => ok && setEditingFav(null)) : undefined}
            confirmRemove={`Remove ${editingFav.name}? Drinks already logged keep their kcal and price.`}
          />
        </form>
      )}
      <div className="actions">
        <button className="secondary" onClick={() => setEditingFav({ ...emptyType })}>
          New favourite
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
    </section>
  );

  // On a phone the favourites are a page of their own; the rest of the screen waits behind it.
  if (managing) {
    return (
      <div className="narrow-page">
        {favourites}
        <MsgLine msg={msg} />
      </div>
    );
  }

  return (
    <div>
      {/* A wide screen: the week and the period on the left, as tall as adding on the right, then
          the figures and the list across. On a phone the columns step aside (display: contents) and
          the order is the week, adding, then the period. */}
      <div className="drinks-top">
        <div className="drinks-col main">
          <DrinksWeek week={week} limit={limit} currency={currency} />
          <div className="drink-when">
            {isToday ? (
              <button type="button" className="link small" onClick={() => pickDay(addDays(today(), -1))}>
                Forgot one yesterday?
              </button>
            ) : (
              <>
                <label>
                  Day
                  <input type="date" value={day} max={today()} onChange={(e) => pickDay(e.target.value || today())} />
                </label>
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
          <div className="drinks-period">
            <ChipGroup options={PERIODS.map((p) => ({ id: p.key, label: p.label }))} value={period} onChange={setPeriod} label="Period" />
          </div>
        </div>
        <div className="drinks-col side">
          {draft && (
            <AddDrink
              db={db}
              draft={draft}
              setDraft={setDraft}
              currency={currency}
              atMs={drunkAt}
              dayLabel={forDay}
              onClose={() => setDraft(null)}
              onLogged={(ids, text) => {
                setLastIds(ids);
                setDraft(null);
                setMsg({ kind: "ok", text });
                void load();
                onChanged();
              }}
            />
          )}
          <section className="card drink-favs" aria-labelledby="drink-favs">
            <div className="section-head">
              <h2 id="drink-favs">Favourites</h2>
              <button type="button" className="link accent small" onClick={() => onManage(true)}>
                Manage ›
              </button>
            </div>
            <p className="muted small">Tap one to add it. The usual price is filled in and you can change it.</p>
            <div className="drink-fav-list">
              {types.map((d) => (
                <button key={d.id} type="button" className="drink-fav" onClick={() => setDraft(draftFrom(d))} aria-label={`Add ${d.name}${forDay}`}>
                  <span className="grow">
                    <strong>{d.name}</strong>
                    <span className="muted small block">
                      {typeLine(d)} · {usedLine(d)}
                    </span>
                  </span>
                  <span className="drink-plus" aria-hidden>
                    +
                  </span>
                </button>
              ))}
              {types.length === 0 && <p className="muted small">No favourites yet. Add a drink and keep it as a favourite.</p>}
            </div>
            <button type="button" className="secondary drink-another" onClick={() => setDraft(draftFrom(null))}>
              + Add another drink
            </button>
            {lastIds.length > 0 && msg?.kind === "ok" ? (
              <div className="drink-added" role="status">
                <span>{msg.text}</span>
                <button
                  type="button"
                  className="link accent"
                  onClick={() =>
                    void run(async () => {
                      for (const id of lastIds) await deleteDrink(db, id);
                      setLastIds([]);
                    }, "Undone.")
                  }
                >
                  Undo
                </button>
              </div>
            ) : (
              <MsgLine msg={msg} />
            )}
          </section>
        </div>
      </div>

      {t && (
        <div className="viz-tiles alcohol-tiles">
          <StatTile label="Drinks" value={String(t.drinks)} note={`${t.standardDrinks.toLocaleString(undefined, { maximumFractionDigits: 1 })} standard`} />
          <StatTile label="Calories" value={kcal(t.kcal)} unit="kcal" note={t.kcalEstimated ? "some estimated" : "from drinks"} />
          <StatTile
            label="Spent"
            value={money(t.money)}
            note={t.priced < t.drinks ? `${t.drinks - t.priced} without price` : periodLabel === "Today" ? "today" : periodLabel}
          />
          {impact?.weight && impact.expectedKg !== null && (
            <StatTile
              label="Weight without alcohol"
              value={kg(impact.expectedKg)}
              unit="kg"
              note={`instead of ${kg(impact.weight.kg)} kg (${impact.kgFromAlcohol > 0 ? `−${kg(impact.kgFromAlcohol)}` : "no difference"}) · an upper bound`}
            />
          )}
        </div>
      )}

      <div>
        <section className="card drinks-list">
          <SectionHeader title="Drinks" action={!showAll && drinks.length > FIRST ? `All ${drinks.length}` : undefined} onAction={() => setShowAll(true)} />
          <p className="muted small">
            {periodLabel === "Today" ? "Today" : `Last ${periodLabel}`} · {drinks.length} {drinks.length === 1 ? "drink" : "drinks"} · tap the pencil to change
            one
          </p>
          {drinks.length ? (
            <ul className="entries drink-list">
              {shown.map((d) => (
                <li key={d.id} className={editingDrink?.entryId === d.id ? "editing" : undefined}>
                  <div className="grow">
                    <div>{d.name}</div>
                    <div className="muted small">
                      {fmtDay(d.localDay)} · {time(d.drunkAtMs)} · {d.volumeMl} ml · {d.abvPercent}% · {kcal(d.kcal)} kcal{d.kcalEstimated ? " (est.)" : ""}
                      {d.price !== null && ` · ${money(d.price)}`}
                    </div>
                  </div>
                  <button className="icon-button ghost" aria-label={`Change ${d.name}, ${fmtDay(d.localDay)}`} onClick={() => editDrink(d)}>
                    <Icon name="pencil" size={18} />
                  </button>
                  <button
                    className="icon-button ghost"
                    aria-label={`Delete ${d.name}, ${fmtDay(d.localDay)}`}
                    onClick={() => void run(() => deleteDrink(db, d.id), "Deleted.")}
                  >
                    <Icon name="trash" size={18} />
                  </button>
                  {editingDrink?.entryId === d.id && (
                    <form className="stack edit-panel" onSubmit={saveDrink}>
                      <strong>
                        Edit drink{" "}
                        <span className="muted small">
                          {fmtDay(d.localDay)}, {time(d.drunkAtMs)}
                        </span>
                      </strong>
                      <TypeFields d={editingDrink} set={(x) => setEditingDrink({ ...editingDrink, ...x })} currency={currency} />
                      <div className="drink-when-fields">
                        <label>
                          Day
                          <input
                            type="date"
                            value={editingDrink.day}
                            max={today()}
                            onChange={(e) => setEditingDrink({ ...editingDrink, day: e.target.value || today() })}
                          />
                        </label>
                        <label>
                          Time
                          <input type="time" value={editingDrink.at} onChange={(e) => setEditingDrink({ ...editingDrink, at: e.target.value || EVENING })} />
                        </label>
                      </div>
                      {favourite && <p className="muted small">Changes this drink only; the {favourite.name} favourite stays as it is.</p>}
                      <EditActions
                        onCancel={() => setEditingDrink(null)}
                        onRemove={() => void run(() => deleteDrink(db, d.id), "Deleted.").then((ok) => ok && setEditingDrink(null))}
                        confirmRemove={`Delete this ${d.name}?`}
                      />
                    </form>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">No drinks in this period.</p>
          )}
        </section>
      </div>
    </div>
  );
}
