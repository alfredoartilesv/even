import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { SqlDriver } from "../../db/driver";
import { deviceFetch } from "../../platform/device";
import { failed, MsgLine, type Msg } from "../../ui/common";
import { StatusBadge } from "../../ui/controls";
import { claudeKeyVerifier } from "../chat/client";
import { CLAUDE_KEYS_URL, claudeConnection, connectClaude, CONNECT_STEPS, disconnectClaude, type ClaudeConnection } from "../chat/connect";
import { GARMIN_KEY_PAGE, GARMIN_SOURCE } from "../sync/garmin";
import { reminderEnabled, setReminderEnabled } from "../sync/reminder";
import { lastSync, type LastSync } from "../sync/runSync";
import { clearGarminKey, loadGarminKey, saveGarminKey, type SecretStore } from "./secrets";

interface Props {
  db: SqlDriver;
  secrets: SecretStore;
  isNative: boolean;
  /** Called after the Garmin key or the reminder setting change. */
  onChanged: () => void;
}

const when = (ms: number | null) => (ms ? new Date(ms).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "never");

/** Where the data comes from (Garmin, the Garmin export) and where questions go (Claude). */
export function ConnectionSettings({ db, secrets, isNative, onChanged }: Props) {
  const [key, setKey] = useState("");
  const [hasKey, setHasKey] = useState(false);
  const [remind, setRemind] = useState(true);
  const [sync, setSync] = useState<LastSync | null>(null);
  const [garminMsg, setGarminMsg] = useState<Msg>(null);

  const [claude, setClaude] = useState<ClaudeConnection | null>(null);
  const [claudeKey, setClaudeKey] = useState("");
  const [claudeMsg, setClaudeMsg] = useState<Msg>(null);
  const [checking, setChecking] = useState(false);

  const load = useCallback(async () => {
    setHasKey(Boolean(await loadGarminKey(secrets)));
    setRemind(await reminderEnabled(db));
    setSync(await lastSync(db, GARMIN_SOURCE));
    setClaude(await claudeConnection(db, secrets));
  }, [db, secrets]);

  useEffect(() => {
    void load();
  }, [load]);

  async function saveGarmin(e: FormEvent) {
    e.preventDefault();
    try {
      await saveGarminKey(secrets, key);
      setKey("");
      setHasKey(true);
      setGarminMsg({ kind: "ok", text: "Saved. Use the sync button at the top to test it." });
      onChanged();
    } catch (err) {
      setGarminMsg(failed(err, "settings"));
    }
  }

  async function forgetGarmin() {
    await clearGarminKey(secrets);
    setHasKey(false);
    setGarminMsg({ kind: "ok", text: "Garmin key removed from this phone. Data already synced stays." });
    onChanged();
  }

  async function connect(e: FormEvent) {
    e.preventDefault();
    setChecking(true);
    try {
      const res = await connectClaude(db, secrets, claudeKey, claudeKeyVerifier(deviceFetch({ connectTimeoutMs: 15_000, readTimeoutMs: 20_000 })));
      if (!res.ok) return setClaudeMsg({ kind: "error", text: res.message });
      setClaude(res.connection);
      setClaudeKey("");
      setClaudeMsg({ kind: "ok", text: "Connected. Claude accepted the key." });
    } catch (err) {
      setClaudeMsg(failed(err, "settings.claude"));
    } finally {
      setChecking(false);
    }
  }

  const garminState = !hasKey ? (
    <StatusBadge status="info">not set up</StatusBadge>
  ) : sync?.status === "error" ? (
    <StatusBadge status="warning">last sync failed</StatusBadge>
  ) : sync?.lastOkMs ? (
    <StatusBadge status="good">syncing</StatusBadge>
  ) : (
    <StatusBadge status="info">not synced yet</StatusBadge>
  );

  return (
    <div>
      <div className="row">
        <h2>Garmin</h2>
        {garminState}
      </div>
      <p className="muted small">
        Your watch data comes straight from Garmin Connect with your personal API key (read-only). Last successful sync:{" "}
        {when(sync?.lastOkMs ?? null)}
        {sync?.status === "error" && sync.error ? `. Last attempt: ${sync.error}` : ""}.
      </p>
      <form onSubmit={saveGarmin} className="stack">
        <label>
          Personal API key {hasKey && <span className="muted small">(stored; paste a new one to replace it)</span>}
          <input type="password" value={key} onChange={(e) => setKey(e.target.value)} autoComplete="off" required />
        </label>
        <div className="actions">
          <button type="submit" disabled={!key.trim()}>
            Save
          </button>
          <button type="button" className="secondary" onClick={forgetGarmin} disabled={!hasKey}>
            Forget
          </button>
        </div>
        <p className="muted small">
          Make the key in Garmin Connect on the web: Settings → Personal API Key. It is shown once and expires on the date you pick; then
          make a new one and paste it here.{" "}
          <a href={GARMIN_KEY_PAGE} target="_blank" rel="noopener noreferrer">
            Open Garmin Connect
          </a>
        </p>
        {!isNative && <p className="muted small">Browser build: the key is kept in memory only, and Garmin may block the browser's requests (CORS).</p>}
        <MsgLine msg={garminMsg} />
      </form>
      <label className="inline">
        <input
          type="checkbox"
          checked={remind}
          onChange={async (e) => {
            const on = e.target.checked;
            await setReminderEnabled(db, on);
            setRemind(on);
            onChanged(); // reschedules or cancels the notification
          }}
        />
        Notify me when Garmin has not synced for 3 days
      </label>
      <p className="muted small">
        The app syncs when it opens, when you come back to it, and with the sync button at the top. A reminder comes 3 days after the last
        successful sync{isNative ? "" : " (on the phone only)"}, usually a sign the key has expired.
      </p>

      <div className="row">
        <h2>Claude</h2>
        {claude?.status === "connected" ? (
          <StatusBadge status="good">connected</StatusBadge>
        ) : claude?.status === "needs_attention" ? (
          <StatusBadge status="warning">needs attention</StatusBadge>
        ) : (
          <StatusBadge status="info">not connected</StatusBadge>
        )}
      </div>
      {claude && claude.status !== "not_connected" ? (
        <div className="stack tight">
          <p className="small">
            Key {claude.keyHint}, checked {when(claude.verifiedAtMs)}.
          </p>
          {claude.problem && <p className="warning small">{claude.problem}</p>}
          <p className="muted small">
            The key is in the phone's secure storage and is used only to call Claude. Billing is per use, on your Claude Console account.
            What Claude may see is set under Privacy.
          </p>
          <div className="actions">
            <button
              className="secondary danger"
              onClick={async () => {
                await disconnectClaude(db, secrets);
                setClaudeMsg({ kind: "ok", text: "Disconnected. The key was removed from this phone; your chats stay." });
                await load();
              }}
            >
              Disconnect
            </button>
          </div>
        </div>
      ) : (
        <div className="stack tight">
          <p className="muted small">The chat uses your own Claude API key. Three steps:</p>
          <ol className="small">
            {CONNECT_STEPS.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ol>
          <a className="file-button" href={CLAUDE_KEYS_URL} target="_blank" rel="noopener noreferrer">
            Open the Claude Console
          </a>
        </div>
      )}
      {claude?.status !== "connected" && (
        <form onSubmit={connect} className="stack" style={{ marginTop: "0.75rem" }}>
          <label>
            {claude?.status === "needs_attention" ? "New API key" : "API key"}
            <input type="password" value={claudeKey} onChange={(e) => setClaudeKey(e.target.value)} placeholder="sk-ant-…" autoComplete="off" required />
          </label>
          <button type="submit" disabled={checking || !claudeKey.trim()}>
            {checking ? "Checking with Claude…" : "Connect"}
          </button>
        </form>
      )}
      <MsgLine msg={claudeMsg} />

      <h2>Garmin history</h2>
      <p className="muted small">
        The first Garmin sync reads the last 30 days. For your full history, request your data export in Garmin Connect (Account → Data
        Management → Export Your Data), run <code>npm run import:garmin</code> on the PC, and restore the encrypted file it writes under
        Privacy → Restore. Days the sync also has are shown once, from the sync.
      </p>
    </div>
  );
}
