import { useCallback, useEffect, useState } from "react";
import type { SqlDriver } from "../../db/driver";
import { drinkKcalByDay } from "../../domain/alcohol/alcohol";
import { getNutritionTargets, nutritionRange, type DayTotals, type NutritionTargets } from "../../domain/food/food";
import { mean } from "../../core/health";
import { addDays } from "../../core/tz";
import { fmtDay, today } from "../../ui/common";
import { BarChart } from "../../ui/charts";
import { PeriodNav, SectionHeader } from "../../ui/layout";
import { budgetText, MacroBudget } from "../../ui/nutrition";
import { Icon } from "../../ui/icons";
import { kcal, weekEnding } from "./components";

const weekdayLetter = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString(undefined, { weekday: "narrow", timeZone: "UTC" });
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

interface Props {
  db: SqlDriver;
  version: number;
  /** Opens a day in the log, to see, edit or add to it. */
  onOpenDay: (day: string) => void;
}

/**
 * Seven days at a time: calories per day against the target, the week's daily averages against
 * every target, then each day with its totals. Tapping a bar or a day opens it in the log, where
 * it can be edited and added to.
 */
export function HistoryView({ db, version, onOpenDay }: Props) {
  const [weekEnd, setWeekEnd] = useState(today());
  const [week, setWeek] = useState<DayTotals[]>([]);
  const [drinkKcal, setDrinkKcal] = useState<Map<string, number>>(new Map());
  const [targets, setTargets] = useState<NutritionTargets>({ calories: null, proteinG: null, carbsG: null, fatG: null });

  const load = useCallback(async () => {
    const days = weekEnding(weekEnd);
    const [w, t, dk] = await Promise.all([nutritionRange(db, days[0], days[6]), getNutritionTargets(db), drinkKcalByDay(db, days[0], days[6])]);
    // Calories count food and drinks together.
    setWeek(w.map((d) => (dk.has(d.day) ? { ...d, calories: (d.calories ?? 0) + dk.get(d.day)! } : d)));
    setDrinkKcal(dk);
    setTargets(t);
  }, [db, weekEnd]);

  useEffect(() => {
    void load();
  }, [load, version]);

  const now = today();
  const logged = week.filter((d) => d.calories !== null);
  const avg = (k: "calories" | "proteinG" | "carbsG" | "fatG") => mean(logged.map((d) => d[k]).filter((v): v is number => v !== null));
  const overDays = targets.calories === null ? 0 : logged.filter((d) => (d.calories ?? 0) > targets.calories!).length;

  return (
    <div>
      <PeriodNav
        title={`${cap(fmtDay(addDays(weekEnd, -6)))} – ${fmtDay(weekEnd)}`}
        unit="week"
        onPrev={() => setWeekEnd(addDays(weekEnd, -7))}
        onNext={() => setWeekEnd(addDays(weekEnd, 7) > now ? now : addDays(weekEnd, 7))}
        nextDisabled={weekEnd >= now}
        onCurrent={weekEnd === now ? null : () => setWeekEnd(now)}
        currentLabel="Back to this week"
      />
      <div className="wide-grid">
        <div className="span-8">
          <BarChart
            title="Calories"
            subtitle="Food and drinks, tap a day to open it"
            x={week.map((d) => d.day)}
            values={week.map((d) => d.calories)}
            formatX={weekdayLetter}
            formatXLong={(d) => fmtDay(d)}
            formatValue={kcal}
            unit="kcal"
            target={targets.calories}
            onSelect={onOpenDay}
          />
          <p className="muted small">
            {logged.length === 0
              ? "Nothing logged these 7 days."
              : `${logged.length} of 7 days logged${targets.calories !== null ? `, ${overDays} over the calorie target` : ""}.`}
          </p>
        </div>

        {logged.length > 0 && (
          <div className="span-4">
            <SectionHeader title="Daily average" />
            <MacroBudget eaten={{ calories: avg("calories"), proteinG: avg("proteinG"), carbsG: avg("carbsG"), fatG: avg("fatG") }} targets={targets} />
          </div>
        )}
      </div>

      <SectionHeader title="Days" />
      <div className="menu-group">
        <ul>
          {[...week].reverse().map((d) => {
            const k = d.calories === null ? null : budgetText(d.calories, targets.calories, "kcal");
            return (
              <li key={d.day}>
                <button type="button" className="menu-row" onClick={() => onOpenDay(d.day)}>
                  <span className="grow">
                    <span className="menu-label">{cap(fmtDay(d.day))}</span>
                    <span className="menu-desc muted small">
                      {d.entries === 0 && !drinkKcal.has(d.day)
                        ? "Nothing logged"
                        : [
                            `${kcal(d.calories)} kcal`,
                            d.proteinG !== null && `P ${kcal(d.proteinG)} g`,
                            d.carbsG !== null && `C ${kcal(d.carbsG)} g`,
                            d.fatG !== null && `F ${kcal(d.fatG)} g`,
                          ]
                            .filter(Boolean)
                            .join(" · ")}
                    </span>
                  </span>
                  {k && targets.calories !== null && (
                    <span className={k.over ? "small warning" : "small muted"}>{k.over ? `${k.big} over` : `${k.big} left`}</span>
                  )}
                  <Icon name="chevron" size={18} />
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
