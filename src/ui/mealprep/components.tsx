import { StackedBar, StatTile } from "../charts/figures";
import { StatusBadge, type Status } from "../controls";
import { fmtDay, plural } from "../common";
import { daysCovered, timelineDays, type PlanLike } from "./timeline";

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

/**
 * The next days in a row: each says covered or how many portions are missing, what to take
 * out of the freezer that day, and what runs out. Today first; late defrosts show on today.
 */
export function DefrostTimeline({ plan, today, horizon = 7 }: { plan: PlanLike; today: string; horizon?: number }) {
  const days = timelineDays(plan, today, horizon);
  return (
    <ol className="timeline" aria-label="Meal prep for the next days">
      {days.map((d) => (
        <li key={d.day} className={d.state === "short" ? "short" : undefined}>
          <div className="timeline-day">
            <strong>{fmtDay(d.day, today)}</strong>
            {d.state === "short" ? (
              <StatusBadge status="warning">{plural(d.missing, "portion")} short</StatusBadge>
            ) : (
              <StatusBadge status="good">covered</StatusBadge>
            )}
          </div>
          {d.takeOut.map((t) => (
            <div key={`${t.name}-${t.forDay}`} className="small">
              {t.late ? <StatusBadge status="critical">Defrost now</StatusBadge> : <span className="muted">Take out </span>} {plural(t.portions, "portion")} of{" "}
              {t.name}
              <span className="muted"> for {fmtDay(t.forDay, today)}</span>
            </div>
          ))}
          {d.expiring.map((w) => (
            <div key={w.name} className="small">
              <StatusBadge status="warning">Eat or freeze</StatusBadge> {plural(w.portions, "portion")} of {w.name}
            </div>
          ))}
        </li>
      ))}
    </ol>
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
