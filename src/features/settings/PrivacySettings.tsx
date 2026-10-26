import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { SqlDriver } from "../../db/driver";
import { deviceId } from "../../db/settings";
import { backupFileName, saveBackupFile } from "../../platform/files";
import { failed, fmtDay, MsgLine, plural, type Msg } from "../../ui/common";
import { StatusBadge } from "../../ui/controls";
import { exportBackup, restoreBackup } from "../backup/backup";
import { ALL_SCOPES, consentStatus, CONSENT_TEXT, recordConsent, type ConsentScope } from "../chat/consent";
import { listDisclosures, type Disclosure } from "../chat/store";
import { dataInventory, type InventoryRow } from "./dataInventory";

const SCOPE_TITLE: Record<ConsentScope, string> = {
  "claude.aggregates": "Questions and summaries",
  "claude.raw_series": "Detailed records",
  "claude.notes": "Your notes",
  "claude.photos": "Photos",
};

const CLASS_WORD: Record<Disclosure["dataClass"], string> = { aggregate: "summary", raw: "detailed", note: "notes", photo: "photo" };
const SHOWN = 25;

/** What Claude may see, what it was sent, what is stored here, and the backup. */
export function PrivacySettings({ db, onChanged }: { db: SqlDriver; onChanged: () => void }) {
  const [consent, setConsent] = useState<Record<ConsentScope, boolean> | null>(null);
  const [sent, setSent] = useState<Disclosure[]>([]);
  const [inventory, setInventory] = useState<InventoryRow[]>([]);
  const [consentMsg, setConsentMsg] = useState<Msg>(null);

  const [exportPw, setExportPw] = useState("");
  const [exportPw2, setExportPw2] = useState("");
  const [restoreFile, setRestoreFile] = useState<File | null>(null);
  const [restorePw, setRestorePw] = useState("");
  const [backupMsg, setBackupMsg] = useState<Msg>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const [c, d, inv] = await Promise.all([consentStatus(db), listDisclosures(db), dataInventory(db)]);
    setConsent(c);
    setSent(d);
    setInventory(inv);
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

  async function doExport(e: FormEvent) {
    e.preventDefault();
    if (exportPw !== exportPw2) return setBackupMsg({ kind: "error", text: "The two passwords differ." });
    setBusy(true);
    try {
      const { text, rows } = await exportBackup(db, exportPw);
      await saveBackupFile(backupFileName(), text);
      const total = Object.values(rows).reduce((a, b) => a + b, 0);
      setBackupMsg({ kind: "ok", text: `Backup created (${total.toLocaleString()} rows). Keep the password: without it the file cannot be opened.` });
      setExportPw("");
      setExportPw2("");
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
      const report = await restoreBackup(db, await restoreFile.text(), restorePw);
      const total = Object.values(report.rows).reduce((a, b) => a + b, 0);
      setBackupMsg({
        kind: "ok",
        text: `Restored ${total.toLocaleString()} rows from a backup made ${new Date(report.exportedAt).toLocaleString()}. Newer data on this phone was kept.`,
      });
      setRestorePw("");
      onChanged();
      await load();
    } catch (err) {
      setBackupMsg(failed(err, "settings"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <h2>What Claude may see</h2>
      <p className="muted small">
        Health data is sensitive, so each kind needs your yes. Claude reads nothing on its own: the app answers its questions with
        what you allow here, and records every piece it sends. Change your mind any time; earlier choices are kept with their date.
      </p>
      {consent &&
        ALL_SCOPES.map((s) => (
          <div key={s} className="card">
            <label className="inline">
              <input type="checkbox" checked={consent[s]} onChange={(e) => void decide(s, e.target.checked)} />
              <strong>{SCOPE_TITLE[s]}</strong>
              {s === "claude.aggregates" && <span className="muted small">needed for any chat</span>}
            </label>
            <p className="muted small">{CONSENT_TEXT[s]}</p>
          </div>
        ))}
      <MsgLine msg={consentMsg} />

      <h2>What was sent to Claude</h2>
      {sent.length === 0 ? (
        <p className="muted small">Nothing yet.</p>
      ) : (
        <>
          <p className="muted small">
            {plural(sent.length, "piece")} of data, {(sent.reduce((n, d) => n + d.bytes, 0) / 1024).toFixed(1)} KB in all. Newest first
            {sent.length > SHOWN ? `, the last ${SHOWN} shown` : ""}.
          </p>
          <ul className="entries">
            {sent.slice(0, SHOWN).map((d) => (
              <li key={d.id}>
                <div className="grow">
                  <div className="small">{d.summary}</div>
                  <div className="muted small">
                    {new Date(d.sentAtMs).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })} · {(d.bytes / 1024).toFixed(1)} KB
                  </div>
                </div>
                <StatusBadge status={d.dataClass === "aggregate" ? "info" : "warning"}>{CLASS_WORD[d.dataClass]}</StatusBadge>
              </li>
            ))}
          </ul>
        </>
      )}

      <h2>On this phone</h2>
      <p className="muted small">
        Everything is in an encrypted database on this phone. Keys (Garmin, Claude) are in the phone's secure storage, never in the
        database or a backup. Logs keep no health values and are cleared when the app closes.
      </p>
      <table className="values">
        <tbody>
          {inventory.map((r) => (
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

      <h2>Backup</h2>
      <p className="muted small">
        An encrypted copy of everything in the local database (synced data, logs, notes, chats, your profile).
        Your notes, logs and chats exist only here, so keep a copy. Keys are not included.
      </p>
      <form onSubmit={doExport} className="stack">
        <label>
          Backup password
          <input type="password" value={exportPw} onChange={(e) => setExportPw(e.target.value)} minLength={8} required autoComplete="new-password" />
        </label>
        <label>
          Repeat password
          <input type="password" value={exportPw2} onChange={(e) => setExportPw2(e.target.value)} minLength={8} required autoComplete="new-password" />
        </label>
        <button type="submit" disabled={busy}>
          Create backup
        </button>
      </form>
      <form onSubmit={doRestore} className="stack">
        <label>
          Restore from file
          <input type="file" accept="application/json,.json" onChange={(e) => setRestoreFile(e.target.files?.[0] ?? null)} />
        </label>
        <label>
          Password
          <input type="password" value={restorePw} onChange={(e) => setRestorePw(e.target.value)} required autoComplete="off" />
        </label>
        <button type="submit" disabled={busy || !restoreFile}>
          Restore
        </button>
      </form>
      <MsgLine msg={backupMsg} />
    </div>
  );
}
