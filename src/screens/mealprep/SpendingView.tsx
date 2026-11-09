import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { SqlDriver } from "../../db/driver";
import { getCurrency } from "../../domain/alcohol/alcohol";
import { listShopping } from "../../domain/mealprep/shopping";
import {
  addMonths,
  addTrip,
  deleteTrip,
  knownShops,
  listTrips,
  monthlySpending,
  monthOf,
  monthRange,
  restoreTrip,
  spending,
  type Spending,
  type Trip,
} from "../../domain/mealprep/spending";
import { BarChart, Meter, StatTile } from "../../ui/charts";
import { failed, fmtDay, fmtMoney, MsgWithUndo, NoteField, numOrNull, plural, timeZone, today, type Msg } from "../../ui/common";
import { Icon } from "../../ui/icons";
import { PeriodNav, SectionHeader } from "../../ui/layout";

interface Props {
  db: SqlDriver;
  version: number;
  onChanged: () => void;
}

const monthName = (month: string, style: "long" | "short" = "long") => {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, 15)).toLocaleDateString(
    undefined,
    style === "long" ? { month: "long", year: "numeric", timeZone: "UTC" } : { month: "short", timeZone: "UTC" },
  );
};
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * What the supermarket cost, under the shopping list: log a shop (where, how much, which day; it can clear the ticked
 * shopping list items), then the month's total, per supermarket, the last six months and each shop.
 */
export function SpendingView({ db, version, onChanged }: Props) {
  const [currency, setCurrency] = useState("EUR");
  const [shops, setShops] = useState<string[]>([]);
  const [ticked, setTicked] = useState(0);
  const [month, setMonth] = useState(monthOf(today()));
  const [sum, setSum] = useState<Spending | null>(null);
  const [prev, setPrev] = useState<number | null>(null);
  const [months, setMonths] = useState<{ month: string; total: number }[]>([]);
  const [trips, setTrips] = useState<Trip[]>([]);
  const [showAll, setShowAll] = useState(false);

  const [shop, setShop] = useState("");
  const [amount, setAmount] = useState("");
  const [day, setDay] = useState(today());
  const [notes, setNotes] = useState("");
  const [clear, setClear] = useState(true);
  const [msg, setMsg] = useState<Msg>(null);
  const [undo, setUndo] = useState<{ id: string; deleted: boolean } | null>(null);

  const load = useCallback(async () => {
    const r = monthRange(month);
    const p = monthRange(addMonths(month, -1));
    const [c, k, list, s, before, m, t] = await Promise.all([
      getCurrency(db),
      knownShops(db),
      listShopping(db),
      spending(db, r.from, r.to),
      spending(db, p.from, p.to),
      monthlySpending(db, month, 6),
      listTrips(db, r.from, r.to),
    ]);
    setCurrency(c);
    setShops(k);
    setTicked(list.filter((i) => i.checked).length);
    setSum(s);
    setPrev(before.trips ? before.total : null);
    setMonths(m);
    setTrips(t);
  }, [db, month]);

  useEffect(() => {
    void load();
  }, [load, version]);

  const money = (n: number) => fmtMoney(n, currency);
  const thisMonth = monthOf(today());

  async function add(e: FormEvent) {
    e.preventDefault();
    try {
      const id = await addTrip(db, { shop, amount: numOrNull(amount.replace(",", ".")), day, timeZone: timeZone(), notes, clearTicked: clear && ticked > 0 });
      setMsg({
        kind: "ok",
        text: `${money(Number(amount.replace(",", ".")))} at ${shop.trim()} saved${clear && ticked > 0 ? `, ${plural(ticked, "ticked item")} cleared` : ""}.`,
      });
      setAmount("");
      setNotes("");
      setUndo({ id, deleted: false });
      setMonth(monthOf(day));
      onChanged();
      await load();
    } catch (err) {
      setMsg(failed(err, "mealprep.spending"));
    }
  }

  async function remove(t: Trip) {
    await deleteTrip(db, t.id);
    setUndo({ id: t.id, deleted: true });
    setMsg({ kind: "ok", text: `Deleted ${t.shop}, ${fmtDay(t.day)}.` });
    onChanged();
    await load();
  }

  async function undoLast() {
    if (!undo) return;
    if (undo.deleted) await restoreTrip(db, undo.id);
    else await deleteTrip(db, undo.id);
    setUndo(null);
    setMsg({ kind: "ok", text: "Undone." });
    onChanged();
    await load();
  }

  const delta = sum && prev !== null ? sum.total - prev : null;

  // Its parts are cells of the shopping page's grid on a wide screen: Checkout beside the list, then
  // the month (figures, by supermarket) beside its shops and the six months' chart (9 Nov 2026).
  return (
    <div className="wide-contents">
      <section className="span-6">
        <SectionHeader title="Checkout" />
        <form className="card stack" onSubmit={add}>
          <label>
            Supermarket
            <input value={shop} maxLength={60} placeholder="e.g. Mercadona" autoComplete="off" onChange={(e) => setShop(e.target.value)} />
          </label>
          {shops.length > 0 && (
            <div className="chips" role="group" aria-label="Supermarkets used before">
              {shops.map((s) => (
                <button
                  key={s}
                  type="button"
                  className={s.toLowerCase() === shop.trim().toLowerCase() ? "chip active" : "chip"}
                  aria-pressed={s.toLowerCase() === shop.trim().toLowerCase()}
                  onClick={() => setShop(s)}
                >
                  {s}
                </button>
              ))}
            </div>
          )}
          <div className="grid">
            <label>
              <span>
                Paid<span className="muted small"> {currency}</span>
              </span>
              <input inputMode="decimal" value={amount} placeholder="0.00" onChange={(e) => setAmount(e.target.value)} />
            </label>
            <label>
              Day
              <input type="date" value={day} max={today()} onChange={(e) => setDay(e.target.value)} />
            </label>
          </div>
          <NoteField value={notes} onChange={setNotes} />
          {ticked > 0 && (
            <label className="inline">
              <input type="checkbox" checked={clear} onChange={(e) => setClear(e.target.checked)} />
              Clear the {plural(ticked, "ticked item")} from the shopping list
            </label>
          )}
          <button type="submit">{ticked > 0 && clear ? `Save purchase · clear ${plural(ticked, "item")}` : "Save purchase"}</button>
          <MsgWithUndo msg={msg} onUndo={undo ? () => void undoLast() : null} />
        </form>
      </section>

      <section className="span-6">
        <SectionHeader title="Spending" />
        <PeriodNav
          title={cap(monthName(month))}
          unit="month"
          onPrev={() => setMonth(addMonths(month, -1))}
          onNext={() => setMonth(addMonths(month, 1))}
          nextDisabled={month >= thisMonth}
          onCurrent={month === thisMonth ? null : () => setMonth(thisMonth)}
          currentLabel="Back to this month"
        />

        <div className="viz-tiles pairs">
          <StatTile
            label="Spent"
            value={sum ? money(sum.total) : null}
            delta={delta !== null && delta !== 0 ? { value: delta, period: `vs ${monthName(addMonths(month, -1), "short")}`, good: "down" } : null}
            formatDelta={money}
            note={month === thisMonth ? "so far this month" : undefined}
          />
          <StatTile
            label="Shops"
            value={sum ? String(sum.trips) : null}
            note={sum && sum.trips > 0 ? `${money(sum.total / sum.trips)} each on average` : undefined}
          />
        </div>

        {sum && sum.shops.length > 0 && (
          <>
            <SectionHeader title="By supermarket" />
            <div className="card stack">
              {sum.shops.map((s) => (
                <div key={s.shop}>
                  <div className="row">
                    <span className="grow">{s.shop}</span>
                    <span className="muted small">{plural(s.trips, "shop")}</span>
                    <strong>{money(s.total)}</strong>
                  </div>
                  <Meter value={s.total} max={sum.total} label={`${s.shop}: ${Math.round((s.total / sum.total) * 100)}% of the month`} />
                </div>
              ))}
            </div>
          </>
        )}
      </section>

      <section className="span-6">
        <SectionHeader title={`Shops in ${monthName(month, "short")}`} />
        {trips.length === 0 ? (
          <p className="muted small">
            {month === thisMonth ? "Nothing logged this month. After paying at the supermarket, log it above." : "Nothing logged that month."}
          </p>
        ) : (
          <>
            <ul className="entries">
              {(showAll ? trips : trips.slice(0, 7)).map((t) => (
                <li key={t.id}>
                  <div className="grow">
                    <div>
                      {t.shop} · <strong>{money(t.amount)}</strong>
                    </div>
                    <div className="muted small">
                      {cap(fmtDay(t.day))}
                      {t.items ? ` · ${plural(t.items, "item")} from the list` : ""}
                      {t.notes && ` · ${t.notes}`}
                      {t.createdBy === "assistant" && " · added by the assistant"}
                    </div>
                  </div>
                  <button type="button" className="icon-button ghost" aria-label={`Delete ${t.shop}, ${fmtDay(t.day)}`} onClick={() => void remove(t)}>
                    <Icon name="trash" size={18} />
                  </button>
                </li>
              ))}
            </ul>
            {trips.length > 7 && (
              <button type="button" className="link small accent" onClick={() => setShowAll(!showAll)}>
                {showAll ? "Show the last 7" : `Show all ${trips.length}`}
              </button>
            )}
          </>
        )}
        {months.some((m) => m.total > 0) && (
          <div className="spending-chart">
            <BarChart
              title="Groceries per month"
              subtitle="Last 6 months"
              x={months.map((m) => m.month)}
              values={months.map((m) => (m.total > 0 ? m.total : null))}
              formatX={(m) => monthName(m, "short")}
              formatXLong={(m) => cap(monthName(m))}
              formatValue={money}
              selected={month}
              onSelect={setMonth}
              height={150}
            />
          </div>
        )}
      </section>
    </div>
  );
}
