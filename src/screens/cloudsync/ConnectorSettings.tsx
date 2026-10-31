import { useCallback, useEffect, useState } from "react";
import { HEALTH_MCP_PATH, type McpGrant } from "../../core/syncWire";
import type { SqlDriver } from "../../db/driver";
import { deviceId } from "../../db/settings";
import { listAgentActions, undoAgentAction, type AgentAction } from "../../domain/chat/actions";
import { CONNECTOR_TEXT, consentStatus, hasConsent, recordConsent, type ConnectorScope } from "../../domain/chat/consent";
import { sessionApi, type SyncSession } from "../../domain/cloudsync/session";
import { deviceFetch, shareText } from "../../platform/device";
import { failed, MsgLine, type Msg } from "../../ui/common";
import { StatusBadge, Switch } from "../../ui/controls";

/**
 * Settings > Connections > Claude, beside the Chat tab's API key (docs/users.md section 10): Claude's own apps, on the owner's Claude
 * plan, ask about and add to Even's data through the sync server. Here the owner finds the address
 * to add in Claude, turns it on (the consents the server reads from the synced consents table),
 * sees and cuts off its connections, and undoes what it added.
 */

const when = (ms: number | null) => (ms ? new Date(ms).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "never");
const SHOWN = 10;

/** Claude's sign-ins (MCP grants), each with a Disconnect. Also the admin server's (AdminSettings). */
export function GrantList({ grants, onDisconnect }: { grants: McpGrant[]; onDisconnect: (g: McpGrant) => void }) {
  if (grants.length === 0) return null;
  return (
    <ul className="device-list">
      {grants.map((g) => (
        <li key={g.id} className="row">
          <span className="grow small">
            <strong>{g.clientName}</strong>
            <br />
            <span className="muted">
              connected {when(g.createdAt)} · last used {when(g.lastUsedAt)}
            </span>
          </span>
          <button type="button" className="secondary" onClick={() => onDisconnect(g)}>
            Disconnect
          </button>
        </li>
      ))}
    </ul>
  );
}

interface Props {
  db: SqlDriver;
  session: SyncSession | null;
  onConnect: () => void;
  /** Sync now: the server reads the consents from the synced rows, and the connector's changes arrive that way. */
  onSync: () => Promise<void>;
  /** Bumped after a sync, so changes Claude made show up. */
  version: number;
}

export function ConnectorSettings({ db, session, onConnect, onSync, version }: Props) {
  if (!session) {
    return (
      <section className="card">
        <div className="card-head">
          <h2>Claude connector</h2>
          <StatusBadge status="info">off</StatusBadge>
        </div>
        <p className="muted small">The connector reaches your data through your Even account: connect this device first.</p>
        <div className="actions">
          <button type="button" onClick={onConnect}>
            Set up sync
          </button>
        </div>
      </section>
    );
  }
  return <Connector db={db} session={session} onSync={onSync} version={version} />;
}

function Connector({ db, session, onSync, version }: { db: SqlDriver; session: SyncSession; onSync: () => Promise<void>; version: number }) {
  const api = sessionApi(session, deviceFetch({ connectTimeoutMs: 15_000, readTimeoutMs: 30_000 }));
  // The web app talks to its own origin, so its session has no server address: Claude needs the full one.
  const url = `${(session.serverUrl || location.origin).replace(/\/+$/, "")}${HEALTH_MCP_PATH}`;
  const [on, setOn] = useState<Record<ConnectorScope, boolean> | null>(null);
  const [aggregates, setAggregates] = useState(true);
  const [grants, setGrants] = useState<McpGrant[]>([]);
  const [changes, setChanges] = useState<AgentAction[]>([]);
  const [msg, setMsg] = useState<Msg>(null);

  const load = useCallback(async () => {
    const [connector, changesOn, agg, actions] = await Promise.all([
      hasConsent(db, "claude.connector"),
      hasConsent(db, "claude.connector_changes"),
      consentStatus(db).then((c) => c["claude.aggregates"]),
      listAgentActions(db),
    ]);
    setOn({ "claude.connector": connector, "claude.connector_changes": changesOn });
    setAggregates(agg);
    setChanges(actions.filter((a) => a.conversationId === null));
    try {
      setGrants(await api.connectorGrants());
    } catch (err) {
      setMsg(failed(err, "settings.connector"));
    }
    // The api is made per render; the session is what matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [db, session]);

  useEffect(() => {
    void load();
  }, [load, version]);

  async function act(fn: () => Promise<unknown>, ok: string) {
    setMsg(null);
    try {
      await fn();
      setMsg({ kind: "ok", text: ok });
      await load();
    } catch (err) {
      setMsg(failed(err, "settings.connector"));
    }
  }

  async function decide(scope: ConnectorScope, granted: boolean) {
    await act(
      async () => {
        const id = await deviceId(db);
        await recordConsent(db, scope, granted, id);
        // Turning the connector off takes its changes with it.
        if (scope === "claude.connector" && !granted && on?.["claude.connector_changes"]) await recordConsent(db, "claude.connector_changes", false, id);
        // The server reads consents from the synced rows: they count once this device has synced.
        await onSync();
      },
      granted ? "Allowed. Your choice is kept with its date and synced." : "Not allowed any more. Your choice is kept with its date and synced.",
    );
  }

  return (
    <>
      <section className="card">
        <div className="card-head">
          <h2>Claude connector</h2>
          {on && (on["claude.connector"] ? <StatusBadge status="good">on</StatusBadge> : <StatusBadge status="info">off</StatusBadge>)}
        </div>
        <p className="muted small">
          Ask about your data in Claude itself (claude.ai, the Claude app), on your Claude plan, with or without the Chat tab. In Claude: Settings &gt;
          Connectors &gt; Add custom connector, with this address, then sign in with your Even email and passphrase.
        </p>
        <p>
          <code>{url}</code>
        </p>
        <div className="actions">
          <button
            type="button"
            className="secondary"
            onClick={() =>
              void shareText("Even connector", url).then((how) => setMsg({ kind: "ok", text: how === "copied" ? "Address copied." : "Address shared." }))
            }
          >
            Copy address
          </button>
        </div>
      </section>

      <section className="card">
        <h2>What it may do</h2>
        {on && (
          <>
            <Switch
              checked={on["claude.connector"]}
              onChange={(v) => void decide("claude.connector", v)}
              label="Answer from your data"
              description={CONNECTOR_TEXT["claude.connector"]}
            />
            <Switch
              checked={on["claude.connector_changes"]}
              disabled={!on["claude.connector"]}
              onChange={(v) => void decide("claude.connector_changes", v)}
              label="Add entries"
              description={CONNECTOR_TEXT["claude.connector_changes"]}
            />
          </>
        )}
        <p className="muted small">
          Which kinds of data it may get (summaries, detailed records, notes) is what you allow in Privacy &amp; data, the same as for the Chat tab.
          {!aggregates && " Questions and summaries are off there, so it gets nothing yet."} Everything it is sent is listed there under Sent to Claude.
        </p>
        <MsgLine msg={msg} />
      </section>

      <section className="card">
        <h2>Connections</h2>
        {grants.length === 0 ? (
          <p className="muted small">None yet. Add the address in Claude to make one.</p>
        ) : (
          <p className="muted small">Each one is a Claude sign-in. While it is connected, Even's server can open your synced data to answer it.</p>
        )}
        <GrantList
          grants={grants}
          onDisconnect={(g) => void act(() => api.revokeConnectorGrant(g.id), `${g.clientName} is disconnected. It has to sign in again to reach your data.`)}
        />
      </section>

      {changes.length > 0 && (
        <section className="card">
          <h2>Added by Claude</h2>
          <ul className="entries">
            {changes.slice(0, SHOWN).map((a) => (
              <li key={a.id}>
                <div className="grow">
                  <div className="small">{a.summary}</div>
                  <div className="muted small">{when(a.decidedAtMs)}</div>
                </div>
                {a.status === "applied" ? (
                  <button
                    type="button"
                    className="link small accent"
                    onClick={() => void act(async () => (await undoAgentAction(db, a.id), await onSync()), "Undone.")}
                  >
                    Undo
                  </button>
                ) : (
                  <StatusBadge status={a.status === "undone" ? "info" : "warning"}>{a.status}</StatusBadge>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}
