import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { SqlDriver } from "../../db/driver";
import { setSetting } from "../../db/settings";
import { deviceFetch } from "../../platform/device";
import { failed, MsgLine, type Msg } from "../../ui/common";
import { StatusBadge } from "../../ui/controls";
import { claudeKeyVerifier } from "../chat/client";
import { CLAUDE_KEYS_URL, claudeConnection, connectClaude, CONNECT_STEPS, disconnectClaude, type ClaudeConnection } from "../chat/connect";
import { loadTransport, TRANSPORT_KEY, type Transport } from "../sync/freddyClient";
import { reminderEnabled, setReminderEnabled } from "../sync/reminder";
import { lastSync, type LastSync } from "../sync/runSync";
import { clearFreddyCredentials, loadFreddyCredentials, saveFreddyCredentials, type SecretStore } from "./secrets";

interface Props {
  db: SqlDriver;
  secrets: SecretStore;
  isNative: boolean;
  /** Called after credentials or transport change. */
  onChanged: () => void;
}

const when = (ms: number | null) => (ms ? new Date(ms).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "never");

/** Where the data comes from (freddy, the Garmin export) and where questions go (Claude). */
export function ConnectionSettings({ db, secrets, isNative, onChanged }: Props) {
  const [url, setUrl] = useState("");
  const [key, setKey] = useState("");
  const [hasKey, setHasKey] = useState(false);
  const [transport, setTransport] = useState<Transport>("native");
  const [remind, setRemind] = useState(true);
  const [sync, setSync] = useState<LastSync | null>(null);
  const [freddyMsg, setFreddyMsg] = useState<Msg>(null);

  const [claude, setClaude] = useState<ClaudeConnection | null>(null);
  const [claudeKey, setClaudeKey] = useState("");
  const [claudeMsg, setClaudeMsg] = useState<Msg>(null);
  const [checking, setChecking] = useState(false);

  const load = useCallback(async () => {
    const creds = await loadFreddyCredentials(secrets);
    setUrl(creds?.url ?? "");
    setHasKey(Boolean(creds?.apiKey));
    setTransport(await loadTransport(db, isNative));
    setRemind(await reminderEnabled(db));
    setSync(await lastSync(db, "freddy"));
    setClaude(await claudeConnection(db, secrets));
  }, [db, secrets, isNative]);

  useEffect(() => {
    void load();
  }, [load]);

  async function saveFreddy(e: FormEvent) {
    e.preventDefault();
    try {
      // An empty key field keeps the stored key, so it never has to be shown again.
      const stored = await loadFreddyCredentials(secrets);
      await saveFreddyCredentials(secrets, url, key || (stored?.apiKey ?? ""));
      await setSetting(db, TRANSPORT_KEY, transport);
      setKey("");
      setHasKey(Boolean(key || stored?.apiKey));
      setFreddyMsg({ kind: "ok", text: "Saved. Use the sync button at the top to test it." });
      onChanged();
    } catch (err) {
      setFreddyMsg(failed(err, "settings"));
    }
  }

  async function forgetFreddy() {
    await clearFreddyCredentials(secrets);
    setUrl("");
    setHasKey(false);
    setFreddyMsg({ kind: "ok", text: "freddy URL and key removed from this phone." });
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

  const freddyState = !hasKey ? (
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
        <h2>freddy</h2>
        {freddyState}
      </div>
      <p className="muted small">
        Your wearable data (Garmin and others) arrives through freddy. Last successful sync: {when(sync?.lastOkMs ?? null)}
        {sync?.status === "error" && sync.error ? `. Last attempt: ${sync.error}` : ""}.
      </p>
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
        <div className="actions">
          <button type="submit">Save</button>
          <button type="button" className="secondary" onClick={forgetFreddy} disabled={!hasKey && !url}>
            Forget
          </button>
        </div>
        {!isNative && <p className="muted small">Browser build: the URL and key are kept in memory only and forgotten on reload.</p>}
        <MsgLine msg={freddyMsg} />
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
        Notify me when freddy has not synced for 3 days
      </label>
      <p className="muted small">
        The app syncs when it opens, when you come back to it, and with the sync button at the top. On the free plan freddy keeps only 7
        days, so a reminder comes 3 days after the last successful sync{isNative ? "" : " (on the phone only)"}.
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
        freddy's free plan reaches back 7 days. For your full Garmin history, request your data export in Garmin Connect (Account → Data
        Management → Export Your Data), run <code>npm run import:garmin</code> on the PC, and restore the encrypted file it writes under
        Privacy → Restore. Days freddy also has are shown once, from freddy.
      </p>
    </div>
  );
}
