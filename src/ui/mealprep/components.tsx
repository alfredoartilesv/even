import type { CSSProperties } from "react";
import { StackedBar, StatTile } from "../charts/figures";
import { seriesColor } from "../charts/frame";
import { StatusBadge, type Status } from "../controls";
import { fmtDay, plural } from "../common";
import { addDays } from "../../core/tz";
import { daysCovered, planRows, timelineDays, type PlanLike, type TimelineDay } from "./timeline";

/**
 * Meal prep, drawn: what is in stock, how long it lasts, what to take out of the freezer when,
 * and what needs eating. Plain props in, callbacks out; the screen in screens/mealprep loads
 * the data.
 */

/** Fridge, freezer and days covered as three tiles. */
export function StockSummary({
  plan,
  fridgeNow,
  freezerNow,
  perDay,
  today,
}: {
  plan: PlanLike;
  fridgeNow: number;
  freezerNow: number;
  perDay: number;
  today: string;
}) {
  const covered = daysCovered(plan, today);
  return (
    <div className="viz-tiles">
      <StatTile label="Fridge" value={String(fridgeNow)} unit={fridgeNow === 1 ? "portion" : "portions"} note="ready to eat" />
      <StatTile label="Freezer" value={String(freezerNow)} unit={freezerNow === 1 ? "portion" : "portions"} />
      <StatTile
        label="Covered"
        value={String(covered)}
        unit={covered === 1 ? "day" : "days"}
        note={perDay > 0 ? `at ${plural(perDay, "portion")} a day` : "no portions planned"}
      />
    </div>
  );
}

export interface StockAlertItem {
  id: string;
  kind: "expired" | "eat_soon" | "thawing" | "freezer_old";
  text: string;
}

const ALERT_STATUS: Record<StockAlertItem["kind"], Status> = { expired: "critical", eat_soon: "warning", freezer_old: "warning", thawing: "info" };
const ALERT_WORD: Record<StockAlertItem["kind"], string> = { expired: "Past eat-by", eat_soon: "Eat soon", freezer_old: "Old", thawing: "Defrosting" };

/** Alerts most urgent first (the order the screen passes), each with its badge. */
export function StockAlerts({ alerts }: { alerts: StockAlertItem[] }) {
  if (!alerts.length) return null;
  return (
    <ul className="plain alerts">
      {alerts.map((a) => (
        <li key={a.id}>
          <StatusBadge status={ALERT_STATUS[a.kind]}>{ALERT_WORD[a.kind]}</StatusBadge> <span className="small">{a.text}</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * Where a batch's portions are: eaten, in the fridge, in the freezer, thrown out, as one bar
 * with counts, so a batch's history reads at a glance.
 */
export function BatchBar({ cooked, eaten, fridge, freezer, discarded }: { cooked: number; eaten: number; fridge: number; freezer: number; discarded: number }) {
  // Fixed slots per place, so "freezer" is the same color on every batch.
  const parts = [
    { label: "Eaten", value: eaten, slot: 1 },
    { label: "Fridge", value: fridge, slot: 2 },
    { label: "Freezer", value: freezer, slot: 3 },
    { label: "Thrown out", value: discarded, slot: 4 },
  ].filter((p) => p.value > 0);
  return <StackedBar parts={parts} label={`${plural(cooked, "portion")} cooked`} />;
}

/** "Sat" and "31" for a day, the way a calendar shows it. */
function dayParts(day: string): { weekday: string; date: string } {
  const [y, m, d] = day.split("-").map(Number);
  const weekday = new Date(Date.UTC(y, m - 1, d)).toLocaleDateString(undefined, { weekday: "short", timeZone: "UTC" });
  return { weekday, date: String(d) };
}

/** A batch's color in the plan: the same slot on the strip, the legend and every day row. */
export type BatchColors = Map<string, number>;

export function batchColors(ids: string[]): BatchColors {
  return new Map(ids.map((id, i) => [id, (i % 5) + 1]));
}

/** "Tonight: take 1 turkey chili out of the freezer for Wed", or "Defrost now" when it is late. */
function takeOutLine(t: TimelineDay["takeOut"][number]) {
  return (
    <span className="plan-thaw small">
      {t.late ? <StatusBadge status="critical">Defrost now</StatusBadge> : "Tonight: "}take {t.portions} {t.name.toLowerCase()} out of the freezer for{" "}
      {fmtDay(t.forDay)}
    </span>
  );
}

/**
 * The plan day by day: the date, which tupper is eaten (fridge or thawed, and until when), what to
 * take out of the freezer that night, and the days with nothing folded into one row. On a wide
 * screen the CSS lays the days out as a calendar.
 */
export function PlanDays({ plan, today, horizon = 14, colors }: { plan: PlanLike; today: string; horizon?: number; colors: BatchColors }) {
  const days = timelineDays(plan, today, horizon);
  const lastMeal = [...days].reverse().find((d) => d.meals.length > 0)?.day;
  return (
    <ol className="plan-days" aria-label={`Meal prep for the next ${horizon} days`}>
      {planRows(days).map((r) => {
        if (r.kind === "gap") {
          const a = dayParts(r.from);
          const b = dayParts(r.to);
          return (
            <li key={r.from} className="plan-day gap" style={{ "--gap-days": Math.min(r.days, 7) } as CSSProperties}>
              <span className="plan-date">
                <span className="small muted">{r.days > 1 ? `${a.weekday}–${b.weekday}` : a.weekday}</span>
                <strong>{r.days > 1 ? `${a.date}–${b.date}` : a.date}</strong>
              </span>
              <span className="plan-empty">
                <span>No tupper{r.days > 1 ? ` for ${plural(r.days, "day")}` : ""}</span>
                <span className="small">cook by {fmtDay(addDays(r.from, -1))}</span>
              </span>
            </li>
          );
        }
        const d = r.day;
        const p = dayParts(d.day);
        const isToday = d.day === today;
        return (
          <li key={d.day} className={isToday ? "plan-day today" : "plan-day"}>
            <span className="plan-date">
              <span className="small">{isToday ? "Today" : p.weekday}</span>
              <strong>{p.date}</strong>
            </span>
            <span className="plan-body">
              {d.meals.map((m) => (
                <span key={m.batchId} className="plan-meal" style={{ borderLeftColor: seriesColor(colors.get(m.batchId) ?? 1) }}>
                  <span className="grow">
                    <strong>
                      {m.name}
                      {m.portions > 1 ? ` ×${m.portions}` : ""}
                    </strong>
                    <span className="small muted">
                      {d.day === lastMeal
                        ? "the last tupper"
                        : m.from === "fridge"
                          ? m.eatBy === d.day
                            ? "its last good day"
                            : `eat by ${fmtDay(m.eatBy ?? d.day)}`
                          : m.thawDay && m.thawDay < d.day
                            ? `taken out ${dayParts(m.thawDay).weekday}`
                            : "defrosted"}
                    </span>
                  </span>
                  <span className={m.from === "fridge" ? "plan-where fridge" : "plan-where thawed"}>{m.from === "fridge" ? "Fridge" : "Thawed"}</span>
                </span>
              ))}
              {d.meals.length === 0 && d.state === "covered" && <span className="small muted">Already eaten</span>}
              {d.state === "short" && d.meals.length > 0 && <StatusBadge status="warning">{plural(d.missing, "tupper")} short</StatusBadge>}
              {d.takeOut.map((t) => (
                <span key={`${t.name}-${t.forDay}`}>{takeOutLine(t)}</span>
              ))}
              {d.expiring.map((w) => (
                <span key={w.name} className="small">
                  <StatusBadge status="warning">Eat or freeze</StatusBadge> {plural(w.portions, "portion")} of {w.name}
                </span>
              ))}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

/** The plan as a row of small day cells, colored by batch, for the Stock view. */
export function PlanStrip({ plan, today, horizon = 14, colors }: { plan: PlanLike; today: string; horizon?: number; colors: BatchColors }) {
  const days = timelineDays(plan, today, horizon);
  return (
    <ol className="plan-strip" aria-label={`Tuppers planned for the next ${horizon} days`}>
      {days.map((d) => {
        const p = dayParts(d.day);
        const m = d.meals[0];
        const what = m ? m.name : d.state === "short" ? "no tupper" : "already eaten";
        return (
          <li key={d.day} className={m ? "has" : d.state === "short" ? "none" : "eaten"} aria-label={`${fmtDay(d.day)}: ${what}`}>
            <span aria-hidden className="small muted">
              {p.weekday.slice(0, 1)}
            </span>
            <span aria-hidden className="small">
              {p.date}
            </span>
            <span aria-hidden className="plan-strip-cell" style={m ? { background: seriesColor(colors.get(m.batchId) ?? 1) } : undefined} />
          </li>
        );
      })}
    </ol>
  );
}

/**
 * The next days as a strip of small buttons (handoff 0.7, Plan): weekday, date and a dot per
 * tupper in its batch colour, an empty ring on a day with none. The chosen day is pressed.
 */
export function DayStrip({ days, value, onChange, colors }: { days: TimelineDay[]; value: string; onChange: (day: string) => void; colors: BatchColors }) {
  return (
    <div className="day-strip" role="group" aria-label="Pick a day">
      {days.map((d) => {
        const p = dayParts(d.day);
        const label = `${fmtDay(d.day)}: ${d.meals.length ? d.meals.map((m) => m.name).join(", ") : "no tupper"}`;
        return (
          <button
            key={d.day}
            type="button"
            className={d.day === value ? "day-pick on" : "day-pick"}
            aria-pressed={d.day === value}
            aria-label={label}
            onClick={() => onChange(d.day)}
          >
            <span className="small">{p.weekday}</span>
            <strong>{p.date}</strong>
            <span className="day-dots" aria-hidden>
              {d.meals.length ? (
                d.meals.map((m, i) => <span key={i} className="day-dot" style={{ background: `var(--series-${colors.get(m.batchId) ?? 1})` }} />)
              ) : (
                <span className="day-dot none" />
              )}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/** A batch's portions as dots (handoff 0.7, Stock): filled in the fridge, ringed in the freezer, faint once eaten or tossed. */
export function PortionDots({ fridge, freezer, gone }: { fridge: number; freezer: number; gone: number }) {
  const dots = [...Array(fridge).fill("fridge"), ...Array(freezer).fill("freezer"), ...Array(gone).fill("gone")] as string[];
  return (
    <div className="portion-dots" role="img" aria-label={`${plural(fridge, "portion")} in the fridge, ${freezer} in the freezer, ${gone} gone`}>
      {dots.map((k, i) => (
        <span key={i} className={`portion-dot ${k}`} />
      ))}
      <span className="portion-legend muted small">
        {fridge} fridge · {freezer} freezer
      </span>
    </div>
  );
}
