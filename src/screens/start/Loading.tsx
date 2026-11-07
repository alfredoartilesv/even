import type { CSSProperties, ReactNode } from "react";
import { PageHeader } from "../../ui/layout";
import { LoadingMark } from "../../ui/logo";

export interface LoadStep {
  label: string;
  done: boolean;
}

/**
 * Shown on every launch while the app gets ready, once that takes long enough to notice (the
 * shell waits about 400 ms first, so a quick start goes straight to Today). The ring spins, and
 * the counter and bar follow the real steps: the database open, the account read, ready.
 * Imported eagerly: it is on the start-up path, so it stays small (no screens, no zod).
 */
export function Loading({ steps, children }: { steps: LoadStep[]; children?: ReactNode }) {
  const pct = Math.round((steps.filter((s) => s.done).length / steps.length) * 100);
  return (
    <main className="loading-page" data-area="today" aria-busy={pct < 100}>
      <LoadingMark />
      <PageHeader title="Even" subtitle="Your health, in one calm place." />
      <div role="progressbar" aria-label="Loading" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} className="loading-progress">
        <span className="loading-count" style={{ "--ev-n": pct } as CSSProperties} />
        <span className="loading-bar">
          <span style={{ transform: `scaleX(${pct / 100})` }} />
        </span>
      </div>
      <ul className="loading-steps">
        {steps.map((s) => (
          <li key={s.label} className={s.done ? "done" : ""}>
            <span className="loading-check" aria-hidden />
            {s.label}
            <span className="sr-only">{s.done ? ", done" : ", in progress"}</span>
          </li>
        ))}
      </ul>
      {children}
    </main>
  );
}
