import { useCallback, useEffect, useState } from "react";
import type { SqlDriver } from "../../../db/driver";
import { drinkKcalByDay } from "../../alcohol/alcohol";
import { dayFood, getCalorieGoal, loggedDaysBefore, nutritionRange, type DayTotals, type FoodEntry } from "../food";
import { mean } from "../../../core/health";
import { addDays } from "../../../core/tz";
import { fmtDay, MsgLine, today, type Msg } from "../../../ui/common";
import { BarChart } from "../../../ui/charts";
import { EntryList, kcal, weekEnding } from "./components";
import { entryActions } from "./entryActions";

const weekdayLetter = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString(undefined, { weekday: "narrow", timeZone: "UTC" });

interface Props {
  db: SqlDriver;
  version: number;
  onChanged: () => void;
}

export function HistoryView({ db, version, onChanged }: Props) {
  const [day, setDay] = useState(today());
  const [weekEnd, setWeekEnd] = useState(today());
  const [week, setWeek] = useState<DayTotals[]>([]);
  const [drinkKcal, setDrinkKcal] = useState<Map<string, number>>(new Map());
  const [entries, setEntries] = useState<FoodEntry[]>([]);
  const [target, setTarget] = useState<number | null>(null);
  const [earlier, setEarlier] = useState<string | null>(null);
  const [msg, setMsg] = useState<Msg>(null);

  const load = useCallback(async () => {
    const days = weekEnding(weekEnd);
    const [w, e, g, prev, dk] = await Promise.all([
      nutritionRange(db, days[0], days[6]),
      dayFood(db, day),
      getCalorieGoal(db),
      loggedDaysBefore(db, day, 1),
      drinkKcalByDay(db, days[0], days[6]),
    ]);
    // Bars and averages count food and drinks together; the list below is food only.
    setWeek(w.map((d) => (dk.has(d.day) ? { ...d, calories: (d.calories ?? 0) + dk.get(d.day)! } : d)));
    setDrinkKcal(dk);
    setEntries(e);
    setTarget(g?.target ?? null);
    setEarlier(prev[0] ?? null);
  }, [db, day, weekEnd]);

  useEffect(() => {
    void load();
  }, [load, version]);

  const go = (d: string) => {
    setDay(d);
    if (d > weekEnd || d < addDays(weekEnd, -6)) setWeekEnd(d > today() ? today() : d);
  };

  const logged = week.filter((d) => d.calories !== null);
  const avg = mean(logged.map((d) => d.calories ?? 0));
  const overDays = target === null ? 0 : logged.filter((d) => (d.calories ?? 0) > target).length;
  const selected = week.find((d) => d.day === day);

  return (
    <div>
      <div className="row">
        <button className="secondary" aria-label="Previous week" onClick={() => { setWeekEnd(addDays(weekEnd, -7)); setDay(addDays(day, -7)); }}>
          ‹
        </button>
        <span className="small">
          {fmtDay(addDays(weekEnd, -6))} – {fmtDay(weekEnd)}
        </span>
        <button
          className="secondary"
          aria-label="Next week"
          disabled={weekEnd >= today()}
          onClick={() => {
            const end = addDays(weekEnd, 7) > today() ? today() : addDays(weekEnd, 7);
            setWeekEnd(end);
            setDay(end);
          }}
        >
          ›
        </button>
      </div>
      <BarChart
        title="Calories"
        subtitle="Food and drinks, tap a day to open it"
        x={week.map((d) => d.day)}
        values={week.map((d) => d.calories)}
        formatX={weekdayLetter}
        formatXLong={(d) => fmtDay(d)}
        formatValue={kcal}
        unit="kcal"
        target={target}
        selected={day}
        onSelect={setDay}
      />
      <p className="muted small">
        {avg === null
          ? "Nothing logged this week."
          : `Average ${kcal(avg)} kcal on ${logged.length} logged day${logged.length === 1 ? "" : "s"}${target !== null ? `, ${overDays} over target` : ""}.`}
      </p>

      <div className="row">
        <h2>{fmtDay(day)}</h2>
        <span className="muted small">
          {selected?.calories != null && `${kcal(selected.calories)} kcal`}
          {selected?.proteinG != null && ` · ${kcal(selected.proteinG)} g protein`}
          {drinkKcal.has(day) && ` · incl. ${kcal(drinkKcal.get(day)!)} kcal from drinks`}
        </span>
      </div>
      <div className="actions">
        <button className="secondary" disabled={!earlier} onClick={() => earlier && go(earlier)}>
          {earlier ? `Earlier: ${fmtDay(earlier)}` : "No earlier meals"}
        </button>
        {day !== today() && (
          <button className="secondary" onClick={() => go(today())}>
            Back to today
          </button>
        )}
      </div>
      <MsgLine msg={msg} />
      <EntryList
        db={db}
        entries={entries}
        {...entryActions(
          db,
          () => {
            void load();
            onChanged();
          },
          setMsg,
        )}
      />
    </div>
  );
}
