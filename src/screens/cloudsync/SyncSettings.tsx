import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { SqlDriver } from "../../db/driver";
import type { SecretStore } from "../../core/secretStore";
import type { Me } from "../../core/syncWire";
import { deviceFetch } from "../../platform/device";
import { googleSignIn, googleSignInAvailable } from "../../platform/googleSignIn";
import { failed, MsgLine, plural, type Msg } from "../../ui/common";
import { SecretInput, StatusBadge } from "../../ui/controls";
import { Icon } from "../../ui/icons";
import { pendingPush } from "../../domain/cloudsync/cloudSync";
import {
  approvePairing,
  changePassphrase,
  deleteAccount,
  disconnect,
  lookUpPairing,
  parsePairingCode,
  sessionApi,
  type SyncSession,
} from "../../domain/cloudsync/session";
import { lastCloudSync } from "../../domain/cloudsync/syncNow";
import { ConnectPanel } from "./ConnectPanel";
import { QrScanner } from "./QrScanner";

interface Props {
  db: SqlDriver;
  secrets: SecretStore;
  isNative: boolean;
  session: SyncSession | null;
  onSession: (s: SyncSession | null) => void;
  /** Sync now; resolves when done. */
  onSync: () => Promise<void>;
  version: number;
}

const when = (ms: number | null) => (ms ? new Date(ms).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "never");
const mb = (bytes: number) => `${(bytes / 1_048_576).toFixed(1)} MB`;

/** Settings > Sync & devices (docs/users.md sections 2.2 and 2.5). */
/** After leaving: on the web the browser's copy goes too (webDatabase.ts), on the phone the data stays. */
async function left(isNative: boolean, onSession: (s: SyncSession | null) => void) {
  if (!isNative) return (await import("../../platform/webDatabase")).forgetWebData();
  onSession(null);
}

export function SyncSettings({ db, secrets, isNative, session, onSession, onSync, version }: Props) {
  if (!session) {
    return (
      <section className="card">
        <div className="card-head">
          <h2>Connect to sync</h2>
          <StatusBadge status="info">not connected</StatusBadge>
        </div>
        <p className="muted small">
          Sync keeps this device's data in step with your other phones and the web app. Everything is sealed on the device first: the server stores only what it
          cannot read.
        </p>
        <ConnectPanel secrets={secrets} isNative={isNative} onConnected={onSession} />
      </section>
    );
  }
  return <Connected db={db} secrets={secrets} isNative={isNative} session={session} onSession={onSession} onSync={onSync} version={version} />;
}

function Connected({ db, secrets, isNative, session, onSession, onSync, version }: Omit<Props, "session"> & { session: SyncSession }) {
  const fetchFn = deviceFetch({ connectTimeoutMs: 15_000, readTimeoutMs: 60_000 });
  const api = sessionApi(session, fetchFn);
  const [me, setMe] = useState<Me | null>(null);
  const [last, setLast] = useState<{ at: number | null; error: string | null }>({ at: null, error: null });
  const [pending, setPending] = useState(0);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Msg>(null);

  const load = useCallback(async () => {
    setLast(await lastCloudSync(db));
    setPending(await pendingPush(db));
    try {
      setMe(await sessionApi(session, fetchFn).me());
    } catch (err) {
      setMsg(failed(err, "cloudsync"));
    }
    // fetchFn is made per render; the session is what matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [db, session]);

  useEffect(() => {
    void load();
  }, [load, version]);

  /** The app's sync keeps a cloud failure for this screen rather than throwing, so "Synced." would show over the error. */
  async function syncOrThrow() {
    await onSync();
    const { error } = await lastCloudSync(db);
    if (error) throw new Error(error);
  }

  async function act(fn: () => Promise<unknown>, ok: string) {
    setBusy(true);
    setMsg(null);
    try {
      await fn();
      setMsg({ kind: "ok", text: ok });
      await load();
    } catch (err) {
      setMsg(failed(err, "cloudsync"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <section className="card">
        <div className="card-head">
          <h2>Sync</h2>
          {last.error ? <StatusBadge status="warning">last sync failed</StatusBadge> : <StatusBadge status="good">connected</StatusBadge>}
        </div>
        <p className="muted small">
          {me ? `${me.account.displayName} · ${me.account.email}` : session.email}. Last sync: {when(last.at)}.
          {pending > 0 && ` ${plural(pending, "change")} waiting to go up.`}
          {me && ` Server space: ${mb(me.usage.bytes)} of ${mb(me.usage.quotaBytes)}.`}
        </p>
        {last.error && <p className="warning small">{last.error}</p>}
        <div className="actions">
          <button type="button" disabled={busy} onClick={() => void act(syncOrThrow, "Synced.")}>
            {busy ? "Working…" : "Sync now"}
          </button>
        </div>
        <MsgLine msg={msg} />
      </section>

      <Devices me={me} busy={busy} onRemove={(id, name) => void act(() => api.revokeDevice(id), `${name} removed. It cannot sync any more.`)} />
      <GoogleLink
        linked={me?.account.googleLinked ?? null}
        busy={busy}
        onLink={() =>
          void act(async () => {
            const token = await googleSignIn();
            if (!token) throw new Error("Google sign-in was cancelled.");
            await api.linkGoogle(token);
          }, "Google is linked to your Even account.")
        }
      />
      <AddDevice session={session} fetchFn={fetchFn} onAdded={load} />
      <Passphrase session={session} fetchFn={fetchFn} />

      <section className="card">
        <h2>Leave or delete</h2>
        <p className="muted small">
          {isNative
            ? "Disconnecting keeps this phone's data and stops syncing it."
            : "Disconnecting removes this browser's copy of your data; your phone and the server keep theirs."}{" "}
          Deleting the account removes everything the server holds for it.
        </p>
        <div className="actions">
          <button
            type="button"
            className="secondary"
            disabled={busy}
            onClick={() => void disconnect(secrets, session, { fetchFn }).then(() => left(isNative, onSession))}
          >
            Disconnect this device
          </button>
        </div>
        <DeleteAccount
          email={session.email}
          onDelete={async () => {
            await deleteAccount(secrets, session, { fetchFn });
            await left(isNative, onSession);
          }}
        />
      </section>
    </>
  );
}

function Devices({ me, busy, onRemove }: { me: Me | null; busy: boolean; onRemove: (id: string, name: string) => void }) {
  if (!me) return null;
  return (
    <section className="card">
      <h2>Devices</h2>
      <ul className="device-list">
        {me.devices.map((d) => (
          <li key={d.id} className="row">
            <span className="grow">
              <strong>{d.name}</strong>
              {d.current && <span className="muted small"> (this one)</span>}
              <br />
              <span className="muted small">
                {d.kind}, added by {d.addedBy} on {new Date(d.createdAt).toLocaleDateString()} · last seen {when(d.lastSeenAt)}
              </span>
            </span>
            {!d.current && (
              <button type="button" className="secondary" disabled={busy} onClick={() => onRemove(d.id, d.name)}>
                Remove
              </button>
            )}
          </li>
        ))}
      </ul>
      <p className="muted small">Remove a lost or stolen device at once: its token stops working on the next request.</p>
    </section>
  );
}

/** Who asked to join, looked up from the code before anything is sent: the owner approves a name, not a code. */
interface Asking {
  code: string;
  deviceName: string;
  deviceKind: string;
}

function AddDevice({ session, fetchFn, onAdded }: { session: SyncSession; fetchFn: typeof fetch | undefined; onAdded: () => Promise<void> }) {
  const [code, setCode] = useState("");
  const [scanning, setScanning] = useState(false);
  const [asking, setAsking] = useState<Asking | null>(null);
  const [msg, setMsg] = useState<Msg>(null);
  const [busy, setBusy] = useState(false);

  async function lookUp(c: string) {
    setBusy(true);
    setMsg(null);
    try {
      setAsking({ code: c, ...(await lookUpPairing(session, c, { fetchFn })) });
    } catch (err) {
      setMsg(failed(err, "cloudsync"));
    } finally {
      setBusy(false);
    }
  }

  function scanned(text: string): boolean {
    if (!parsePairingCode(text)) return false;
    setScanning(false);
    void lookUp(text);
    return true;
  }

  async function approve(a: Asking) {
    setBusy(true);
    try {
      const { deviceName } = await approvePairing(session, a.code, { fetchFn });
      setMsg({ kind: "ok", text: `${deviceName} is connected. It is downloading your data now.` });
      setAsking(null);
      setCode("");
      await onAdded();
    } catch (err) {
      setAsking(null);
      setMsg(failed(err, "cloudsync"));
    } finally {
      setBusy(false);
    }
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    void lookUp(code);
  }

  return (
    <section className="card">
      <h2>Add a device</h2>
      {asking ? (
        <div className="stack" aria-live="polite">
          <p>
            <b>{asking.deviceName}</b> wants to join your account.
          </p>
          <p className="muted small">
            It gets your keys and can read all your data. Approve only if that {asking.deviceKind === "phone" ? "phone" : "browser"} is in front of you and you
            just asked it to pair.
          </p>
          <div className="row">
            <button type="button" className="grow" disabled={busy} onClick={() => void approve(asking)}>
              {busy ? "Sending your keys…" : "Approve"}
            </button>
            <button type="button" className="secondary grow" disabled={busy} onClick={() => setAsking(null)}>
              Not this one
            </button>
          </div>
        </div>
      ) : scanning ? (
        <QrScanner accept={scanned} onCancel={() => setScanning(false)} hint="Point the camera at the QR code on the new phone or browser." />
      ) : (
        <div className="stack">
          <p className="muted small">On the new phone or browser choose Pair: it shows a QR code. Scan it here, or type the code under it.</p>
          <button type="button" className="with-icon" disabled={busy} onClick={() => (setMsg(null), setScanning(true))}>
            <Icon name="qr" size={20} />
            Scan the QR code
          </button>
          <details className="more">
            <summary className="small accent">Type the code instead</summary>
            <form onSubmit={submit} className="stack">
              <label>
                Pairing code
                <input
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  placeholder="ABC234-XYZ567"
                  autoCapitalize="characters"
                  autoComplete="off"
                  spellCheck={false}
                  required
                />
              </label>
              <button type="submit" disabled={busy || !parsePairingCode(code)}>
                {busy ? "Checking the code…" : "Continue"}
              </button>
            </form>
          </details>
        </div>
      )}
      <MsgLine msg={msg} />
    </section>
  );
}

function Passphrase({ session, fetchFn }: { session: SyncSession; fetchFn: typeof fetch | undefined }) {
  const [next, setNext] = useState("");
  const [msg, setMsg] = useState<Msg>(null);
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await changePassphrase(session, next, { fetchFn });
      setNext("");
      setMsg({ kind: "ok", text: "The new passphrase works from now on; the old one does not." });
    } catch (err) {
      setMsg(failed(err, "cloudsync"));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="card">
      <details className="more">
        <summary className="small accent">Change the recovery passphrase</summary>
        <form onSubmit={submit} className="stack">
          <label>
            New passphrase
            <SecretInput value={next} onChange={setNext} noun="passphrase" autoComplete="new-password" required />
          </label>
          <button type="submit" disabled={busy || !next}>
            {busy ? "Sealing…" : "Change passphrase"}
          </button>
        </form>
        <MsgLine msg={msg} />
      </details>
    </section>
  );
}

function DeleteAccount({ email, onDelete }: { email: string; onDelete: () => Promise<void> }) {
  const [typed, setTyped] = useState("");
  const [msg, setMsg] = useState<Msg>(null);
  return (
    <details className="more">
      <summary className="small accent">Delete the account</summary>
      <div className="stack">
        <label>
          Type {email} to confirm
          <input value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" />
        </label>
        <button
          type="button"
          className="danger"
          disabled={typed.trim().toLowerCase() !== email}
          onClick={() => void onDelete().catch((err: unknown) => setMsg(failed(err, "cloudsync")))}
        >
          Delete everything on the server
        </button>
        <MsgLine msg={msg} />
      </div>
    </details>
  );
}

/** A Google account linked to the Even account: a way back in later, never what opens the data (the passphrase or a pairing does). */
function GoogleLink({ linked, busy, onLink }: { linked: boolean | null; busy: boolean; onLink: () => void }) {
  if (linked === null) return null;
  return (
    <section className="card">
      <div className="card-head">
        <h2>Google</h2>
        <StatusBadge status={linked ? "good" : "info"}>{linked ? "linked" : "not linked"}</StatusBadge>
      </div>
      <p className="muted small">
        Optional. Linking your Google account to this Even account lets you sign in with Google later. Your data still opens only with your passphrase or a
        pairing, and Google sees nothing of it.
      </p>
      {!linked &&
        (googleSignInAvailable ? (
          <div className="actions">
            <button type="button" disabled={busy} onClick={onLink}>
              Link Google
            </button>
          </div>
        ) : (
          <p className="muted small">Linking is available in the phone app built with a Google client id.</p>
        ))}
    </section>
  );
}
