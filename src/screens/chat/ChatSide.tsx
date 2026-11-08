import { useEffect, useState } from "react";
import type { SqlDriver } from "../../db/driver";
import { consentStatus, recordConsent, type ConsentScope } from "../../domain/chat/consent";
import { deviceId } from "../../db/settings";
import { Switch } from "../../ui/controls";
import { Icon } from "../../ui/icons";
import { listDisclosures, type Disclosure } from "../../domain/chat/store";
import { loadDashboard, type Dashboard } from "../../domain/dashboard/dashboard";
import { fmtDuration } from "../../domain/me/workouts";
import { today } from "../../ui/common";

/** What Claude sees first: today's headline numbers, as the opening snapshot carries them. */
export function TodayInEven({ db, version }: { db: SqlDriver; version: number }) {
  const [d, setD] = useState<Dashboard | null>(null);
  useEffect(() => {
    const day = today();
    void loadDashboard(db, "day", day, day).then(setD);
  }, [db, version]);
  if (!d) return null;
  const n = (v: number | null) => (v === null ? "–" : Math.round(v).toLocaleString());
  const tiles: [string, string][] = [
    ["Sleep", d.body.sleep.total === null ? "–" : fmtDuration(d.body.sleep.total)],
    ["Steps", n(d.steps.total)],
    ["Eaten", d.eaten.total === null ? "–" : `${n(d.eaten.total)} kcal`],
    ["Drinks", d.alcohol.drinks ? String(d.alcohol.drinks) : "none today"],
  ];
  return (
    <section className="card today-in-even">
      <h3>Today in Even</h3>
      <p className="muted small">What Claude can ask about first</p>
      <dl>
        {tiles.map(([k, v]) => (
          <div key={k}>
            <dt className="muted small">{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

const KIND: Record<Exclude<ConsentScope, "claude.aggregates">, string> = {
  "claude.raw_series": "detailed records",
  "claude.notes": "notes",
  "claude.photos": "photos",
  "claude.files": "files",
};

/** What Claude may see, in one sentence, from the owner's choices in Privacy & data. */
export function ConsentLine({ db, version, onPrivacy }: { db: SqlDriver; version: number; onPrivacy: () => void }) {
  const [c, setC] = useState<Record<ConsentScope, boolean> | null>(null);
  useEffect(() => {
    void consentStatus(db).then(setC);
  }, [db, version]);
  if (!c) return null;
  const kinds = Object.keys(KIND) as (keyof typeof KIND)[];
  const on = kinds.filter((k) => c[k]).map((k) => KIND[k]);
  const off = kinds.filter((k) => !c[k]).map((k) => KIND[k]);
  const list = (xs: string[]) => (xs.length > 1 ? `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}` : xs[0]);
  return (
    <p className="muted small consent-line">
      {c["claude.aggregates"] ? "Claude sees questions and summaries" : "Claude sees nothing until you allow questions and summaries"}
      {on.length > 0 && `, and ${list(on)}`}
      {off.length > 0 && `; ${list(off)} ${off.length === 1 ? "is" : "are"} off`}.{" "}
      <button type="button" className="link accent" onClick={onPrivacy}>
        Privacy and data ›
      </button>
    </p>
  );
}

/** The newest send to Claude, so the owner sees what left the device last. */
export function LastSent({ db, version }: { db: SqlDriver; version: number }) {
  const [last, setLast] = useState<Disclosure | null>(null);
  useEffect(() => {
    void listDisclosures(db).then((d) => setLast(d[0] ?? null));
  }, [db, version]);
  if (!last) return null;
  return (
    <section className="card">
      <h3>Sent to Claude</h3>
      <p className="small">{last.summary}</p>
      <p className="muted small">
        {new Date(last.sentAtMs).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })} · {(last.bytes / 1024).toFixed(1)} KB
      </p>
    </section>
  );
}

const SHARE: { scope: ConsentScope; label: string; note: string }[] = [
  { scope: "claude.aggregates", label: "Daily totals and summaries", note: "Averages, ranges and trends, with your questions" },
  { scope: "claude.raw_series", label: "Detailed records", note: "Day-by-day values and single food entries, when Coach asks" },
  { scope: "claude.notes", label: "Your notes", note: "Day notes, mood and energy" },
  { scope: "claude.photos", label: "Photos you attach", note: "Only the photo you add to a message" },
  { scope: "claude.files", label: "Files you attach", note: "A lab report or an export you add" },
];

/**
 * What Claude can see (handoff 0.7, Coach's side): one switch per kind of data, the same consents
 * as You > Privacy and data, recorded as the owner flips them; the next question follows them.
 */
export function ShareSwitches({ db, version, onChanged }: { db: SqlDriver; version: number; onChanged: () => void }) {
  const [c, setC] = useState<Record<ConsentScope, boolean> | null>(null);
  useEffect(() => {
    void consentStatus(db).then(setC);
  }, [db, version]);
  if (!c) return null;
  return (
    <section className="card share-card" aria-labelledby="share-title">
      <div className="share-head">
        <Icon name="shield" size={18} />
        <h3 id="share-title">What Claude can see</h3>
      </div>
      <p className="muted small">You decide what leaves this device. Changes apply to your next question.</p>
      {SHARE.map((x) => (
        <Switch
          key={x.scope}
          label={x.label}
          description={x.note}
          checked={c[x.scope]}
          onChange={async (on) => {
            await recordConsent(db, x.scope, on, await deviceId(db));
            setC({ ...c, [x.scope]: on });
            onChanged();
          }}
        />
      ))}
    </section>
  );
}
