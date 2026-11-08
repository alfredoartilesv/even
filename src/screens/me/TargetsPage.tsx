import { useEffect, useRef, useState, type ReactNode } from "react";
import type { SqlDriver } from "../../db/driver";
import { loadTargets, setTarget, type DailyTargets, type TargetKey } from "../../domain/me/targets";
import { failed, MsgLine, today, type Msg } from "../../ui/common";
import { Stepper } from "../../ui/controls";

const ROWS: { key: TargetKey; label: string; note: string; step: number; start: number; min: number; max: number; unit: string }[] = [
  { key: "kcal", label: "Calories", note: "per day, at most", step: 50, start: 2300, min: 1000, max: 6000, unit: "kcal" },
  { key: "protein", label: "Protein", note: "per day", step: 5, start: 120, min: 20, max: 400, unit: "g" },
  { key: "carbs", label: "Carbs", note: "per day", step: 5, start: 240, min: 20, max: 800, unit: "g" },
  { key: "fat", label: "Fat", note: "per day", step: 5, start: 70, min: 10, max: 300, unit: "g" },
  { key: "steps", label: "Steps", note: "per day", step: 500, start: 10000, min: 1000, max: 50000, unit: "" },
  { key: "drinks", label: "Drinks", note: "per week, at most", step: 1, start: 10, min: 0, max: 50, unit: "drinks" },
];

/**
 * You > Targets (handoff 0.7): the everyday targets with − and +, each saved a moment after the
 * last tap; a target not set yet starts from a gentle default with Set. The other goals follow.
 */
export function TargetsPage({
  db,
  version,
  goals,
  onChanged,
  ask,
}: {
  db: SqlDriver;
  version: number;
  goals: ReactNode;
  onChanged: () => void;
  ask?: () => void;
}) {
  const [t, setT] = useState<DailyTargets | null>(null);
  const [msg, setMsg] = useState<Msg>(null);
  const timers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  useEffect(() => {
    void loadTargets(db, today()).then(setT);
  }, [db, version]);

  // Saved a moment after the last tap, so stepping 2,300 to 2,000 writes one target, not six.
  const change = (key: TargetKey, value: number | null) => {
    setT((cur) => (cur ? { ...cur, [key]: value } : cur));
    clearTimeout(timers.current[key]);
    timers.current[key] = setTimeout(() => {
      void setTarget(db, key, value, today()).then(
        () => {
          setMsg({ kind: "ok", text: "Saved." });
          onChanged();
        },
        (err) => setMsg(failed(err, "me.targets")),
      );
    }, 700);
  };

  if (!t) return null;
  return (
    <div className="targets-page">
      <p className="muted small">Use the plus and minus buttons. Changes save on their own.</p>
      <section className="card targets-card" aria-label="Daily targets">
        {ROWS.map((r) => {
          const v = t[r.key];
          const fmt = (n: number) => `${n.toLocaleString()}${r.unit ? ` ${r.unit}` : ""}`;
          return (
            <div key={r.key} className="target-row">
              <span className="grow">
                <strong>{r.label}</strong>
                <span className="muted small block">{r.note}</span>
              </span>
              {v === null ? (
                <button type="button" className="secondary" onClick={() => change(r.key, r.start)}>
                  Set {fmt(r.start)}
                </button>
              ) : (
                <>
                  <Stepper label={r.label} value={v} onChange={(n) => change(r.key, n)} min={r.min} max={r.max} step={r.step} format={fmt} />
                  <button
                    type="button"
                    className="link small muted"
                    aria-label={`Remove the ${r.label.toLowerCase()} target`}
                    onClick={() => change(r.key, null)}
                  >
                    Remove
                  </button>
                </>
              )}
            </div>
          );
        })}
        <MsgLine msg={msg} />
      </section>
      {ask && (
        <section className="card targets-ask">
          <span className="grow">Not sure what to aim for? Coach can suggest targets from your weight and activity.</span>
          <button type="button" className="secondary" onClick={ask}>
            Ask Coach
          </button>
        </section>
      )}
      <h3 className="targets-more">Your other goals</h3>
      {goals}
    </div>
  );
}
