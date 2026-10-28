import { useEffect, useState, type FormEvent } from "react";
import type { SecretStore } from "../../../core/secretStore";
import { deviceFetch, platformName } from "../../../platform/device";
import { failed, MsgLine, type Msg } from "../../../ui/common";
import { SecretInput } from "../../../ui/controls";
import { Segmented } from "../../../ui/layout";
import { MIN_PASSPHRASE } from "../keys";
import { createAccount, signInWithPassphrase, startPairing, type PairingRequest, type SyncSession } from "../session";

type Mode = "signin" | "pair" | "create";

interface Props {
  secrets: SecretStore;
  isNative: boolean;
  onConnected: (s: SyncSession) => void;
}

/** Where the sync server is: the same origin on the web (Vercel, or the dev server's proxy); typed on the phone. */
export const DEFAULT_SERVER = (import.meta.env?.VITE_SYNC_URL as string | undefined)?.trim() ?? "";

const thisDevice = (isNative: boolean) =>
  ({ name: isNative ? (platformName === "ios" ? "iPhone" : "Android phone") : browserName(), kind: isNative ? "phone" : "web" }) as const;

function browserName(): string {
  const ua = navigator.userAgent;
  const b = /Edg\//.test(ua) ? "Edge" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "Browser";
  const os = /Windows/.test(ua)
    ? "Windows"
    : /Mac OS/.test(ua)
      ? "Mac"
      : /Android/.test(ua)
        ? "Android"
        : /Linux/.test(ua)
          ? "Linux"
          : /iPhone|iPad/.test(ua)
            ? "iOS"
            : "";
  return os ? `${b} on ${os}` : b;
}

/**
 * Joining the sync account (docs/users.md section 2): sign in with email and passphrase, pair with a
 * device that is already connected, or make the account with an invite. Used by Settings > Sync on
 * the phone and as the first screen of the web app.
 */
export function ConnectPanel({ secrets, isNative, onConnected }: Props) {
  const [mode, setMode] = useState<Mode>("signin");
  const [server, setServer] = useState(DEFAULT_SERVER);
  const fetchFn = deviceFetch({ connectTimeoutMs: 15_000, readTimeoutMs: 60_000 });
  const device = thisDevice(isNative);
  return (
    <div className="stack">
      <Segmented
        label="How to connect"
        value={mode}
        onChange={setMode}
        items={[
          { id: "signin", label: "Sign in" },
          { id: "pair", label: "Pair" },
          { id: "create", label: "New account" },
        ]}
      />
      {isNative && (
        <label>
          Sync server
          <input value={server} onChange={(e) => setServer(e.target.value)} placeholder="https://your-even.vercel.app" inputMode="url" autoCapitalize="off" />
        </label>
      )}
      {mode === "signin" ? (
        <SignIn server={server} secrets={secrets} device={device} fetchFn={fetchFn} onConnected={onConnected} />
      ) : mode === "pair" ? (
        <Pair server={server} secrets={secrets} device={device} fetchFn={fetchFn} onConnected={onConnected} />
      ) : (
        <Create server={server} secrets={secrets} device={device} fetchFn={fetchFn} onConnected={onConnected} />
      )}
    </div>
  );
}

interface FlowProps {
  server: string;
  secrets: SecretStore;
  device: { name: string; kind: "phone" | "web" };
  fetchFn: typeof fetch | undefined;
  onConnected: (s: SyncSession) => void;
}

function useSubmit(run: () => Promise<SyncSession>, onConnected: (s: SyncSession) => void) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Msg>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    try {
      onConnected(await run());
    } catch (err) {
      setMsg(failed(err, "cloudsync"));
    } finally {
      setBusy(false);
    }
  };
  return { busy, msg, submit };
}

function SignIn({ server, secrets, device, fetchFn, onConnected }: FlowProps) {
  const [email, setEmail] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const { busy, msg, submit } = useSubmit(() => signInWithPassphrase(server, secrets, { email, passphrase, device }, { fetchFn }), onConnected);
  return (
    <form onSubmit={submit} className="stack">
      <p className="muted small">Your account's email and recovery passphrase. Works without your phone at hand.</p>
      <label>
        Email
        <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" required />
      </label>
      <label>
        Recovery passphrase
        <SecretInput value={passphrase} onChange={setPassphrase} noun="passphrase" autoComplete="current-password" required />
      </label>
      <button type="submit" disabled={busy || !email || !passphrase}>
        {busy ? "Opening your keys…" : "Sign in"}
      </button>
      <MsgLine msg={msg} />
    </form>
  );
}

function Pair({ server, secrets, device, fetchFn, onConnected }: FlowProps) {
  const [req, setReq] = useState<PairingRequest | null>(null);
  const [msg, setMsg] = useState<Msg>(null);
  const [stop] = useState(() => new AbortController());
  useEffect(() => () => stop.abort(), [stop]);

  async function begin() {
    setMsg(null);
    try {
      const r = await startPairing(server, secrets, device, { fetchFn, signal: stop.signal });
      setReq(r);
      r.done.then(onConnected, (err) => {
        setReq(null);
        if (!stop.signal.aborted) setMsg(failed(err, "cloudsync"));
      });
    } catch (err) {
      setMsg(failed(err, "cloudsync"));
    }
  }

  return (
    <div className="stack">
      <p className="muted small">
        Use a phone or browser that is already connected: there, open Settings, then Sync, then Add a device, and type the code shown here. Your keys go
        straight to this device, sealed; the server cannot read them.
      </p>
      {req ? (
        <>
          <p className="pairing-code" aria-label="Pairing code">
            {req.code}
          </p>
          <p className="muted small">Waiting for the other device… The code works for 5 minutes, once.</p>
        </>
      ) : (
        <button type="button" onClick={() => void begin()}>
          Show a pairing code
        </button>
      )}
      <MsgLine msg={msg} />
    </div>
  );
}

function Create({ server, secrets, device, fetchFn, onConnected }: FlowProps) {
  const [invite, setInvite] = useState("");
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [again, setAgain] = useState("");
  const mismatch = again.length > 0 && again !== passphrase;
  const { busy, msg, submit } = useSubmit(
    () => createAccount(server, secrets, { inviteCode: invite, email, displayName: name, passphrase, device }, { fetchFn }),
    onConnected,
  );
  return (
    <form onSubmit={submit} className="stack">
      <p className="muted small">
        Even is invite-only. Your data is sealed on your devices before it leaves them; the passphrase opens it on a new device, and nobody can reset it for
        you. Write it down.
      </p>
      <label>
        Invite code
        <input value={invite} onChange={(e) => setInvite(e.target.value)} autoCapitalize="characters" autoComplete="off" required />
      </label>
      <label>
        Email (the one the invite is for)
        <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" required />
      </label>
      <label>
        Your name, as friends see it
        <input value={name} onChange={(e) => setName(e.target.value)} autoComplete="nickname" maxLength={60} required />
      </label>
      <label>
        Recovery passphrase (at least {MIN_PASSPHRASE} characters)
        <SecretInput value={passphrase} onChange={setPassphrase} noun="passphrase" autoComplete="new-password" required />
      </label>
      <label>
        The passphrase again
        <SecretInput value={again} onChange={setAgain} noun="passphrase" autoComplete="new-password" required />
      </label>
      {mismatch && <p className="error small">The two passphrases are different.</p>}
      <button type="submit" disabled={busy || mismatch || !invite || !email || !name || passphrase.length < MIN_PASSPHRASE || again !== passphrase}>
        {busy ? "Making your keys…" : "Create the account"}
      </button>
      <MsgLine msg={msg} />
    </form>
  );
}
