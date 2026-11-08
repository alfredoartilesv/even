import { createLogger } from "../core/log";
import { addDays, localDay } from "../core/tz";

export const timeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;
export const today = () => localDay(Date.now(), timeZone());

export type Msg = { kind: "ok" | "error"; text: string } | null;

/**
 * Turn an error from a screen action into the message shown to the owner, and log it.
 * Info level: most are input the core refused (and the core logs real failures itself).
 */
export function failed(err: unknown, scope: string): Msg {
  createLogger(`ui.${scope}`).info("action failed", { err });
  return { kind: "error", text: (err as Error)?.message ?? String(err) };
}

/**
 * A change made from a screen: do it, say so (or say why it failed), reload the screen and tell
 * the app. Resolves to whether it worked, so a form can close only on success.
 */
export function changeRunner(o: { setMsg: (m: Msg) => void; load: () => Promise<unknown>; onChanged: () => void; scope: string }) {
  return async (fn: () => Promise<unknown>, ok: string): Promise<boolean> => {
    try {
      await fn();
      o.setMsg({ kind: "ok", text: ok });
      await o.load();
      o.onChanged();
      return true;
    } catch (err) {
      o.setMsg(failed(err, o.scope));
      return false;
    }
  };
}

/** Save and Cancel under an edit form, and Remove (after a confirmation) when the item exists already. */
export function EditActions({ onCancel, onRemove, confirmRemove }: { onCancel: () => void; onRemove?: () => void; confirmRemove: string }) {
  return (
    <div className="actions">
      <button type="submit">Save</button>
      <button type="button" className="secondary" onClick={onCancel}>
        Cancel
      </button>
      {onRemove && (
        <button type="button" className="secondary danger" onClick={() => confirm(confirmRemove) && onRemove()}>
          Remove
        </button>
      )}
    </div>
  );
}

/** The short optional note on a logged entry (a measurement, a shop). */
export function NoteField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <label>
      <span>
        Note <span className="muted small">optional</span>
      </span>
      <input value={value} maxLength={200} onChange={(e) => onChange(e.target.value)} />
    </label>
  );
}

/** The result of a save, with Undo next to it while the last entry can still be taken back. */
export function MsgWithUndo({ msg, onUndo }: { msg: Msg; onUndo: (() => void) | null }) {
  return (
    <div className="row">
      <MsgLine msg={msg} />
      {onUndo && (
        <button type="button" className="link small accent" onClick={onUndo}>
          Undo
        </button>
      )}
    </div>
  );
}

export function MsgLine({ msg }: { msg: Msg }) {
  if (!msg) return null;
  return <p className={msg.kind === "error" ? "error small" : "muted small"}>{msg.text}</p>;
}

/** "today", "tomorrow", "yesterday", otherwise "Thu 23 Oct". */
export function fmtDay(day: string, ref: string = today()): string {
  if (day === ref) return "today";
  if (day === addDays(ref, 1)) return "tomorrow";
  if (day === addDays(ref, -1)) return "yesterday";
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
}

/** The full date, never "yesterday": "Saturday, November 7", for the date row over a day. */
export function fmtDayLong(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" });
}

/** An amount in the app currency ("€12.40"), or "12.40 XYZ" for a code the browser does not know. */
export function fmtMoney(n: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency }).format(n);
  } catch {
    return `${n.toFixed(2)} ${currency}`;
  }
}

export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** Empty input -> null, otherwise the number (NaN for junk, so callers can reject it). */
export const numOrNull = (s: string): number | null => (s.trim() === "" ? null : Number(s));

export function TagChips({ tags, value, onChange }: { tags: string[]; value: string | null; onChange: (t: string | null) => void }) {
  if (!tags.length) return null;
  return (
    <div className="chips">
      <button className={value === null ? "chip active" : "chip"} onClick={() => onChange(null)}>
        All
      </button>
      {tags.map((t) => (
        <button key={t} className={value === t ? "chip active" : "chip"} onClick={() => onChange(t)}>
          {t}
        </button>
      ))}
    </div>
  );
}
