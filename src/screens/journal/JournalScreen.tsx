import { useCallback, useEffect, useState, type FormEvent } from "react";
import { addDays, localDateTimeToMs } from "../../core/tz";
import type { SqlDriver } from "../../db/driver";
import { LineChart, Sparkline } from "../../ui/charts";
import { failed, fmtDay, MsgLine, MsgWithUndo, NoteField, numOrNull, timeZone, today, type Msg } from "../../ui/common";
import { ChipGroup, ScaleRating } from "../../ui/controls";
import { Icon } from "../../ui/icons";
import { SectionHeader, Segmented, type Choice } from "../../ui/layout";
import {
  addMeasurement,
  deleteDayNote,
  deleteMeasurement,
  fmtMeasurement,
  getDayNote,
  KIND_PRESETS,
  kindLabel,
  listDayNotes,
  listMeasurements,
  measurementKinds,
  measurementSeries,
  presetFor,
  restoreMeasurement,
  saveDayNote,
  SCALE,
  type DayNote,
  type KindSummary,
  type Measurement,
} from "../../domain/journal/entries";

export type JournalView = "checkin" | "measurements";

const VIEWS: Choice<JournalView>[] = [
  { id: "checkin", label: "Check-in" },
  { id: "measurements", label: "Measurements" },
];

interface Props {
  db: SqlDriver;
  version: number;
  view: JournalView;
  onView: (v: JournalView) => void;
  /** The check-in's day when it opens (the Dashboard's day); today by default. */
  initialDay?: string;
  /** After any write, so the Dashboard reloads. */
  onChanged: () => void;
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const hhmm = (ms: number) => new Date(ms).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
const nowTime = () => {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

/**
 * The journal, opened from the Dashboard: the daily check-in (mood, energy and a note) and the
 * things measured by hand (weight, blood pressure, glucose, supplements, symptoms), with trends.
 */
export function JournalScreen({ db, version, view, onView, initialDay, onChanged }: Props) {
  return (
    <>
      <Segmented items={VIEWS} value={view} onChange={onView} label="Journal" />
      {view === "checkin" ? (
        <CheckIn db={db} version={version} initialDay={initialDay} onChanged={onChanged} />
      ) : (
        <Measurements db={db} version={version} onChanged={onChanged} />
      )}
    </>
  );
}

// ---- Check-in ----

function CheckIn({ db, version, initialDay, onChanged }: { db: SqlDriver; version: number; initialDay?: string; onChanged: () => void }) {
  const [day, setDay] = useState(initialDay && initialDay <= today() ? initialDay : today());
  const [saved, setSaved] = useState<DayNote | null>(null);
  const [mood, setMood] = useState<number | null>(null);
  const [energy, setEnergy] = useState<number | null>(null);
  const [body, setBody] = useState("");
  const [recent, setRecent] = useState<DayNote[]>([]);
  const [showAll, setShowAll] = useState(false);
  const [msg, setMsg] = useState<Msg>(null);

  const load = useCallback(async () => {
    const [n, r] = await Promise.all([getDayNote(db, day), listDayNotes(db, addDays(today(), -29), today())]);
    setSaved(n);
    setMood(n?.mood ?? null);
    setEnergy(n?.energy ?? null);
    setBody(n?.body ?? "");
    setRecent(r);
  }, [db, day]);

  useEffect(() => {
    void load();
  }, [load, version]);

  const dirty = (saved?.mood ?? null) !== mood || (saved?.energy ?? null) !== energy || (saved?.body ?? "") !== body.trim();

  async function save(e: FormEvent) {
    e.preventDefault();
    try {
      const n = await saveDayNote(db, { day, mood, energy, body }, today());
      setMsg({ kind: "ok", text: n ? "Saved." : "Nothing in it, so the note was removed." });
      onChanged();
      await load();
    } catch (err) {
      setMsg(failed(err, "journal.note"));
    }
  }

  const isToday = day === today();
  const rated = recent.filter((n) => n.mood !== null || n.energy !== null);
  const days30 = Array.from({ length: 30 }, (_, i) => addDays(today(), i - 29));
  const by = new Map(recent.map((n) => [n.day, n]));

  return (
    <>
      <div className="period-nav">
        <button type="button" className="secondary icon-button" aria-label="Previous day" onClick={() => setDay(addDays(day, -1))}>
          ‹
        </button>
        <div className="grow center">
          <strong>{cap(fmtDay(day))}</strong>
          {!isToday && (
            <button type="button" className="link small accent" onClick={() => setDay(today())}>
              Back to today
            </button>
          )}
        </div>
        <button type="button" className="secondary icon-button" aria-label="Next day" disabled={isToday} onClick={() => setDay(addDays(day, 1))}>
          ›
        </button>
      </div>

      <form key={day} className="card stack fade-in" onSubmit={save}>
        <strong>{isToday ? "How is the day going?" : "How was the day?"}</strong>
        <ScaleRating label="Mood" value={mood} onChange={setMood} words={SCALE} />
        <ScaleRating label="Energy" value={energy} onChange={setEnergy} words={SCALE} />
        <label>
          Note
          <textarea
            rows={4}
            value={body}
            maxLength={4000}
            placeholder="Sleep, stress, what you ate, how training went…"
            onChange={(e) => setBody(e.target.value)}
          />
        </label>
        {saved?.createdBy === "assistant" && <p className="muted small">Added by the assistant. Edit it as you like.</p>}
        <div className="actions">
          <button type="submit" disabled={!dirty}>
            {saved ? "Save changes" : "Save"}
          </button>
          {saved && (
            <button
              type="button"
              className="secondary danger"
              onClick={async () => {
                if (!confirm(`Delete the note for ${fmtDay(day)}?`)) return;
                await deleteDayNote(db, saved.id);
                setMsg({ kind: "ok", text: "Note deleted." });
                onChanged();
                await load();
              }}
            >
              Delete
            </button>
          )}
        </div>
        <MsgLine msg={msg} />
      </form>

      {rated.length >= 2 && (
        <LineChart
          title="Mood and energy"
          subtitle="Last 30 days, 1 (very low) to 5 (very good)"
          x={days30}
          series={[
            { id: "mood", label: "Mood", values: days30.map((d) => by.get(d)?.mood ?? null) },
            { id: "energy", label: "Energy", values: days30.map((d) => by.get(d)?.energy ?? null) },
          ]}
          formatX={(d) => String(Number(d.slice(8)))}
          formatXLong={(d) => fmtDay(d)}
          formatValue={(v) => SCALE[Math.round(v) - 1] ?? String(v)}
          connectGaps
          height={150}
        />
      )}

      <SectionHeader title="Last 30 days" />
      {recent.length === 0 ? (
        <p className="muted small">No notes yet. A line a day is enough to spot what makes good days good.</p>
      ) : (
        <ul className="entries">
          {(showAll ? recent : recent.slice(0, 7)).map((n) => (
            <li key={n.id}>
              <button type="button" className="link grow note-row" onClick={() => setDay(n.day)} aria-current={n.day === day ? "true" : undefined}>
                <div className="row">
                  <strong>{cap(fmtDay(n.day))}</strong>
                  <span className="muted small">
                    {[n.mood !== null && `mood ${SCALE[n.mood - 1].toLowerCase()}`, n.energy !== null && `energy ${SCALE[n.energy - 1].toLowerCase()}`]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                </div>
                {n.body && <div className="muted small clamp">{n.body}</div>}
              </button>
            </li>
          ))}
        </ul>
      )}
      {recent.length > 7 && (
        <button type="button" className="link small accent" onClick={() => setShowAll(!showAll)}>
          {showAll ? "Show the last 7" : `Show all ${recent.length}`}
        </button>
      )}
    </>
  );
}

// ---- Measurements ----

function Measurements({ db, version, onChanged }: { db: SqlDriver; version: number; onChanged: () => void }) {
  const [kinds, setKinds] = useState<KindSummary[]>([]);
  const [kind, setKind] = useState("weight");
  const [value, setValue] = useState("");
  const [value2, setValue2] = useState("");
  const [text, setText] = useState("");
  const [notes, setNotes] = useState("");
  const [day, setDay] = useState(today());
  const [time, setTime] = useState(nowTime());
  const [open, setOpen] = useState<string | null>(null);
  const [msg, setMsg] = useState<Msg>(null);
  const [undo, setUndo] = useState<{ id: string; deleted: boolean } | null>(null);

  const load = useCallback(async () => setKinds(await measurementKinds(db)), [db]);
  useEffect(() => {
    void load();
  }, [load, version]);

  // Presets first in their order, then kinds only the chat (or an import) has used.
  const options = [...KIND_PRESETS.map((p) => p.kind), ...kinds.map((k) => k.kind).filter((k) => !KIND_PRESETS.some((p) => p.kind === k))];
  const p = presetFor(kind);

  async function add(e: FormEvent) {
    e.preventDefault();
    try {
      const at = localDateTimeToMs(day, time, timeZone());
      const id = await addMeasurement(db, { kind, value: numOrNull(value), value2: numOrNull(value2), text, notes, atMs: at.ms, timeZone: timeZone() });
      setValue("");
      setValue2("");
      setText("");
      setNotes("");
      setUndo({ id, deleted: false });
      setMsg({ kind: "ok", text: `${p.label} saved.` });
      setOpen(kind);
      onChanged();
      await load();
    } catch (err) {
      setMsg(failed(err, "journal.measurement"));
    }
  }

  async function remove(m: Measurement) {
    await deleteMeasurement(db, m.id);
    setUndo({ id: m.id, deleted: true });
    setMsg({ kind: "ok", text: `Deleted ${kindLabel(m.kind).toLowerCase()} of ${fmtDay(m.day)}.` });
    onChanged();
    await load();
  }

  async function undoLast() {
    if (!undo) return;
    if (undo.deleted) await restoreMeasurement(db, undo.id);
    else await deleteMeasurement(db, undo.id);
    setUndo(null);
    setMsg({ kind: "ok", text: "Undone." });
    onChanged();
    await load();
  }

  return (
    <>
      <form className="card stack" onSubmit={add}>
        <strong>Add a measurement</strong>
        <ChipGroup options={options.map((k) => ({ id: k, label: kindLabel(k) }))} value={kind} onChange={setKind} label="What" />
        {p.shape === "text" ? (
          <label>
            {p.label}
            <input value={text} maxLength={200} placeholder={p.hint} onChange={(e) => setText(e.target.value)} />
          </label>
        ) : (
          <div className="grid">
            <label>
              <span>
                {p.shape === "pair" ? "Systolic" : p.label}
                {p.unit && <span className="muted small"> {p.unit}</span>}
              </span>
              <input inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)} />
            </label>
            {p.shape === "pair" && (
              <label>
                <span>
                  Diastolic<span className="muted small"> {p.unit}</span>
                </span>
                <input inputMode="decimal" value={value2} onChange={(e) => setValue2(e.target.value)} />
              </label>
            )}
          </div>
        )}
        <div className="grid">
          <label>
            Day
            <input type="date" value={day} max={today()} onChange={(e) => setDay(e.target.value)} />
          </label>
          <label>
            Time
            <input type="time" value={time} onChange={(e) => setTime(e.target.value)} />
          </label>
        </div>
        <NoteField value={notes} onChange={setNotes} />
        <button type="submit">Save {p.label.toLowerCase()}</button>
        <MsgWithUndo msg={msg} onUndo={undo ? () => void undoLast() : null} />
      </form>

      <SectionHeader title="Your measurements" />
      {kinds.length === 0 ? (
        <p className="muted small">Nothing logged yet. Weight logged here also feeds the estimates in your profile and the alcohol screen.</p>
      ) : (
        kinds.map((k) => (
          <KindCard
            key={k.kind}
            db={db}
            summary={k}
            open={open === k.kind}
            onToggle={() => setOpen(open === k.kind ? null : k.kind)}
            onDelete={remove}
            version={version}
          />
        ))
      )}
    </>
  );
}

/** One kind: the latest value and a 90-day trend; opened, the chart and every entry with delete. */
function KindCard({
  db,
  summary,
  open,
  onToggle,
  onDelete,
  version,
}: {
  db: SqlDriver;
  summary: KindSummary;
  open: boolean;
  onToggle: () => void;
  onDelete: (m: Measurement) => void;
  version: number;
}) {
  const [series, setSeries] = useState<{ days: string[]; values: (number | null)[]; values2: (number | null)[] } | null>(null);
  const [entries, setEntries] = useState<Measurement[]>([]);
  const p = presetFor(summary.kind);
  const numeric = p.shape !== "text";

  useEffect(() => {
    const to = today();
    const from = addDays(to, -89);
    void (numeric ? measurementSeries(db, summary.kind, from, to) : Promise.resolve(null)).then(setSeries);
    if (open) void listMeasurements(db, addDays(to, -365), to, summary.kind).then(setEntries);
  }, [db, summary.kind, summary.count, summary.latest.id, open, numeric, version]);

  // Only the days with an entry: the line stays whole when weigh-ins skip days, and starts at the first one.
  const logged = series ? series.days.map((d, i) => ({ d, v: series.values[i], v2: series.values2[i] })).filter((x) => x.v !== null) : [];
  const points = logged.length;
  const [showAll, setShowAll] = useState(false);
  const l = summary.latest;

  return (
    <section className="card kind-card">
      <button type="button" className="link kind-head" onClick={onToggle} aria-expanded={open}>
        <span className="grow">
          <span className="muted small block">{kindLabel(summary.kind)}</span>
          <strong className="kind-value">{fmtMeasurement(l)}</strong>
          <span className="muted small block">
            {cap(fmtDay(l.day))}, {hhmm(l.atMs)} · {summary.count} {summary.count === 1 ? "entry" : "entries"}
          </span>
        </span>
        {/* Logged points joined, so a kind measured every few days still reads as a trend. */}
        {numeric && points >= 2 && <Sparkline values={logged.map((x) => x.v)} label={`${kindLabel(summary.kind)}, last 90 days`} />}
        <Icon name="chevron" size={18} />
      </button>
      {open && (
        <div className="fade-in">
          {numeric && series && points >= 2 && (
            <LineChart
              title={kindLabel(summary.kind)}
              subtitle={`${points} days with an entry, last 90 days`}
              x={logged.map((x) => x.d)}
              series={
                p.shape === "pair"
                  ? [
                      { id: "a", label: "Systolic", values: logged.map((x) => x.v) },
                      { id: "b", label: "Diastolic", values: logged.map((x) => x.v2) },
                    ]
                  : [{ id: "a", label: kindLabel(summary.kind), values: logged.map((x) => x.v) }]
              }
              formatX={(d) => new Date(`${d}T12:00:00Z`).toLocaleDateString(undefined, { day: "numeric", month: "short", timeZone: "UTC" })}
              formatXLong={(d) => fmtDay(d)}
              unit={l.unit ?? undefined}
              height={160}
            />
          )}
          <ul className="entries">
            {(showAll ? entries : entries.slice(0, 7)).map((m) => (
              <li key={m.id}>
                <div className="grow">
                  <div>{fmtMeasurement(m)}</div>
                  <div className="muted small">
                    {cap(fmtDay(m.day))}, {hhmm(m.atMs)}
                    {m.notes && ` · ${m.notes}`}
                    {m.createdBy === "assistant" && " · added by the assistant"}
                  </div>
                </div>
                <button
                  type="button"
                  className="icon-button ghost"
                  aria-label={`Delete ${kindLabel(m.kind).toLowerCase()} of ${fmtDay(m.day)}`}
                  onClick={() => onDelete(m)}
                >
                  <Icon name="trash" size={18} />
                </button>
              </li>
            ))}
          </ul>
          {entries.length > 7 && (
            <button type="button" className="link small accent" onClick={() => setShowAll(!showAll)}>
              {showAll ? "Show the last 7" : `Show all ${entries.length}`}
            </button>
          )}
        </div>
      )}
    </section>
  );
}
