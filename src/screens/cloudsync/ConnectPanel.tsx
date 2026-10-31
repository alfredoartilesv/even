import { useEffect, useRef, useState, type FormEvent } from "react";
import type { SecretStore } from "../../core/secretStore";
import { deviceFetch, platformName } from "../../platform/device";
import { keepNothing } from "../../platform/idb";
import { failed, MsgLine, type Msg } from "../../ui/common";
import { SecretInput, Switch } from "../../ui/controls";
import { Segmented } from "../../ui/layout";
import { Icon } from "../../ui/icons";
import { QrCode } from "../../ui/QrCode";
import { checkPassphrase, passphraseHint } from "../../domain/cloudsync/keys";
import { createAccount, pairingQrText, signInWithPassphrase, startPairing, type PairingRequest, type SyncSession } from "../../domain/cloudsync/session";

type Mode = "signin" | "create";

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
  create: "First time here: you have an invite code and want to start your account.",
};

/**
 * Joining the sync account (docs/users.md section 2): log in with email and passphrase or sign up
 * with an invite on one side, and beside them a pairing QR and code that a device already connected
 * scans or types, so pairing needs no choice first. Used by Settings > Sync on the phone and as the
 * first screen of the web app; side by side when there is room, one under the other on a phone.
 */
export function ConnectPanel({ secrets, isNative, onConnected }: Props) {
  const [mode, setMode] = useState<Mode>("signin");
  const [server, setServer] = useState(DEFAULT_SERVER);
  const [shared, setShared] = useState(false);
  // On a phone the two sides take turns, so each fits one screen; side by side they are both shown and this is unused.
  const [pairing, setPairing] = useState(false);
  const fetchFn = deviceFetch({ connectTimeoutMs: 15_000, readTimeoutMs: 60_000 });
  const plain = thisDevice(isNative);
  const device = shared ? { ...plain, name: `${plain.name} (shared)` } : plain;
  // Chosen before anything is stored: the session and the data then stay in this tab's memory.
  const before = () => shared && keepNothing();
  // On the web the server is this origin; on the phone the code waits for an address that can work.
  const serverReady = !isNative || isUrl(server.trim());
  const flow = { server, serverReady, secrets, device, fetchFn, before, onConnected, onMode: setMode };
  return (
    <div className="connect-panel">
      <div className={pairing ? "connect-grid pairing" : "connect-grid"}>
        <section className="stack connect-account" aria-label="Log in or sign up">
          {isNative && (
            <label>
              Sync server
              <input
                value={server}
                onChange={(e) => setServer(e.target.value)}
                placeholder="https://your-even.vercel.app"
                inputMode="url"
                autoCapitalize="off"
              />
            </label>
          )}
          <Segmented
            label="Log in or sign up"
            value={mode}
            onChange={setMode}
            items={[
              { id: "signin", label: "Log in" },
              { id: "create", label: "Sign up" },
            ]}
          />
          <p className="muted small">{MODE_HINT[mode]}</p>
          {mode === "signin" ? <SignIn {...flow} /> : <Create {...flow} />}
          <button type="button" className="secondary with-icon connect-pair-open" onClick={() => setPairing(true)}>
            <Icon name="qr" size={20} />
            Pair with a QR code
          </button>
          {/* Under the forms rather than under both columns: it applies to pairing too, but there it left a gap the height of the QR. */}
          {!isNative && (
            <div className="connect-shared">
              <Switch
                checked={shared}
                onChange={setShared}
                label="This is a shared computer"
                description="Keep nothing here: closing or reloading the tab signs out and forgets the data."
              />
            </div>
          )}
        </section>
        <aside className="stack connect-pair" aria-labelledby="pair-title">
          <button type="button" className="link accent with-icon connect-pair-back" onClick={() => setPairing(false)}>
            <Icon name="back" size={18} />
            Log in or sign up instead
          </button>
          <div>
            <h3 id="pair-title">Pair with a device</h3>
            <p className="muted small">Signed in on your phone or another browser? Scan this with Even there, or type the code. No passphrase needed.</p>
          </div>
          <Pair {...flow} />
        </aside>
      </div>
    </div>
  );
}

function isUrl(s: string): boolean {
  try {
    return /^https?:$/.test(new URL(s).protocol);
  } catch {
    return false;
  }
}

interface FlowProps {
  server: string;
  /** The server address is complete enough to ask it for a pairing code without the owner pressing anything. */
  serverReady: boolean;
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
        {busy ? "Opening your keys…" : "Log in"}
      </button>
      <MsgLine msg={msg} />
      <p className="muted small">
        Forgot it? Pair with a connected phone, then set a new one in Settings. No account yet?{" "}
        <ModeLink to="create" onMode={onMode}>
          Sign up with your invite
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

// A code lasts 5 minutes. Left open longer, the screen fetches a fresh one by itself this many times,
// so a phone fetched from another room still finds a live code, without asking the server forever.
const AUTO_RENEWALS = 3;

function Pair({ server, serverReady, secrets, device, fetchFn, before, onConnected }: FlowProps) {
  const [req, setReq] = useState<PairingRequest | null>(null);
  const [asking, setAsking] = useState(false);
  const [copied, setCopied] = useState(false);
  const [msg, setMsg] = useState<Msg>(null);
  // Made per code, not once per mount: React's development double mount runs the unmount cleanup
  // straight away, which aborted a controller kept in state before the first code was even asked for.
  const stop = useRef<AbortController | null>(null);
  const renewals = useRef(0);
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
      // The shared-computer choice applies when the keys arrive, not now: it can still change while the code shows.
      const r = await startPairing(server, secrets, device, { fetchFn, signal: ctl.signal, beforeSave: before });
      if (ctl.signal.aborted) return;
      setReq(r);
      r.done.then(onConnected, (err) => {
        if (ctl.signal.aborted) return;
        setReq(null);
        const expired = Date.now() >= r.expiresAt || /expired/i.test(err instanceof Error ? err.message : "");
        if (expired && renewals.current < AUTO_RENEWALS) {
          renewals.current++;
          void begin();
          return;
        }
        setMsg(failed(err, "cloudsync"));
      });
    } catch (err) {
      if (!ctl.signal.aborted) setMsg(failed(err, "cloudsync"));
    } finally {
      if (stop.current === ctl) setAsking(false);
    }
  }
  const beginRef = useRef(begin);
  beginRef.current = begin;

  // The code is the whole point of this screen, so it comes without a button press. A new one when
  // this device's name changes (the shared-computer switch) or the phone's server address settles.
  useEffect(() => {
    if (!serverReady) return;
    renewals.current = 0;
    const t = setTimeout(() => void beginRef.current(), 400);
    return () => clearTimeout(t);
  }, [serverReady, server, device.name]);

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
        <div className="pair-qr pending" aria-busy={asking}>
          {asking ? (
            <p className="muted small">Getting a pairing code…</p>
          ) : !serverReady ? (
            <p className="muted small center">Type the sync server above to get a pairing code.</p>
          ) : (
            <button type="button" onClick={() => ((renewals.current = 0), void begin())}>
              {msg ? "Get a new code" : "Show the pairing code"}
            </button>
          )}
        </div>
        <MsgLine msg={msg} />
        <PairSteps />
      </div>
    );
  }
  return (
    <div className="stack" aria-live="polite">
      <div className="pair-qr">
        <QrCode text={pairingQrText(req.code)} label="Pairing QR code. Scan it from Even on your connected device." size={200} />
      </div>
      {/* Under the QR, not folded away: a browser without a camera, or a phone that cannot focus, types it. */}
      <div className="pair-code-row">
        <p className="pairing-code" aria-label={`Pairing code ${req.code.split("").join(" ")}`}>
          {req.code}
        </p>
        <div className="row small">
          <span className="muted">Expires in {left ?? "5:00"}</span>
          <button type="button" className="link accent" onClick={() => void copy(req.code)}>
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
      </div>
      <p className="muted small">Works once. Waiting for the approval… your keys come straight here, sealed: the server cannot read them.</p>
      <PairSteps />
    </div>
  );
}

/** The three steps on the device that is already connected, folded: the QR and code say most of it. */
function PairSteps() {
  return (
    <details className="more">
      <summary className="small accent">How to pair</summary>
      <ol className="steps small">
        <li>
          On your phone or browser that is already connected, open Even, then Settings, <b>Sync &amp; devices</b>.
        </li>
        <li>
          Under <b>Add a device</b>, tap <b>Scan the QR code</b> and point the camera at this screen (Even's scanner, not the camera app), or choose{" "}
          <b>Type the code instead</b>.
        </li>
        <li>Check the name it shows and approve. This screen opens by itself.</li>
      </ol>
    </details>
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
          Log in
        </ModeLink>{" "}
        or use the pairing code.
      </p>
    </form>
  );
}
