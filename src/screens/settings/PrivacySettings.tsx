import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { SqlDriver } from "../../db/driver";
import { deviceId } from "../../db/settings";
import { backupFileName, saveBackupFile } from "../../platform/files";
import { failed, fmtDay, MsgLine, plural, today, timeZone, type Msg } from "../../ui/common";
import { SecretInput, StatusBadge, Switch } from "../../ui/controls";
import { localDay } from "../../core/tz";
import { exportBackup, lastBackupSaved, markBackupSaved, restoreBackup } from "../../domain/backup/backup";
import { ALL_SCOPES, consentStatus, CONSENT_TEXT, recordConsent, type ConsentScope } from "../../domain/chat/consent";
import { listDisclosures, type Disclosure } from "../../domain/chat/store";
import { dataInventory, type InventoryRow } from "../../domain/settings/dataInventory";

const SCOPE_TITLE: Record<ConsentScope, string> = {
  "claude.aggregates": "Questions and summaries",
  "claude.raw_series": "Detailed records",
  "claude.notes": "Your notes",
  "claude.photos": "Photos",
  "claude.files": "Files",
};

const CLASS_WORD: Record<Disclosure["dataClass"], string> = { aggregate: "summary", raw: "detailed", note: "notes", photo: "photo", file: "file" };
const SHOWN = 5;
/** The chat's opening snapshot names the tools it ran (domain/chat/context.ts); these say what each one is. */
const SNAPSHOT_PART: Record<string, string> = {
  list_metrics: "metric list",
  get_profile: "profile",
  list_goals: "goals",
  nutrition_summary: "today's food",
  workout_summary: "last week's workouts",
  meal_prep_stock: "meal prep stock",
};
/** A backup older than this gets a reminder: notes, logs and chats exist only on the phone. */
const STALE_DAYS = 30;

/** "Meal photos" -> "meal photos", but "Data sent to Claude" keeps Claude. */
const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);
/** Who sent it (the Chat tab or the connector, server/healthMcp.ts) and what, in plain words. */
function describe(summary: string): { via: string; what: string } {
  const connector = summary.startsWith("Connector: ");
  const what = connector ? summary.slice("Connector: ".length) : summary;
  const snapshot = /^Chat context: (.*)$/.exec(what);
  return {
    via: connector ? "Claude connector" : "Chat",
    what: snapshot
      ? `Opening snapshot: ${snapshot[1]
          .split(", ")
          .map((t) => SNAPSHOT_PART[t] ?? t.replaceAll("_", " "))
          .join(", ")}`
      : what,
  };
}
const kb = (bytes: number) => `${(bytes / 1024).toFixed(1)} KB`;
const daysAgo = (ms: number) => Math.round((Date.parse(`${today()}T00:00:00Z`) - Date.parse(`${localDay(ms, timeZone())}T00:00:00Z`)) / 86_400_000);

/** What Claude may see and was sent, what is stored on this phone, and the encrypted backup. */
/** syncAccountId: the account this device syncs with, which owns its backups (null when not connected). */
export function PrivacySettings({ db, onChanged, syncAccountId }: { db: SqlDriver; onChanged: () => void; syncAccountId: string | null }) {
  const [consent, setConsent] = useState<Record<ConsentScope, boolean> | null>(null);
  const [sent, setSent] = useState<Disclosure[]>([]);
  const [showAll, setShowAll] = useState(false);
  const [inventory, setInventory] = useState<InventoryRow[]>([]);
  const [lastBackup, setLastBackup] = useState<number | null>(null);
  const [consentMsg, setConsentMsg] = useState<Msg>(null);

  const load = useCallback(async () => {
    const [c, d, inv, b] = await Promise.all([consentStatus(db), listDisclosures(db), dataInventory(db), lastBackupSaved(db)]);
    setConsent(c);
    setSent(d);
    setInventory(inv);
    setLastBackup(b);
  }, [db]);

  useEffect(() => {
    void load();
  }, [load]);

  async function decide(scope: ConsentScope, granted: boolean) {
    try {
      await recordConsent(db, scope, granted, await deviceId(db));
      setConsent(await consentStatus(db));
      setConsentMsg({ kind: "ok", text: `${SCOPE_TITLE[scope]}: ${granted ? "allowed" : "not allowed"}. Your choice is kept with its date.` });
    } catch (err) {
      setConsentMsg(failed(err, "settings.privacy"));
    }
  }

  const stored = inventory.filter((r) => r.count > 0);
  const empty = inventory.filter((r) => r.count === 0);

  return (
    <div>
      <section className="card">
        <div className="card-head">
          <h2>What Claude may see</h2>
        </div>
        <p className="muted small">
          Claude reads nothing on its own: the app answers its questions with what you allow here and records everything it sends. Change your mind any time.
        </p>
        {consent &&
          ALL_SCOPES.map((s) => (
            <Switch
              key={s}
              checked={consent[s]}
              onChange={(on) => void decide(s, on)}
              label={SCOPE_TITLE[s]}
              note={s === "claude.aggregates" ? "needed for any chat" : undefined}
              description={CONSENT_TEXT[s]}
            />
          ))}
        <MsgLine msg={consentMsg} />
      </section>

      <section className="card">
        <div className="card-head">
          <h2>Sent to Claude</h2>
          {sent.length > 0 && <span className="muted small">{kb(sent.reduce((n, d) => n + d.bytes, 0))} in all</span>}
        </div>
        {sent.length === 0 ? (
          <p className="muted small">Nothing yet.</p>
        ) : (
          <>
            <p className="muted small">{plural(sent.length, "piece")} of data, newest first.</p>
            <ul className="entries">
              {(showAll ? sent : sent.slice(0, SHOWN)).map((d) => {
                const { via, what } = describe(d.summary);
                return (
                  <li key={d.id}>
                    <div className="grow">
                      <div className="entry-head">
                        <strong className="small">{via}</strong>
                        <StatusBadge status={d.dataClass === "aggregate" ? "info" : "warning"}>{CLASS_WORD[d.dataClass]}</StatusBadge>
                      </div>
                      <div className="small">{what}</div>
                      <div className="muted small">
                        {new Date(d.sentAtMs).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })} · {kb(d.bytes)}
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
            {sent.length > SHOWN && (
              <button type="button" className="link small accent" onClick={() => setShowAll(!showAll)}>
                {showAll ? `Show the last ${SHOWN}` : `Show all ${sent.length}`}
              </button>
            )}
          </>
        )}
      </section>

      <section className="card">
        <div className="card-head">
          <h2>On this phone</h2>
        </div>
        <p className="muted small">
          In an encrypted database, on this phone only. Keys (Garmin, Claude) are in the phone's secure storage, never in the database or a backup. Logs keep no
          health values and are cleared when the app closes.
        </p>
        {stored.length > 0 && (
          <table className="values">
            <tbody>
              {stored.map((r) => (
                <tr key={r.label}>
                  <td>
                    {r.label}
                    {r.from && r.to && (
                      <div className="muted small">
                        {fmtDay(r.from)} to {fmtDay(r.to)}
                      </div>
                    )}
                  </td>
                  <td className="num">{r.count.toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {empty.length > 0 && <p className="muted small">Nothing stored yet: {empty.map((r) => lowerFirst(r.label.replace(/ \(.*\)$/, ""))).join(", ")}.</p>}
      </section>

      <Backup db={db} syncAccountId={syncAccountId} lastBackup={lastBackup} onSaved={load} onRestored={onChanged} />
    </div>
  );
}

function Backup({
  db,
  syncAccountId,
  lastBackup,
  onSaved,
  onRestored,
}: {
  db: SqlDriver;
  syncAccountId: string | null;
  lastBackup: number | null;
  onSaved: () => Promise<void>;
  onRestored: () => void;
}) {
  const [exportPw, setExportPw] = useState("");
  const [exportPw2, setExportPw2] = useState("");
  const [restoreFile, setRestoreFile] = useState<File | null>(null);
  const [restorePw, setRestorePw] = useState("");
  const [backupMsg, setBackupMsg] = useState<Msg>(null);
  const [restoreMsg, setRestoreMsg] = useState<Msg>(null);
  const [busy, setBusy] = useState(false);

  async function doExport(e: FormEvent) {
    e.preventDefault();
    if (exportPw !== exportPw2) return setBackupMsg({ kind: "error", text: "The two passwords differ." });
    setBusy(true);
    try {
      const { text, rows } = await exportBackup(db, exportPw, { syncAccountId });
      await saveBackupFile(backupFileName(), text);
      await markBackupSaved(db);
      const total = Object.values(rows).reduce((a, b) => a + b, 0);
      setBackupMsg({ kind: "ok", text: `Backup created (${total.toLocaleString()} rows). Keep the password: without it the file cannot be opened.` });
      setExportPw("");
      setExportPw2("");
      await onSaved();
    } catch (err) {
      setBackupMsg(failed(err, "settings"));
    } finally {
      setBusy(false);
    }
  }

  async function doRestore(e: FormEvent) {
    e.preventDefault();
    if (!restoreFile) return;
    setBusy(true);
    try {
      const report = await restoreBackup(db, await restoreFile.text(), restorePw, { syncAccountId });
      const total = Object.values(report.rows).reduce((a, b) => a + b, 0);
      setRestoreMsg({
        kind: "ok",
        text: `Restored ${total.toLocaleString()} rows from a backup made ${new Date(report.exportedAt).toLocaleString()}. Newer data on this phone was kept.`,
      });
      setRestorePw("");
      setRestoreFile(null);
      onRestored();
      await onSaved();
    } catch (err) {
      setRestoreMsg(failed(err, "settings"));
    } finally {
      setBusy(false);
    }
  }

  const age = lastBackup === null ? null : daysAgo(lastBackup);

  return (
    <>
      <section className="card">
        <div className="card-head">
          <h2>Backup</h2>
          {age === null ? (
            <StatusBadge status="warning">no backup yet</StatusBadge>
          ) : age > STALE_DAYS ? (
            <StatusBadge status="warning">{age} days old</StatusBadge>
          ) : (
            <StatusBadge status="good">{age === 0 ? "today" : age === 1 ? "yesterday" : `${age} days ago`}</StatusBadge>
          )}
        </div>
        <p className="muted small">
          An encrypted copy of everything in the database: synced data, logs, notes, chats, your profile. Notes, logs and chats exist only on this phone, so
          keep a copy somewhere else. Keys are not included.
        </p>
        <form onSubmit={doExport} className="stack">
          <label>
            Backup password
            <SecretInput value={exportPw} onChange={setExportPw} minLength={8} required autoComplete="new-password" />
          </label>
          <label>
            Repeat password
            <SecretInput value={exportPw2} onChange={setExportPw2} minLength={8} required autoComplete="new-password" />
          </label>
          <button type="submit" disabled={busy}>
            Create backup
          </button>
          <MsgLine msg={backupMsg} />
        </form>
      </section>

      <section className="card">
        <div className="card-head">
          <h2>Restore</h2>
        </div>
        <p className="muted small">Merges a backup into this phone: data already here stays, nothing is duplicated, and the newer copy of a row wins.</p>
        <form onSubmit={doRestore} className="stack">
          <label className="file-button">
            <input type="file" accept="application/json,.json" onChange={(e) => setRestoreFile(e.target.files?.[0] ?? null)} disabled={busy} />
            {restoreFile ? restoreFile.name : "Choose a backup file (.json)"}
          </label>
          <label>
            Password
            <SecretInput value={restorePw} onChange={setRestorePw} required autoComplete="off" />
          </label>
          <button type="submit" className="secondary" disabled={busy || !restoreFile}>
            Restore
          </button>
          <MsgLine msg={restoreMsg} />
        </form>
      </section>
    </>
  );
}
