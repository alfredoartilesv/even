import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import type { SqlDriver } from "../../../db/driver";
import { deviceFetch } from "../../../platform/device";
import { dictation } from "../../../platform/speech";
import { failed, MsgLine, plural, type Msg } from "../../../ui/common";
import { StatusBadge } from "../../../ui/controls";
import { Icon } from "../../../ui/icons";
import { PageHeader } from "../../../ui/layout";
import { downscalePhoto, photoInputUrl } from "../../food/ui/photo";
import type { PhotoInput } from "../../food/food";
import type { SecretStore } from "../../settings/secrets";
import { listAgentActions, undoAgentAction, type AgentAction } from "../actions";
import { ChatApiError, continueConversation, askClaude, startConversation, type ChatDeps } from "../engine";
import { attachmentFromPhoto, MAX_IMAGES_PER_MESSAGE } from "../images";
import { FILE_ACCEPT, MAX_FILES_PER_MESSAGE, type FileAttachment } from "../files";
import { dictationError, dictationLanguage, withDictation } from "../dictation";
import { readAttachment } from "./attach";
import { QUICK_PROMPTS } from "../prompt";
import { chatDeps } from "../service";
import { toBubble, type Bubble } from "../bubbles";
import { deleteConversation, listConversations, loadMessages, type Conversation } from "../store";

interface Props {
  db: SqlDriver;
  secrets: SecretStore;
  version: number;
  /** After the assistant saved or undid something, so other tabs reload. */
  onChanged: () => void;
  /** Settings > Connections, to connect Claude. */
  onConnect: () => void;
}

type Pending =
  { kind: "consent"; text: string; resolve: (ok: boolean) => void } | { kind: "confirm"; summary: string; lines: string[]; resolve: (ok: boolean) => void };

// Native HTTP on the phone; a reply with thinking and tools can take minutes.
const fetchImpl = deviceFetch({ connectTimeoutMs: 30_000, readTimeoutMs: 5 * 60_000 });

const ERROR_TITLE: Record<string, string> = {
  billing: "Out of API credits",
  auth: "API key not accepted",
  rate_limit: "Too many requests",
  overloaded: "Claude is busy",
  network: "No connection",
  bad_request: "Message not processed",
  server: "Claude had a problem",
};

const ACTION_BADGE = { applied: "good", declined: "info", failed: "critical", undone: "info" } as const;

/**
 * The second tab: talk with Claude about your data. Text (typed or dictated), photos taken with
 * the camera or picked from the gallery (meals to log, labels, recipes), and files (a lab report
 * PDF, a CSV export). Every kind of data needs the owner's
 * permission once, and every change the assistant wants to save is shown for confirmation, with
 * an undo afterwards.
 */
export function ChatScreen({ db, secrets, version, onChanged, onConnect }: Props) {
  const [deps, setDeps] = useState<ChatDeps | null | undefined>(undefined);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [showList, setShowList] = useState(false);
  const [current, setCurrent] = useState<string | null>(null);
  const [bubbles, setBubbles] = useState<Bubble[]>([]);
  const [actions, setActions] = useState<AgentAction[]>([]);
  const [text, setText] = useState("");
  const [photos, setPhotos] = useState<PhotoInput[]>([]);
  const [files, setFiles] = useState<FileAttachment[]>([]);
  const [canDictate, setCanDictate] = useState(false);
  const [listening, setListening] = useState(false);
  /** The text typed before the microphone was tapped; dictation goes after it. */
  const typedRef = useRef("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ text: string; retry: boolean; kind: string | null; detail?: string } | null>(null);
  const [msg, setMsg] = useState<Msg>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [pickMenu, setPickMenu] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);
  const cameraRef = useRef<HTMLInputElement>(null);
  const galleryRef = useRef<HTMLInputElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void dictation.available().then(setCanDictate);
    // Leaving the tab stops the microphone.
    return () => void dictation.stop();
  }, []);

  // The engine asks through these and waits for the owner's tap.
  const ask = (p: Omit<Extract<Pending, { kind: "consent" }>, "resolve"> | Omit<Extract<Pending, { kind: "confirm" }>, "resolve">) =>
    new Promise<boolean>((resolve) => setPending({ ...p, resolve } as Pending));

  useEffect(() => {
    void chatDeps(db, {
      secrets,
      fetch: fetchImpl,
      askConsent: (_scope, consentText) => ask({ kind: "consent", text: consentText }),
      confirmAction: (p) => ask({ kind: "confirm", summary: p.summary, lines: p.lines }),
    }).then(setDeps);
  }, [db, secrets, version]);

  const loadList = useCallback(async () => setConversations(await listConversations(db)), [db]);

  const loadCurrent = useCallback(async () => {
    if (!current) {
      setBubbles([]);
      setActions([]);
      return;
    }
    const [m, a] = await Promise.all([loadMessages(db, current), listAgentActions(db, current)]);
    setBubbles(m.map(toBubble).filter((b): b is Bubble => b !== null));
    setActions(a);
  }, [db, current]);

  useEffect(() => {
    void loadList();
  }, [loadList, version]);
  useEffect(() => {
    void loadCurrent();
  }, [loadCurrent]);
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [bubbles, busy, pending]);

  async function addPhotos(picked: FileList | null) {
    setPickMenu(false);
    if (!picked?.length) return;
    try {
      const room = MAX_IMAGES_PER_MESSAGE - photos.length;
      if (room <= 0) throw new Error(`At most ${MAX_IMAGES_PER_MESSAGE} photos per message`);
      const added = await Promise.all([...picked].slice(0, room).map((f) => downscalePhoto(f)));
      setPhotos((p) => [...p, ...added]);
      setMsg(picked.length > room ? { kind: "error", text: `Only ${MAX_IMAGES_PER_MESSAGE} photos fit in one message.` } : null);
    } catch (err) {
      setMsg(failed(err, "chat.photo"));
    }
  }

  async function addFiles(list: FileList | null) {
    setPickMenu(false);
    if (!list?.length) return;
    try {
      const room = MAX_FILES_PER_MESSAGE - files.length;
      if (room <= 0) throw new Error(`At most ${MAX_FILES_PER_MESSAGE} files per message`);
      const added = await Promise.all([...list].slice(0, room).map(readAttachment));
      setFiles((f) => [...f, ...added]);
      setMsg(list.length > room ? { kind: "error", text: `Only ${MAX_FILES_PER_MESSAGE} files fit in one message.` } : null);
    } catch (err) {
      setMsg(failed(err, "chat.file"));
    }
  }

  async function toggleDictation() {
    if (listening) {
      await dictation.stop();
      setListening(false);
      return;
    }
    typedRef.current = text;
    setMsg(null);
    const started = await dictation.start({
      language: dictationLanguage(navigator.language),
      onText: (heard) => setText(withDictation(typedRef.current, heard)),
      onEnd: (code) => {
        setListening(false);
        const problem = dictationError(code);
        if (problem) setMsg({ kind: "error", text: problem });
      },
    });
    if (started) setListening(true);
    else setMsg({ kind: "error", text: dictationError("permission")! });
  }

  /** Runs one turn. Resolves "unsent" when it failed before the question was stored (a permission was declined, bad input). */
  async function run(turn: () => Promise<{ conversationId: string; actions: unknown[] }>): Promise<"ok" | "failed" | "unsent"> {
    setBusy(true);
    setError(null);
    try {
      const res = await turn();
      setCurrent(res.conversationId);
      if (res.actions.length) onChanged();
      return "ok";
    } catch (err) {
      const e = err instanceof ChatApiError ? err : null;
      // A new chat's first question is stored before the request fails: adopt that conversation so Try again works.
      if (e?.conversationId) setCurrent(e.conversationId);
      setError({ text: (err as Error)?.message ?? String(err), retry: Boolean(e?.retryable), kind: e?.kind ?? null, detail: e?.detail });
      failed(err, "chat.send");
      return e ? "failed" : "unsent";
    } finally {
      setBusy(false);
      setPending(null);
      await Promise.all([loadList(), loadCurrent()]);
    }
  }

  async function send(e?: FormEvent) {
    e?.preventDefault();
    if (!deps || busy || (!text.trim() && !photos.length && !files.length)) return;
    if (listening) {
      await dictation.stop();
      setListening(false);
    }
    const question = text;
    const images = photos.map(attachmentFromPhoto);
    const sentFiles = files;
    // Show the question right away; the stored copy replaces it when the turn ends.
    setBubbles((b) => [
      ...b,
      { id: "sending", role: "user", texts: question.trim() ? [question.trim()] : [], images: photos.map(photoInputUrl), files: files.map((f) => f.name) },
    ]);
    const attached = photos;
    setText("");
    setPhotos([]);
    setFiles([]);
    const opts = { images, files: sentFiles };
    const outcome = await run(() => (current ? askClaude(deps, current, question, opts) : startConversation(deps, question, opts)));
    if (outcome === "unsent") {
      setText(question);
      setPhotos(attached);
      setFiles(sentFiles);
    }
  }

  async function undo(a: AgentAction) {
    try {
      await undoAgentAction(db, a.id);
      setMsg({ kind: "ok", text: `Undone: ${a.summary}` });
      onChanged();
      await loadCurrent();
    } catch (err) {
      setMsg(failed(err, "chat.undo"));
    }
  }

  function answer(ok: boolean) {
    pending?.resolve(ok);
    setPending(null);
  }

  if (deps === undefined) return <p className="muted">Opening the chat…</p>;

  if (deps === null) {
    return (
      <section>
        <PageHeader title="Chat" />
        <div className="card">
          <p>Connect Claude to ask about your data, log meals from a photo and plan your meal prep.</p>
          <p className="muted small">The chat uses your own Claude API key, kept in the phone's secure storage.</p>
          <button onClick={onConnect}>Connect Claude</button>
        </div>
      </section>
    );
  }

  const title = conversations.find((c) => c.id === current)?.title ?? "New chat";

  return (
    <section className="chat">
      <PageHeader
        title="Chat"
        actions={
          <>
            <button type="button" className="secondary small-button" aria-expanded={showList} onClick={() => setShowList((s) => !s)}>
              History
            </button>
            <button
              type="button"
              className="secondary small-button"
              disabled={busy}
              onClick={() => {
                setCurrent(null);
                setShowList(false);
                setError(null);
              }}
            >
              New
            </button>
          </>
        }
      />

      {showList && (
        <ul className="entries chat-list">
          {conversations.length === 0 && <li className="muted small">No conversations yet.</li>}
          {conversations.map((c) => (
            <li key={c.id}>
              <button
                type="button"
                className="link grow"
                onClick={() => {
                  setCurrent(c.id);
                  setShowList(false);
                  setError(null);
                }}
              >
                <div>{c.title ?? "Untitled"}</div>
                <div className="muted small">{new Date(c.updatedAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}</div>
              </button>
              <button
                type="button"
                className="secondary danger small-button"
                aria-label={`Delete ${c.title ?? "conversation"}`}
                onClick={async () => {
                  await deleteConversation(db, c.id);
                  if (c.id === current) setCurrent(null);
                  await loadList();
                }}
              >
                Delete
              </button>
            </li>
          ))}
        </ul>
      )}

      {current && <div className="muted small chat-title">{title}</div>}

      <div className="chat-log" aria-live="polite">
        {bubbles.length === 0 && !busy && (
          <div className="stack tight">
            <p className="muted small">
              Ask about your sleep, training or meals (type or dictate), send a photo of a meal to log it, attach a lab report or an export, or start from one
              of these:
            </p>
            <div className="chips">
              {QUICK_PROMPTS.map((q) => (
                <button
                  key={q.label}
                  type="button"
                  className="chip"
                  onClick={() => {
                    setText(q.prompt);
                    if (q.needs === "claude.photos" || q.needs === "claude.files") setPickMenu(true);
                  }}
                >
                  {q.label}
                </button>
              ))}
            </div>
          </div>
        )}
        {bubbles.map((b) => (
          <div key={b.id} className={`bubble ${b.role}`}>
            {b.images.length > 0 && (
              <div className="bubble-photos">
                {b.images.map((src, i) => (
                  <img key={i} src={src} alt="Attached photo" className="thumb" width={96} height={96} />
                ))}
              </div>
            )}
            {b.files.length > 0 && (
              <div className="file-chips">
                {b.files.map((name, i) => (
                  <span key={i} className="file-chip">
                    <Icon name="file" size={16} />
                    <span>{name}</span>
                  </span>
                ))}
              </div>
            )}
            {b.texts.map((t, i) => (
              <p key={i}>{t}</p>
            ))}
          </div>
        ))}
        {busy && !pending && (
          <div className="bubble assistant muted">
            <span className="spin" aria-hidden>
              ⟳
            </span>{" "}
            Thinking…
          </div>
        )}

        {pending?.kind === "consent" && (
          <div className="card prompt-card" role="alertdialog" aria-label="Permission">
            <strong>Allow this?</strong>
            <p className="small">{pending.text}</p>
            <p className="muted small">You can change this later in Settings, Privacy & data.</p>
            <div className="actions">
              <button onClick={() => answer(true)}>Allow</button>
              <button className="secondary" onClick={() => answer(false)}>
                Don't allow
              </button>
            </div>
          </div>
        )}
        {pending?.kind === "confirm" && (
          <div className="card prompt-card" role="alertdialog" aria-label="Confirm change">
            <strong>{pending.summary}</strong>
            <ul className="plain small">
              {pending.lines.map((l, i) => (
                <li key={i}>{l}</li>
              ))}
            </ul>
            <div className="actions">
              <button onClick={() => answer(true)}>Save</button>
              <button className="secondary" onClick={() => answer(false)}>
                Don't save
              </button>
            </div>
          </div>
        )}

        {error && (
          <div className="card chat-error" role="alert">
            <strong>{ERROR_TITLE[error.kind ?? ""] ?? "Something went wrong"}</strong>
            <p className="small">{error.text}</p>
            <div className="actions compact">
              {error.kind === "billing" && (
                <a className="button" href="https://console.anthropic.com/settings/billing" target="_blank" rel="noreferrer">
                  Add credits
                </a>
              )}
              {error.retry && current && (
                <button className={error.kind === "billing" ? "secondary" : undefined} onClick={() => void run(() => continueConversation(deps, current))}>
                  Try again
                </button>
              )}
              {(error.kind === "auth" || error.kind === "billing") && (
                <button className="secondary" onClick={onConnect}>
                  Claude settings
                </button>
              )}
              <button className="secondary" onClick={() => setError(null)}>
                Dismiss
              </button>
            </div>
            {error.detail && (
              <details className="muted small">
                <summary>Technical details</summary>
                <p className="mono">{error.detail}</p>
              </details>
            )}
          </div>
        )}

        {actions.length > 0 && (
          <details className="card">
            <summary>Changes in this chat ({actions.length})</summary>
            <ul className="entries">
              {actions.map((a) => (
                <li key={a.id}>
                  <div className="grow small">
                    {a.summary}
                    <div>
                      <StatusBadge status={ACTION_BADGE[a.status]}>{a.status}</StatusBadge>
                    </div>
                  </div>
                  {a.status === "applied" && (
                    <button className="secondary small-button" onClick={() => void undo(a)}>
                      Undo
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </details>
        )}
        <div ref={endRef} />
      </div>

      <MsgLine msg={msg} />

      <form className="composer" onSubmit={send}>
        {photos.length > 0 && (
          <div className="composer-photos">
            {photos.map((p, i) => (
              <div key={i} className="composer-photo">
                <img src={photoInputUrl(p)} alt={`Photo ${i + 1} to send`} className="thumb" width={56} height={56} />
                <button type="button" className="remove" aria-label={`Remove photo ${i + 1}`} onClick={() => setPhotos((ps) => ps.filter((_, j) => j !== i))}>
                  ×
                </button>
              </div>
            ))}
          </div>
        )}
        {files.length > 0 && (
          <div className="file-chips">
            {files.map((f, i) => (
              <span key={i} className="file-chip">
                <Icon name="file" size={16} />
                <span>{f.name}</span>
                <button
                  type="button"
                  className="remove secondary"
                  aria-label={`Remove ${f.name}`}
                  onClick={() => setFiles((fs) => fs.filter((_, j) => j !== i))}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        )}
        {pickMenu && (
          <div className="pick-menu" role="menu">
            <button type="button" role="menuitem" className="secondary" onClick={() => cameraRef.current?.click()}>
              Take a photo
            </button>
            <button type="button" role="menuitem" className="secondary" onClick={() => galleryRef.current?.click()}>
              Attach an image
            </button>
            <button
              type="button"
              role="menuitem"
              className="secondary"
              disabled={files.length >= MAX_FILES_PER_MESSAGE}
              onClick={() => fileRef.current?.click()}
            >
              Attach a file
            </button>
          </div>
        )}
        <div className="composer-row">
          <button
            type="button"
            className="icon-button secondary"
            aria-label="Add a photo or a file"
            aria-expanded={pickMenu}
            title="Take a photo, attach an image or a file"
            disabled={busy || (photos.length >= MAX_IMAGES_PER_MESSAGE && files.length >= MAX_FILES_PER_MESSAGE)}
            onClick={() => setPickMenu((m) => !m)}
          >
            <Icon name="paperclip" size={22} />
          </button>
          <textarea
            rows={1}
            value={text}
            placeholder={
              listening
                ? "Listening…"
                : photos.length
                  ? `Say something about the ${plural(photos.length, "photo")}…`
                  : files.length
                    ? "Ask about the file…"
                    : "Message"
            }
            aria-label="Message"
            onChange={(e) => {
              setText(e.target.value);
              typedRef.current = e.target.value;
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void send();
              }
            }}
          />
          {canDictate && (
            <button
              type="button"
              className={`icon-button secondary${listening ? " listening" : ""}`}
              aria-label={listening ? "Stop dictation" : "Dictate"}
              aria-pressed={listening}
              title={listening ? "Stop dictation" : "Dictate a message"}
              disabled={busy}
              onClick={() => void toggleDictation()}
            >
              <Icon name={listening ? "stop" : "mic"} size={22} />
            </button>
          )}
          <button type="submit" className="icon-button" aria-label="Send" disabled={busy || (!text.trim() && !photos.length && !files.length)}>
            <Icon name="send" size={22} />
          </button>
        </div>
        <input
          ref={cameraRef}
          type="file"
          accept="image/*"
          capture="environment"
          hidden
          onChange={(e) => void addPhotos(e.target.files).then(() => (e.target.value = ""))}
        />
        <input
          ref={galleryRef}
          type="file"
          accept="image/*"
          multiple
          hidden
          onChange={(e) => void addPhotos(e.target.files).then(() => (e.target.value = ""))}
        />
        <input
          ref={fileRef}
          type="file"
          accept={FILE_ACCEPT}
          multiple
          hidden
          onChange={(e) => void addFiles(e.target.files).then(() => (e.target.value = ""))}
        />
      </form>
    </section>
  );
}
