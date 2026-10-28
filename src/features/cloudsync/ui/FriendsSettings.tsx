import { useCallback, useEffect, useState, type FormEvent } from "react";
import { SHARE_KINDS, type Friend, type Share, type ShareKind } from "../../../core/syncWire";
import { deviceFetch, shareText } from "../../../platform/device";
import { failed, fmtDay, MsgLine, type Msg } from "../../../ui/common";
import { Switch } from "../../../ui/controls";
import { friendData, KIND_FIELDS, KIND_LABEL, shareKind, type FriendKind } from "../friends";
import { sessionApi, type SyncSession } from "../session";

interface Props {
  session: SyncSession | null;
  onConnect: () => void;
  /** Sync now, so a newly shared kind's days go up at once. */
  onSync: () => Promise<void>;
}

/** Settings > Friends (docs/users.md section 2.4): who sees what, and what they show you. */
export function FriendsSettings({ session, onConnect, onSync }: Props) {
  if (!session) {
    return (
      <section className="card">
        <h2>Friends</h2>
        <p className="muted small">Friends need sync: connect this device first.</p>
        <div className="actions">
          <button type="button" onClick={onConnect}>
            Set up sync
          </button>
        </div>
      </section>
    );
  }
  return <FriendsList session={session} onSync={onSync} />;
}

function FriendsList({ session, onSync }: { session: SyncSession; onSync: () => Promise<void> }) {
  const fetchFn = deviceFetch({ connectTimeoutMs: 15_000, readTimeoutMs: 30_000 });
  const api = sessionApi(session, fetchFn);
  const [friends, setFriends] = useState<Friend[]>([]);
  const [outgoing, setOutgoing] = useState<Share[]>([]);
  const [incoming, setIncoming] = useState<Share[]>([]);
  const [msg, setMsg] = useState<Msg>(null);

  const load = useCallback(async () => {
    try {
      const a = sessionApi(session, fetchFn);
      const [f, s] = await Promise.all([a.friends(), a.shares()]);
      setFriends(f);
      setOutgoing(s.outgoing);
      setIncoming(s.incoming);
    } catch (err) {
      setMsg(failed(err, "friends"));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session]);

  useEffect(() => {
    void load();
  }, [load]);

  async function toggle(friend: Friend, kind: ShareKind, on: boolean) {
    setMsg(null);
    try {
      const existing = outgoing.find((s) => s.friendId === friend.accountId && s.kind === kind);
      if (on && !existing) {
        await shareKind(api, session, friend, kind);
        await onSync();
      }
      if (!on && existing) await api.unshare(existing.id);
      await load();
    } catch (err) {
      setMsg(failed(err, "friends"));
    }
  }

  return (
    <>
      <Invite api={api} onAccepted={load} />
      {friends.length === 0 ? (
        <p className="muted small">No friends yet. Send someone your friend code, or type theirs.</p>
      ) : (
        friends.map((f) => (
          <FriendCard
            key={f.accountId}
            friend={f}
            sharing={new Set(outgoing.filter((s) => s.friendId === f.accountId).map((s) => s.kind))}
            theyShare={incoming.filter((s) => s.ownerId === f.accountId).map((s) => s.kind)}
            onToggle={(kind, on) => void toggle(f, kind, on)}
            load={() => friendData(api, session, f.accountId)}
            onRemove={() =>
              void api
                .removeFriend(f.accountId)
                .then(load)
                .catch((err: unknown) => setMsg(failed(err, "friends")))
            }
          />
        ))
      )}
      <MsgLine msg={msg} />
    </>
  );
}

function Invite({ api, onAccepted }: { api: ReturnType<typeof sessionApi>; onAccepted: () => Promise<void> }) {
  const [mine, setMine] = useState<{ code: string; expiresAt: number } | null>(null);
  const [code, setCode] = useState("");
  const [msg, setMsg] = useState<Msg>(null);
  async function accept(e: FormEvent) {
    e.preventDefault();
    try {
      const f = await api.acceptFriend(code);
      setCode("");
      setMsg({ kind: "ok", text: `You and ${f.displayName} are friends. Nothing is shared until one of you chooses what.` });
      await onAccepted();
    } catch (err) {
      setMsg(failed(err, "friends"));
    }
  }
  return (
    <section className="card">
      <h2>Add a friend</h2>
      <p className="muted small">
        A friend sees only what you switch on for them, as daily numbers for the last 90 days. Never notes, chats, photos or what you ate.
      </p>
      {mine ? (
        <>
          <p className="pairing-code">{mine.code}</p>
          <p className="muted small">Your friend code, once, until {new Date(mine.expiresAt).toLocaleDateString()}.</p>
          <div className="actions">
            <button type="button" className="secondary" onClick={() => void shareText("Even friend code", `My Even friend code: ${mine.code}`)}>
              Send it
            </button>
          </div>
        </>
      ) : (
        <div className="actions">
          <button type="button" onClick={() => void api.friendInvite().then(setMine, (err: unknown) => setMsg(failed(err, "friends")))}>
            Make a friend code
          </button>
        </div>
      )}
      <form onSubmit={accept} className="stack">
        <label>
          A friend's code
          <input value={code} onChange={(e) => setCode(e.target.value)} autoCapitalize="characters" autoComplete="off" />
        </label>
        <button type="submit" className="secondary" disabled={code.trim().length < 6}>
          Add friend
        </button>
      </form>
      <MsgLine msg={msg} />
    </section>
  );
}

function FriendCard({
  friend,
  sharing,
  theyShare,
  onToggle,
  load,
  onRemove,
}: {
  friend: Friend;
  sharing: Set<ShareKind>;
  theyShare: ShareKind[];
  onToggle: (kind: ShareKind, on: boolean) => void;
  load: () => Promise<FriendKind[]>;
  onRemove: () => void;
}) {
  const [data, setData] = useState<FriendKind[] | null>(null);
  const [msg, setMsg] = useState<Msg>(null);
  return (
    <section className="card">
      <div className="card-head">
        <h2>{friend.displayName}</h2>
        <span className="muted small">friends since {new Date(friend.since).toLocaleDateString()}</span>
      </div>
      <h3 className="small">What {friend.displayName} sees of yours</h3>
      {SHARE_KINDS.map((k) => (
        <Switch
          key={k}
          checked={sharing.has(k)}
          onChange={(on) => onToggle(k, on)}
          label={KIND_LABEL[k]}
          description={KIND_FIELDS[k].map((f) => f.label).join(", ")}
        />
      ))}
      <h3 className="small">What they share with you</h3>
      {theyShare.length === 0 ? (
        <p className="muted small">Nothing yet.</p>
      ) : data ? (
        data.map((k) => <FriendKindTable key={k.share.id} kind={k} />)
      ) : (
        <div className="actions">
          <button type="button" className="secondary" onClick={() => void load().then(setData, (err: unknown) => setMsg(failed(err, "friends")))}>
            Show {theyShare.map((k) => KIND_LABEL[k].toLowerCase()).join(", ")}
          </button>
        </div>
      )}
      <MsgLine msg={msg} />
      <details className="more">
        <summary className="small accent">Remove {friend.displayName}</summary>
        <p className="muted small">Ends everything shared both ways at once. What they already saw cannot be unseen.</p>
        <button type="button" className="danger" onClick={onRemove}>
          Remove friend
        </button>
      </details>
    </section>
  );
}

function FriendKindTable({ kind }: { kind: FriendKind }) {
  const fields = KIND_FIELDS[kind.share.kind];
  const days = kind.days.slice(0, 14);
  return (
    <div className="friend-kind">
      <h4 className="small">{KIND_LABEL[kind.share.kind]}</h4>
      {days.length === 0 ? (
        <p className="muted small">No days yet: they arrive with their next sync.</p>
      ) : (
        <table className="friend-table">
          <thead>
            <tr>
              <th>Day</th>
              {fields.map((f) => (
                <th key={f.key}>{f.unit ? `${f.label} (${f.unit})` : f.label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {days.map((d) => (
              <tr key={d.day}>
                <td>{fmtDay(d.day)}</td>
                {fields.map((f) => {
                  const v = d.values[f.key];
                  return (
                    <td key={f.key}>{v === undefined ? "–" : (v / (f.scale ?? 1)).toLocaleString(undefined, { maximumFractionDigits: f.digits ?? 0 })}</td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
