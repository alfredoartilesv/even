import { useEffect, useRef, useState, type FormEvent } from "react";
import type { SecretStore } from "../../core/secretStore";
import { deviceFetch, platformName } from "../../platform/device";
import { keepNothing } from "../../platform/idb";
import { failed, MsgLine, type Msg } from "../../ui/common";
import { SecretInput, Switch } from "../../ui/controls";
import { Segmented } from "../../ui/layout";
import { checkPassphrase, passphraseHint } from "../../domain/cloudsync/keys";
import { createAccount, signInWithPassphrase, startPairing, type PairingRequest, type SyncSession } from "../../domain/cloudsync/session";

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

// One line under the chooser, so a first-time owner knows which way is theirs before reading a form.
const MODE_HINT: Record<Mode, string> = {
  signin: "You already have an account: your email and recovery passphrase open it here.",
  pair: "A phone or browser of yours is already connected and at hand: approve this one from it, no passphrase needed.",
  create: "First time here: you have an invite code and want to start your account.",
};

/**
 * Joining the sync account (docs/users.md section 2): sign in with email and passphrase, pair with a
 * device that is already connected, or make the account with an invite. Used by Settings > Sync on
 * the phone and as the first screen of the web app.
 */
export function ConnectPanel({ secrets, isNative, onConnected }: Props) {
  const [mode, setMode] = useState<Mode>("signin");
  const [server, setServer] = useState(DEFAULT_SERVER);
  const [shared, setShared] = useState(false);
  const fetchFn = deviceFetch({ connectTimeoutMs: 15_000, readTimeoutMs: 60_000 });
  const plain = thisDevice(isNative);
  const device = shared ? { ...plain, name: `${plain.name} (shared)` } : plain;
  // Chosen before anything is stored: the session and the data then stay in this tab's memory.
  const before = () => shared && keepNothing();
  const flow = { server, secrets, device, fetchFn, before, onConnected, onMode: setMode };
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
      <p className="muted small">{MODE_HINT[mode]}</p>
      {isNative && (
        <label>
          Sync server
          <input value={server} onChange={(e) => setServer(e.target.value)} placeholder="https://your-even.vercel.app" inputMode="url" autoCapitalize="off" />
        </label>
      )}
      {!isNative && (
        <Switch
          checked={shared}
          onChange={setShared}
          label="This is a shared computer"
          description="Keep nothing in this browser: closing or reloading the tab signs out and forgets the data."
        />
      )}
      {mode === "signin" ? <SignIn {...flow} /> : mode === "pair" ? <Pair {...flow} /> : <Create {...flow} />}
    </div>
  );
}

interface FlowProps {
  server: string;
  secrets: SecretStore;
  device: { name: string; kind: "phone" | "web" };
  fetchFn: typeof fetch | undefined;
  /** Runs before a flow stores anything (the shared-computer choice). */
  before: () => void;
  onConnected: (s: SyncSession) => void;
  /** Sends the owner to another way in, from a hint inside a flow. */
  onMode: (m: Mode) => void;
}

function useSubmit(run: () => Promise<SyncSession>, onConnected: (s: SyncSession) => void, before: () => void) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Msg>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    try {
      before();
      onConnected(await run());
    } catch (err) {
      setMsg(failed(err, "cloudsync"));
    } finally {
      setBusy(false);
    }
  };
  return { busy, msg, submit };
}

/** A link-styled button inside a hint line, to switch to another way in. */
function ModeLink({ to, onMode, children }: { to: Mode; onMode: (m: Mode) => void; children: string }) {
  return (
    <button type="button" className="link accent" onClick={() => onMode(to)}>
      {children}
    </button>
  );
}

function SignIn({ server, secrets, device, fetchFn, before, onConnected, onMode }: FlowProps) {
  const [email, setEmail] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const { busy, msg, submit } = useSubmit(() => signInWithPassphrase(server, secrets, { email, passphrase, device }, { fetchFn }), onConnected, before);
  return (
    <form onSubmit={submit} className="stack">
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
      <p className="muted small">
        Forgot the passphrase? Nobody can reset it, but a connected phone can still let you in:{" "}
        <ModeLink to="pair" onMode={onMode}>
          pair instead
        </ModeLink>
        , then set a new one in Settings, Sync &amp; devices. No account yet?{" "}
        <ModeLink to="create" onMode={onMode}>
          Use your invite
        </ModeLink>
        .
      </p>
    </form>
  );
}

/** "4:59" until the code expires, ticking each second while it is shown. */
function useCountdown(until: number | null): string | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (until === null) return;
    const t = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(t);
  }, [until]);
  if (until === null) return null;
  const s = Math.max(0, Math.round((until - now) / 1_000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function Pair({ server, secrets, device, fetchFn, before, onConnected }: FlowProps) {
  const [req, setReq] = useState<PairingRequest | null>(null);
  const [asking, setAsking] = useState(false);
  const [copied, setCopied] = useState(false);
  const [msg, setMsg] = useState<Msg>(null);
  // Made per code, not once per mount: React's development double mount runs the unmount cleanup
  // straight away, which aborted a controller kept in state before the first code was even asked for.
  const stop = useRef<AbortController | null>(null);
  useEffect(() => () => stop.current?.abort(), []);
  const left = useCountdown(req?.expiresAt ?? null);

  async function begin() {
    stop.current?.abort();
    const ctl = new AbortController();
    stop.current = ctl;
    setMsg(null);
    setCopied(false);
    setAsking(true);
    try {
      before();
      const r = await startPairing(server, secrets, device, { fetchFn, signal: ctl.signal });
      setReq(r);
      r.done.then(onConnected, (err) => {
        if (ctl.signal.aborted) return;
        setReq(null);
        setMsg(failed(err, "cloudsync"));
      });
    } catch (err) {
      setMsg(failed(err, "cloudsync"));
    } finally {
      setAsking(false);
    }
  }

  function cancel() {
    stop.current?.abort();
    setReq(null);
  }

  async function copy(code: string) {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  if (!req) {
    return (
      <div className="stack">
        <ol className="steps small">
          <li>Get a code here.</li>
          <li>
            On the device that is already connected, open Settings, then <b>Sync &amp; devices</b>, and type the code under <b>Add a device</b>.
          </li>
          <li>Approve there. This screen opens by itself.</li>
        </ol>
        <button type="button" onClick={() => void begin()} disabled={asking}>
          {asking ? "Getting a code…" : msg ? "Get a new code" : "Get a pairing code"}
        </button>
        <MsgLine msg={msg} />
      </div>
    );
  }
  return (
    <div className="stack" aria-live="polite">
      <p className="pairing-code" aria-label={`Pairing code ${req.code.split("").join(" ")}`}>
        {req.code}
      </p>
      <div className="row">
        <button type="button" className="grow" onClick={() => void copy(req.code)}>
          {copied ? "Copied" : "Copy the code"}
        </button>
        <button type="button" className="secondary grow" onClick={cancel}>
          Cancel
        </button>
      </div>
      <p className="muted small">
        Type it on your connected device: Settings, then <b>Sync &amp; devices</b>, then <b>Add a device</b>. Waiting for the approval… The code works once, for{" "}
        {left ?? "5:00"} more. Your keys come straight to this device, sealed; the server cannot read them.
      </p>
    </div>
  );
}

function Create({ server, secrets, device, fetchFn, before, onConnected, onMode }: FlowProps) {
  const [invite, setInvite] = useState("");
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [again, setAgain] = useState("");
  const [saved, setSaved] = useState(false);
  const hint = passphraseHint(passphrase, again, saved);
  const ready = invite.trim() && email.trim() && name.trim() && !checkPassphrase(passphrase) && again === passphrase && saved;
  const { busy, msg, submit } = useSubmit(
    () => createAccount(server, secrets, { inviteCode: invite.trim(), email: email.trim(), displayName: name.trim(), passphrase, device }, { fetchFn }),
    onConnected,
    before,
  );
  return (
    <form onSubmit={submit} className="stack">
      <label>
        Invite code
        <input
          value={invite}
          onChange={(e) => setInvite(e.target.value.toUpperCase())}
          placeholder="ABCD234XYZ"
          autoCapitalize="characters"
          autoComplete="off"
          spellCheck={false}
          required
        />
      </label>
      <label>
        Email
        <span className="muted small block">The address the invite was made for.</span>
        <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" required />
      </label>
      <label>
        Your name
        <span className="muted small block">What friends you share with see.</span>
        <input value={name} onChange={(e) => setName(e.target.value)} autoComplete="nickname" maxLength={60} required />
      </label>
      <label>
        Recovery passphrase
        <span className="muted small block">
          It seals your data on your devices and opens it on a new one. Nobody can reset it for you, not even the server.
        </span>
        <SecretInput value={passphrase} onChange={setPassphrase} noun="passphrase" autoComplete="new-password" required />
      </label>
      <label>
        The passphrase again
        <SecretInput value={again} onChange={setAgain} noun="passphrase" autoComplete="new-password" required />
      </label>
      {hint && (
        <p className={hint.error ? "error small" : "muted small"} aria-live="polite">
          {hint.text}
        </p>
      )}
      <Switch checked={saved} onChange={setSaved} label="I have written the passphrase down" description="Somewhere safe, away from this device." />
      <button type="submit" disabled={busy || !ready}>
        {busy ? "Making your keys…" : "Create the account"}
      </button>
      <MsgLine msg={msg} />
      <p className="muted small">
        Already have an account?{" "}
        <ModeLink to="signin" onMode={onMode}>
          Sign in
        </ModeLink>{" "}
        or{" "}
        <ModeLink to="pair" onMode={onMode}>
          pair
        </ModeLink>
        .
      </p>
    </form>
  );
}
