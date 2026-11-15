import { useCallback, useEffect, useState, type FormEvent } from "react";
import { addDays, localDateTimeToMs } from "../../core/tz";
import type { SqlDriver } from "../../db/driver";
import { changeRunner, EditActions, fmtDay, fmtDayLong, fmtMoney, MsgLine, numOrNull, plural, timeZone, today, type Msg } from "../../ui/common";
import { Icon } from "../../ui/icons";
import { PeriodNav, SectionHeader, Segmented, type Choice } from "../../ui/layout";
import { pinnedAnchor, shiftSpan, spanRange, type Span } from "../../domain/dashboard/dashboard";
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

/** The same spans as Today (the owner's ask, 15 Nov 2026): a day, or the 7 or 30 days up to one. */
const SPANS: Choice<Span>[] = [
  { id: "day", label: "Day" },
  { id: "week", label: "Week" },
  { id: "month", label: "Month" },
];

const upper = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
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
  const [span, setSpan] = useState<Span>("week");
  // null = the current span, which follows today; a past one the owner stepped back to stays put.
  const [picked, setPicked] = useState<string | null>(null);
  const now = today();
  const anchor = picked ?? now;
  const setAnchor = (d: string, sp: Span = span) => setPicked(pinnedAnchor(sp, d, now));
  const range = spanRange(span, anchor);
  const isCurrent = range.from <= now && now <= range.to;
  const many = span !== "day";
  const next = shiftSpan(span, anchor, 1);
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
  // Logging on a day outside the span moves the span to it, so the drink shows up once logged.
  function pickDay(d: string) {
    setDay(d);
    if (d < range.from || d > range.to) setAnchor(d);
  }

  const load = useCallback(async () => {
    const to = today();
    const { from, to: end } = spanRange(span, anchor);
    const weekFrom = addDays(to, -6);
    const [w, t, r, d, wk, c, goals] = await Promise.all([
      weightWithoutAlcohol(db, from, end),
      listDrinkTypes(db),
      typeUsesSince(db, weekFrom),
      listDrinks(db, from, end),
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
  }, [db, span, anchor]);

  useEffect(() => {
    void load();
  }, [load, version]);

  const money = (n: number) => fmtMoney(n, currency);
  const run = changeRunner({ setMsg, load, onChanged, scope: "alcohol" });
  // "Today", "Sat, Nov 14", "the last 7 days", "Nov 2 – Nov 8": the summary and the list say it.
  const periodLabel = !many
    ? anchor === now
      ? "Today"
      : upper(fmtDay(anchor))
    : isCurrent
      ? `the last ${span === "week" ? 7 : 30} days`
      : `${fmtDay(range.from)} – ${fmtDay(range.to)}`;
  // The date range is in the row above, so a past week or month is "that week" here, not the dates again.
  const when = !many ? (anchor === now ? "today" : `on ${periodLabel}`) : isCurrent ? `in ${periodLabel}` : `in that ${span === "week" ? "week" : "month"}`;

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
  // The days the span covers, oldest first (the same range load() reads).
  const periodDays = Array.from({ length: span === "day" ? 1 : span === "week" ? 7 : 30 }, (_, i) => addDays(range.to, -i)).reverse();
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
                Forgot one? Log it on an earlier day
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
          {/* Today's Day / Week / Month and its ‹ date › row (ui/layout PeriodNav bar). */}
          <div className="drinks-period">
            <Segmented
              items={SPANS}
              value={span}
              label="Period"
              onChange={(id) => {
                setSpan(id);
                // The day picked, or the last day of the week or month, stays in view.
                setAnchor(isCurrent ? now : range.to, id);
              }}
            />
            <PeriodNav
              bar
              title={many ? `${fmtDay(range.from)} – ${fmtDay(range.to)}` : fmtDayLong(anchor)}
              unit={span}
              onPrev={() => setAnchor(shiftSpan(span, anchor, -1))}
              onNext={() => setAnchor(many && next > now ? now : next)}
              nextDisabled={many ? range.to >= now : next > now}
              onCurrent={isCurrent ? null : () => setAnchor(now)}
              currentLabel={`Back to ${span === "day" ? "today" : `this ${span}`}`}
            />
          </div>
          {t && (
            <DrinksSummary drinks={drinks} days={periodDays} limit={limit} totals={t} periodLabel={periodLabel} when={when} money={money} impact={impact} />
          )}
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

      <div>
        {/* Built like History's Days: the title and the line about it on the page, the rows in one card. */}
        <section className="drinks-list">
          <SectionHeader title="Drinks" action={!showAll && drinks.length > FIRST ? `All ${drinks.length}` : undefined} onAction={() => setShowAll(true)} />
          <p className="muted small">
            {upper(periodLabel)} · {drinks.length} {drinks.length === 1 ? "drink" : "drinks"} · tap the pencil to change one
          </p>
          {drinks.length ? (
            <div className="menu-group">
              <ul className="drink-list">
                {shown.map((d) => (
                  <li key={d.id} className={editingDrink?.entryId === d.id ? "menu-row drink-row editing" : "menu-row drink-row"}>
                    <div className="grow">
                      <span className="menu-label">{d.name}</span>
                      <div className="menu-desc muted small">
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
            </div>
          ) : (
            <p className="muted">No drinks {when}.</p>
          )}
        </section>
      </div>
    </div>
  );
}

/**
 * What the period adds up to, in one card (the owner's ask, 15 Nov 2026, option C): the drinks
 * against the weekly limit (scaled to the period) with what they cost, then calories and dry days
 * as two tiles, then the weight without alcohol. Without a limit the bar is left out.
 */
function DrinksSummary({
  drinks,
  days,
  limit,
  totals,
  periodLabel,
  when,
  money,
  impact,
}: {
  drinks: DrinkEntry[];
  days: string[];
  /** The weekly limit in drinks, from the goals; null when none is set. */
  limit: number | null;
  totals: NonNullable<WeightWithoutAlcohol["totals"]>;
  periodLabel: string;
  /** "today", "on Sat, Nov 14", "in the last 7 days". */
  when: string;
  money: (n: number) => string;
  impact: WeightWithoutAlcohol | null;
}) {
  const had = new Set(drinks.map((d) => d.localDay));
  const dry = days.filter((d) => !had.has(d)).length;
  // The longest run of days in a row without a drink, in the period.
  let run = 0;
  let longest = 0;
  for (const d of days) {
    run = had.has(d) ? 0 : run + 1;
    longest = Math.max(longest, run);
  }
  // A weekly limit spread over the period: 7 days is the limit itself, 30 days about four weeks of it.
  const cap = limit !== null ? Math.max(1, Math.round((limit * days.length) / 7)) : null;
  const over = cap !== null && totals.drinks > cap;
  const left = cap !== null ? cap - totals.drinks : null;
  return (
    <section className="card drinks-summary" aria-label={`Drinks, ${periodLabel}`}>
      <div className="drink-limit-head">
        <span className="drink-limit-figure">
          <span className="muted small">Drinks {when}</span>
          <strong>
            {totals.drinks}
            <span className="muted"> {cap !== null ? `of ${cap} limit` : `· ${fmtStd(totals.standardDrinks)} standard`}</span>
          </strong>
        </span>
        <span className="drink-limit-figure end">
          <span className="muted small">Spent</span>
          <strong>{money(totals.money)}</strong>
          {totals.priced < totals.drinks && <span className="muted small">{totals.drinks - totals.priced} without price</span>}
        </span>
      </div>
      {cap !== null && left !== null && (
        <>
          <span className="drink-limit-bar" aria-hidden>
            <span className={over ? "over" : undefined} style={{ width: `${Math.min(100, Math.round((totals.drinks / cap) * 100))}%` }} />
          </span>
          <span className={over ? "small drink-limit-note over" : "muted small drink-limit-note"}>
            {over ? `${-left} over your limit` : left === 0 ? "At your limit" : `${left} left before your limit`}
          </span>
        </>
      )}
      <div className="drink-limit-tiles">
        <span className="drink-limit-tile">
          <span className="muted small">Calories</span>
          <strong>{kcal(totals.kcal)}</strong>
          <span className="muted small">{totals.kcalEstimated ? "kcal, some estimated" : "kcal from drinks"}</span>
        </span>
        {days.length > 1 ? (
          <span className="drink-limit-tile">
            <span className="muted small">Dry days</span>
            <strong>
              {dry} / {days.length}
            </strong>
            <span className="muted small">longest {plural(longest, "day")} in a row</span>
          </span>
        ) : (
          <span className="drink-limit-tile">
            <span className="muted small">Standard drinks</span>
            <strong>{fmtStd(totals.standardDrinks)}</strong>
            <span className="muted small">10 g of alcohol each</span>
          </span>
        )}
      </div>
      {impact?.weight && impact.expectedKg !== null && (
        <p className="drink-sum-weight">
          <span className="muted small">Weight without alcohol</span>
          <strong>{kg(impact.expectedKg)} kg</strong>
          <span className="muted small">
            instead of {kg(impact.weight.kg)} kg ({impact.kgFromAlcohol > 0 ? `−${kg(impact.kgFromAlcohol)}` : "no difference"}) · an upper bound
          </span>
        </p>
      )}
    </section>
  );
}

const fmtStd = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 1 });
