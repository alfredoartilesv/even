import { useEffect, useState, type FormEvent } from "react";
import { exportBackup, restoreBackup } from "../backup/backup";
import { backupFileName, saveBackupFile } from "../backup/files";
import type { SqlDriver } from "../db/driver";
import { setSetting } from "../db/settings";
import { clearFreddyCredentials, loadFreddyCredentials, saveFreddyCredentials, type SecretStore } from "../settings/secrets";
import { loadTransport, TRANSPORT_KEY, type Transport } from "../sync/freddyClient";

interface Props {
  db: SqlDriver;
  secrets: SecretStore;
  isNative: boolean;
  /** Called after credentials or transport change, and after a restore. */
  onChanged: () => void;
}

type Msg = { kind: "ok" | "error"; text: string } | null;

export function SettingsScreen({ db, secrets, isNative, onChanged }: Props) {
  const [url, setUrl] = useState("");
  const [key, setKey] = useState("");
  const [hasKey, setHasKey] = useState(false);
  const [transport, setTransport] = useState<Transport>("native");
  const [freddyMsg, setFreddyMsg] = useState<Msg>(null);

  const [exportPw, setExportPw] = useState("");
  const [exportPw2, setExportPw2] = useState("");
  const [restoreFile, setRestoreFile] = useState<File | null>(null);
  const [restorePw, setRestorePw] = useState("");
  const [backupMsg, setBackupMsg] = useState<Msg>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void (async () => {
      const creds = await loadFreddyCredentials(secrets);
      setUrl(creds?.url ?? "");
      setHasKey(Boolean(creds?.apiKey));
      setTransport(await loadTransport(db, isNative));
    })();
  }, [db, secrets, isNative]);

  async function saveFreddy(e: FormEvent) {
    e.preventDefault();
    try {
      // An empty key field keeps the stored key, so it never has to be shown again.
      const stored = await loadFreddyCredentials(secrets);
      await saveFreddyCredentials(secrets, url, key || (stored?.apiKey ?? ""));
      await setSetting(db, TRANSPORT_KEY, transport);
      setKey("");
      setHasKey(Boolean(key || stored?.apiKey));
      setFreddyMsg({ kind: "ok", text: "Saved." });
      onChanged();
    } catch (err) {
      setFreddyMsg({ kind: "error", text: (err as Error).message });
    }
  }

  async function forgetFreddy() {
    await clearFreddyCredentials(secrets);
    setUrl("");
    setHasKey(false);
    setFreddyMsg({ kind: "ok", text: "freddy URL and key removed from this phone." });
    onChanged();
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
      setBackupMsg({ kind: "error", text: (err as Error).message });
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
    } catch (err) {
      setBackupMsg({ kind: "error", text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section>
      <h2>freddy</h2>
      <form onSubmit={saveFreddy} className="stack">
        <label>
          MCP URL
          <input type="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…" autoComplete="off" required />
        </label>
        <label>
          MCP key {hasKey && <span className="muted small">(stored, leave empty to keep it)</span>}
          <input type="password" value={key} onChange={(e) => setKey(e.target.value)} autoComplete="off" />
        </label>
        <label>
          Connection
          <select value={transport} onChange={(e) => setTransport(e.target.value as Transport)}>
            <option value="native" disabled={!isNative}>
              Native HTTP (recommended on the phone)
            </option>
            <option value="fetch">WebView fetch (needs freddy CORS)</option>
          </select>
        </label>
        <div className="row">
          <button type="submit">Save</button>
          <button type="button" className="secondary" onClick={forgetFreddy}>
            Forget
          </button>
        </div>
        {!isNative && <p className="muted small">Browser build: the URL and key are kept in memory only and forgotten on reload.</p>}
        {freddyMsg && <p className={freddyMsg.kind === "ok" ? "muted small" : "error small"}>{freddyMsg.text}</p>}
      </form>

      <h2>Backup</h2>
      <p className="muted small">
        An encrypted copy of everything in the local database (synced data, logs, notes, chats). On the free plan
        freddy keeps only 7 days, so this file is the only copy of anything older. The freddy key is not included.
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
      {backupMsg && <p className={backupMsg.kind === "ok" ? "muted small" : "error small"}>{backupMsg.text}</p>}
    </section>
  );
}
