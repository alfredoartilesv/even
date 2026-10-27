import { useCallback, useEffect, useState, useSyncExternalStore, type FormEvent } from "react";
import type { SqlDriver } from "../../db/driver";
import { deviceFetch } from "../../platform/device";
import { failed, fmtDay, MsgLine, timeZone, type Msg } from "../../ui/common";
import { StatusBadge, Switch } from "../../ui/controls";
import { claudeKeyVerifier } from "../chat/client";
import { CLAUDE_KEYS_URL, claudeConnection, connectClaude, CONNECT_STEPS, disconnectClaude, type ClaudeConnection } from "../chat/connect";
import type { GarminImport, GarminKind } from "../import/garmin";
import { garminExportCoverage, MAX_ZIP_BYTES, storeGarminImport, type ExportCoverage } from "../import/garminImport";
import { parseGarminZip } from "../import/garminParse";
import { appleHealthSupported, requestAppleHealthAccess } from "../../platform/health";
import { APPLE_HEALTH_READ, APPLE_HEALTH_SOURCE, appleHealthEnabled, setAppleHealthEnabled } from "../sync/appleHealth";
import { GARMIN_KEY_PAGE, GARMIN_SOURCE } from "../sync/garmin";
import { reminderEnabled, setReminderEnabled } from "../sync/reminder";
import { lastSync, type LastSync } from "../sync/runSync";
import { clearGarminKey, loadGarminKey, saveGarminKey, type SecretStore } from "./secrets";

interface Props {
  db: SqlDriver;
  secrets: SecretStore;
  isNative: boolean;
  /** Called after the Garmin key, the reminder setting or the imported data change. */
  onChanged: () => void;
}

const when = (ms: number | null) => (ms ? new Date(ms).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "never");

/** One line per kind of data in the import report, in the words the owner uses. */
const KINDS: { kind: GarminKind; label: string; unit: string }[] = [
  { kind: "daily", label: "Daily summaries", unit: "day" },
  { kind: "sleep", label: "Sleep", unit: "night" },
  { kind: "activities", label: "Activities", unit: "activity" },
  { kind: "biometrics", label: "Weight", unit: "weigh-in" },
  { kind: "vo2max", label: "VO2 max", unit: "value" },
];

const count = (n: number, unit: string) => `${n.toLocaleString()} ${n === 1 ? unit : unit === "activity" ? "activities" : `${unit}s`}`;

/** Where the data comes from (Apple Health on the iPhone, the Garmin sync, the Garmin export) and where questions go (Claude). */
export function ConnectionSettings({ db, secrets, isNative, onChanged }: Props) {
  return (
    <div>
      {appleHealthSupported && <AppleHealthCard db={db} onChanged={onChanged} />}
      <GarminSync db={db} secrets={secrets} isNative={isNative} onChanged={onChanged} />
      <GarminHistory db={db} onChanged={onChanged} />
      <ClaudeConnectionCard db={db} secrets={secrets} />
    </div>
  );
}

/** Apple Health on the iPhone: read-only, nothing leaves the phone. Garmin wins for the same day (migration 0012). */
function AppleHealthCard({ db, onChanged }: { db: SqlDriver; onChanged: () => void }) {
  const [on, setOn] = useState(false);
  const [sync, setSync] = useState<LastSync | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Msg>(null);

  const load = useCallback(async () => {
    setOn(await appleHealthEnabled(db));
    setSync(await lastSync(db, APPLE_HEALTH_SOURCE));
  }, [db]);

  useEffect(() => {
    void load();
  }, [load]);

  async function connect() {
    setBusy(true);
    try {
      if (!(await requestAppleHealthAccess(APPLE_HEALTH_READ))) {
        setMsg({ kind: "error", text: "Apple Health is not available on this device." });
        return;
      }
      await setAppleHealthEnabled(db, true);
      setOn(true);
      setMsg({ kind: "ok", text: "Connected. Use the sync button at the top of the Dashboard to bring in the last 30 days." });
      onChanged();
    } catch (err) {
      setMsg(failed(err, "settings"));
    } finally {
      setBusy(false);
    }
  }

  async function disconnect() {
    await setAppleHealthEnabled(db, false);
    setOn(false);
    setMsg({ kind: "ok", text: "Disconnected. Data already synced stays." });
    onChanged();
  }

  const state = !on ? (
    <StatusBadge status="info">not connected</StatusBadge>
  ) : sync?.status === "error" ? (
    <StatusBadge status="warning">last sync failed</StatusBadge>
  ) : sync?.lastOkMs ? (
    <StatusBadge status="good">syncing</StatusBadge>
  ) : (
    <StatusBadge status="info">not synced yet</StatusBadge>
  );

  return (
    <section className="card">
      <div className="card-head">
        <h2>Apple Health</h2>
        {state}
      </div>
      <p className="muted small">
        Steps, calories, heart rate, sleep, weight and workouts from the Health app, read-only. They are read on this iPhone and stay on it. Where
        Garmin has the same day, Garmin's numbers are used. Last sync: {when(sync?.lastOkMs ?? null)}.
      </p>
      {on && sync?.warnings.length ? <p className="warning small">Not read last time: {sync.warnings.map((w) => w.split(":")[0]).join(", ")}. Allow them in the Health app.</p> : null}
      <div className="actions">
        {on ? (
          <button type="button" className="secondary" onClick={() => void disconnect()}>
            Disconnect
          </button>
        ) : (
          <button type="button" onClick={() => void connect()} disabled={busy}>
            {busy ? "Asking…" : "Connect Apple Health"}
          </button>
        )}
      </div>
      <MsgLine msg={msg} />
      <details className="more">
        <summary className="small accent">Change what Even can read</summary>
        <p className="muted small">
          iOS asks only once. After that, choose what Even reads in the Health app: tap your picture, then Apps, then Even. iOS never tells an app
          what it was refused, so a type you turned off just comes back empty.
        </p>
      </details>
    </section>
  );
}

function GarminSync({ db, secrets, isNative, onChanged }: Props) {
  const [key, setKey] = useState("");
  const [hasKey, setHasKey] = useState(false);
  const [remind, setRemind] = useState(true);
  const [sync, setSync] = useState<LastSync | null>(null);
  const [msg, setMsg] = useState<Msg>(null);

  const load = useCallback(async () => {
    setHasKey(Boolean(await loadGarminKey(secrets)));
    setRemind(await reminderEnabled(db));
    setSync(await lastSync(db, GARMIN_SOURCE));
  }, [db, secrets]);

  useEffect(() => {
    void load();
  }, [load]);

  async function save(e: FormEvent) {
    e.preventDefault();
    try {
      await saveGarminKey(secrets, key);
      setKey("");
      setHasKey(true);
      setMsg({ kind: "ok", text: "Saved. Use the sync button at the top of the Dashboard to test it." });
      onChanged();
    } catch (err) {
      setMsg(failed(err, "settings"));
    }
  }

  async function forget() {
    await clearGarminKey(secrets);
    setHasKey(false);
    setMsg({ kind: "ok", text: "Garmin key removed from this phone. Data already synced stays." });
    onChanged();
  }

  const state = !hasKey ? (
    <StatusBadge status="info">not set up</StatusBadge>
  ) : sync?.status === "error" ? (
    <StatusBadge status="warning">last sync failed</StatusBadge>
  ) : sync?.lastOkMs ? (
    <StatusBadge status="good">syncing</StatusBadge>
  ) : (
    <StatusBadge status="info">not synced yet</StatusBadge>
  );

  return (
    <section className="card">
      <div className="card-head">
        <h2>Garmin sync</h2>
        {state}
      </div>
      <p className="muted small">
        Steps, calories, sleep and workouts from Garmin Connect, read-only, with your personal API key. Last sync: {when(sync?.lastOkMs ?? null)}.
      </p>
      {sync?.status === "error" && sync.error && <p className="warning small">Last attempt: {sync.error}</p>}
      <form onSubmit={save} className="stack">
        <label>
          <span>
            Personal API key {hasKey && <span className="muted small">stored; paste a new one to replace it</span>}
          </span>
          <input type="password" value={key} onChange={(e) => setKey(e.target.value)} autoComplete="off" required />
        </label>
        <div className="actions">
          <button type="submit" disabled={!key.trim()}>
            Save key
          </button>
          {hasKey && (
            <button type="button" className="secondary" onClick={() => void forget()}>
              Forget key
            </button>
          )}
        </div>
        <MsgLine msg={msg} />
      </form>
      <details className="more">
        <summary className="small accent">Where do I get the key?</summary>
        <p className="muted small">
          In Garmin Connect on the web: Settings → Personal API Key. It is shown once and expires on the date you pick; then make a new one
          and paste it here.{" "}
          <a href={GARMIN_KEY_PAGE} target="_blank" rel="noopener noreferrer">
            Open Garmin Connect
          </a>
        </p>
        {!isNative && <p className="muted small">Browser build: the key is kept in memory only, and Garmin may block the browser's requests (CORS).</p>}
      </details>
      <Switch
        checked={remind}
        onChange={async (on) => {
          await setReminderEnabled(db, on);
          setRemind(on);
          onChanged(); // reschedules or cancels the notification
        }}
        label="Remind me when sync stops"
        description={`A notification 3 days after the last successful sync${isNative ? "" : " (on the phone only)"}, usually a sign the key has expired. The app syncs when it opens and when you come back to it.`}
      />
    </section>
  );
}

/** The Garmin export ZIP, imported on the phone: years of history the sync's first 30 days do not reach. */
/** The running import outlives the screen: leaving Connections and coming back shows where it is. */
interface ImportJob {
  busy: string | null;
  result: { written: number; report: GarminImport["report"] } | null;
  msg: Msg;
}
let job: ImportJob = { busy: null, result: null, msg: null };
const jobListeners = new Set<() => void>();
function setJob(patch: Partial<ImportJob>) {
  job = { ...job, ...patch };
  jobListeners.forEach((l) => l());
}
function subscribeJob(l: () => void) {
  jobListeners.add(l);
  return () => void jobListeners.delete(l);
}

function GarminHistory({ db, onChanged }: { db: SqlDriver; onChanged: () => void }) {
  const [coverage, setCoverage] = useState<ExportCoverage | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const { busy, result, msg } = useSyncExternalStore(subscribeJob, () => job);
  const setBusy = (b: string | null) => setJob({ busy: b });

  const load = useCallback(async () => setCoverage(await garminExportCoverage(db)), [db]);
  // Also when an import ends, even one started before this screen was opened again.
  useEffect(() => {
    if (!busy) void load();
  }, [busy, load]);

  async function run(e: FormEvent) {
    e.preventDefault();
    if (!file) return;
    setJob({ result: null, msg: null });
    try {
      if (!/\.zip$/i.test(file.name)) throw new Error("Pick the .zip file Garmin sent (not a folder or a single file from inside it).");
      if (file.size > MAX_ZIP_BYTES) throw new Error("The file is over 1 GB, too big to read on the phone. Use npm run import:garmin on a PC instead.");
      setBusy(`Reading ${(file.size / 1024 / 1024).toFixed(0)} MB…`);
      const bytes = new Uint8Array(await file.arrayBuffer());
      setBusy("Unpacking…");
      const parsed = await parseGarminZip(bytes, timeZone());
      let shown = -1;
      const written = await storeGarminImport(db, parsed, Date.now(), (saved, total) => {
        const pct = Math.floor((saved / total) * 100);
        if (pct === shown) return;
        shown = pct;
        setBusy(`Saving ${saved.toLocaleString()} of ${total.toLocaleString()} readings (${pct}%)…`);
      });
      setJob({
        result: { written, report: parsed.report },
        msg: { kind: "ok", text: `Imported ${written.toLocaleString()} readings. Importing the same file again changes nothing.` },
      });
      setFile(null);
      onChanged();
    } catch (err) {
      setJob({ msg: failed(err, "settings.import") });
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="card">
      <div className="card-head">
        <h2>Garmin history</h2>
        {/* Nothing until the count is in: a "not imported" flash would be wrong. */}
        {coverage && (coverage.readings > 0 ? <StatusBadge status="good">imported</StatusBadge> : <StatusBadge status="info">not imported</StatusBadge>)}
      </div>
      <p className="muted small">
        The sync starts with the last 30 days. For everything before, import the export Garmin emails you.{" "}
        {coverage && coverage.readings > 0 && coverage.from && coverage.to
          ? `Imported so far: ${coverage.readings.toLocaleString()} readings, ${fmtDay(coverage.from)} to ${fmtDay(coverage.to)}.`
          : ""}
      </p>
      <form onSubmit={run} className="stack">
        <label className="file-button">
          <input type="file" accept=".zip,application/zip,application/x-zip-compressed" onChange={(e) => setFile(e.target.files?.[0] ?? null)} disabled={Boolean(busy)} />
          {file ? `${file.name} (${(file.size / 1024 / 1024).toFixed(0)} MB)` : "Choose the Garmin export (.zip)"}
        </label>
        <button type="submit" disabled={!file || Boolean(busy)}>
          {busy ? "Importing…" : "Import"}
        </button>
        {busy && (
          <p className="muted small" role="status">
            {busy}
          </p>
        )}
        <MsgLine msg={msg} />
      </form>
      {result && (
        <ul className="report small" aria-label="What was imported">
          {KINDS.map(({ kind, label, unit }) => {
            const k = result.report[kind];
            return (
              <li key={kind}>
                <span>{label}</span>
                <span className="muted">
                  {k.imported ? count(k.imported, unit) : "none"}
                  {k.firstDay && k.lastDay ? `, ${fmtDay(k.firstDay)} to ${fmtDay(k.lastDay)}` : ""}
                </span>
              </li>
            );
          })}
        </ul>
      )}
      <details className="more">
        <summary className="small accent">How do I get the export?</summary>
        <ol className="small muted">
          <li>In Garmin Connect on the web: Account → Data Management → Export Your Data → Request Data Export.</li>
          <li>Garmin emails a download link, usually within a day or two.</li>
          <li>Download the ZIP on the phone and choose it above. It stays on the phone; nothing is uploaded.</li>
        </ol>
        <p className="muted small">Days the sync also has are shown once, from the sync. Weight comes from weigh-ins only, not profile settings.</p>
      </details>
    </section>
  );
}

function ClaudeConnectionCard({ db, secrets }: { db: SqlDriver; secrets: SecretStore }) {
  const [claude, setClaude] = useState<ClaudeConnection | null>(null);
  const [claudeKey, setClaudeKey] = useState("");
  const [msg, setMsg] = useState<Msg>(null);
  const [checking, setChecking] = useState(false);

  const load = useCallback(async () => setClaude(await claudeConnection(db, secrets)), [db, secrets]);
  useEffect(() => {
    void load();
  }, [load]);

  async function connect(e: FormEvent) {
    e.preventDefault();
    setChecking(true);
    try {
      const res = await connectClaude(db, secrets, claudeKey, claudeKeyVerifier(deviceFetch({ connectTimeoutMs: 15_000, readTimeoutMs: 20_000 })));
      if (!res.ok) return setMsg({ kind: "error", text: res.message });
      setClaude(res.connection);
      setClaudeKey("");
      setMsg({ kind: "ok", text: "Connected. Claude accepted the key." });
    } catch (err) {
      setMsg(failed(err, "settings.claude"));
    } finally {
      setChecking(false);
    }
  }

  return (
    <section className="card">
      <div className="card-head">
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
        <>
          <p className="muted small">
            Key {claude.keyHint}, checked {when(claude.verifiedAtMs)}. It is in the phone's secure storage and used only to call Claude; billing is per
            use, on your Claude Console account. What Claude may see is under Privacy &amp; data.
          </p>
          {claude.problem && <p className="warning small">{claude.problem}</p>}
          <div className="actions">
            <button
              className="secondary danger"
              onClick={async () => {
                await disconnectClaude(db, secrets);
                setMsg({ kind: "ok", text: "Disconnected. The key was removed from this phone; your chats stay." });
                await load();
              }}
            >
              Disconnect
            </button>
          </div>
        </>
      ) : (
        <>
          <p className="muted small">The chat uses your own Claude API key.</p>
          <details className="more">
            <summary className="small accent">How do I get a key?</summary>
            <ol className="small muted">
              {CONNECT_STEPS.map((s) => (
                <li key={s}>{s}</li>
              ))}
            </ol>
            <a className="file-button" href={CLAUDE_KEYS_URL} target="_blank" rel="noopener noreferrer">
              Open the Claude Console
            </a>
          </details>
        </>
      )}
      {claude?.status !== "connected" && (
        <form onSubmit={connect} className="stack">
          <label>
            {claude?.status === "needs_attention" ? "New API key" : "API key"}
            <input type="password" value={claudeKey} onChange={(e) => setClaudeKey(e.target.value)} placeholder="sk-ant-…" autoComplete="off" required />
          </label>
          <button type="submit" disabled={checking || !claudeKey.trim()}>
            {checking ? "Checking with Claude…" : "Connect"}
          </button>
        </form>
      )}
      <MsgLine msg={msg} />
    </section>
  );
}
