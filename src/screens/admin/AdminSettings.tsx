import { useCallback, useEffect, useState, type FormEvent } from "react";
import { StatTile } from "../../ui/charts";
import type { AdminAccount, AdminDevice, AdminInvite, AuditEntry, McpGrant, ServiceHealth } from "../../core/syncWire";
import { sessionApi, type SyncSession } from "../../domain/cloudsync/session";
import { deviceFetch, shareText } from "../../platform/device";
import { failed, MsgLine, plural, type Msg } from "../../ui/common";
import { StatusBadge, type Status } from "../../ui/controls";
import { GrantList } from "../cloudsync/ConnectorSettings";

/**
 * You > Admin (docs/users.md section 2.6), shown to admin accounts only. Invites, accounts,
 * quotas, devices and suspension; the same actions the MCP server offers Claude. An admin sees who
 * and when, never anyone's data: the server cannot read it either.
 */

const when = (ms: number | null) => (ms ? new Date(ms).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "never");
const mb = (bytes: number) => (bytes >= 1_073_741_824 ? `${(bytes / 1_073_741_824).toFixed(1)} GB` : `${(bytes / 1_048_576).toFixed(1)} MB`);
const QUOTAS_MB = [100, 200, 500, 1_024];
const INVITE_STATUS: Record<AdminInvite["status"], Status> = { open: "good", used: "info", expired: "warning", cancelled: "warning" };

type AdminApi = ReturnType<typeof sessionApi>["admin"];

export function AdminSettings({ session }: { session: SyncSession }) {
  const api = sessionApi(session, deviceFetch({ connectTimeoutMs: 15_000, readTimeoutMs: 30_000 })).admin;
  const [health, setHealth] = useState<ServiceHealth | null>(null);
  const [invites, setInvites] = useState<AdminInvite[]>([]);
  const [accounts, setAccounts] = useState<AdminAccount[]>([]);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [grants, setGrants] = useState<McpGrant[]>([]);
  const [msg, setMsg] = useState<Msg>(null);

  const load = useCallback(async () => {
    try {
      const [h, i, a, l, g] = await Promise.all([api.health(), api.invites(), api.accounts(), api.audit(), api.mcpGrants()]);
      setHealth(h);
      setInvites(i);
      setAccounts(a);
      setAudit(l);
      setGrants(g);
    } catch (err) {
      setMsg(failed(err, "admin"));
    }
    // The api is made per render; the session is what matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session]);

  useEffect(() => {
    void load();
  }, [load]);

  /** Runs an admin action, then reloads everything (the audit log included). */
  async function act(fn: () => Promise<unknown>, ok: string) {
    setMsg(null);
    try {
      await fn();
      setMsg({ kind: "ok", text: ok });
      await load();
    } catch (err) {
      setMsg(failed(err, "admin"));
    }
  }

  return (
    <>
      <MsgLine msg={msg} />
      {health && (
        <section className="admin-status" aria-label="Status">
          <StatTile label="Accounts" value={String(health.accounts)} note={plural(health.devices, "device")} />
          <StatTile label="Storage" value={mb(health.bytes)} note="sealed, on the server" />
          <StatTile label="Open invites" value={String(health.openInvites)} note="not used yet" />
          <StatTile label="Build" value={health.build} note="deployed now" />
        </section>
      )}
      <NewInvite api={api} serverUrl={session.serverUrl} onMade={load} />
      <Invites invites={invites} onCancel={(i) => void act(() => api.cancelInvite(i.id), `The invite for ${i.email} no longer works.`)} />
      <section className="card">
        <h2>Accounts</h2>
        <ul className="device-list">
          {accounts.map((a) => (
            <AccountRow key={a.id} account={a} self={a.id === session.accountId} api={api} act={act} />
          ))}
        </ul>
      </section>
      <ClaudeConnector
        url={`${session.serverUrl || location.origin}/mcp`}
        grants={grants}
        onDisconnect={(g) => void act(() => api.revokeMcpGrant(g.id), `${g.clientName} is disconnected. It has to sign in again to manage Even.`)}
      />
      <section className="card">
        <h2>Audit log</h2>
        <p className="muted small">Every admin action, from this app, Claude (MCP) or the command line. Ids only, never an email or a code.</p>
        <ul className="device-list">
          {audit.slice(0, 30).map((e) => (
            <li key={e.id} className="row">
              <span className="grow small">
                <strong>{e.action}</strong> <span className="muted">via {e.via}</span>
                <br />
                <span className="muted">
                  {when(e.at)} · by {e.actor === session.accountId ? "you" : e.actor.slice(0, 8)}
                  {e.target && ` · on ${e.target.slice(0, 8)}`}
                </span>
              </span>
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}

function NewInvite({ api, serverUrl, onMade }: { api: AdminApi; serverUrl: string; onMade: () => Promise<void> }) {
  const [email, setEmail] = useState("");
  const [days, setDays] = useState(14);
  const [made, setMade] = useState<{ email: string; code: string } | null>(null);
  const [msg, setMsg] = useState<Msg>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    try {
      const { code, invite } = await api.createInvite(email, days);
      setMade({ email: invite.email, code });
      setEmail("");
      await onMade();
    } catch (err) {
      setMsg(failed(err, "admin"));
    } finally {
      setBusy(false);
    }
  }

  // What the invited person needs: where, which email, the code. Sent however the admin likes.
  const message = made
    ? `You're invited to Even. Open ${serverUrl || location.origin}, choose "Sign up", and use the email ${made.email} with the invite code ${made.code}. It works once.`
    : "";
  return (
    <section className="card">
      <h2>Invite someone</h2>
      <p className="muted small">An invite makes one account, for the email it was made for. The code is shown once: send it now.</p>
      <form onSubmit={submit} className="stack">
        <label>
          Email
          <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="off" />
        </label>
        <label>
          Valid for
          <select value={days} onChange={(e) => setDays(Number(e.target.value))}>
            {[3, 7, 14, 30].map((d) => (
              <option key={d} value={d}>
                {d} days
              </option>
            ))}
          </select>
        </label>
        <div className="actions">
          <button type="submit" disabled={busy || !email}>
            {busy ? "Making…" : "Make invite"}
          </button>
        </div>
      </form>
      {made && (
        <div className="stack">
          <p>
            Code for {made.email}: <code>{made.code}</code>
          </p>
          <div className="actions">
            <button
              type="button"
              onClick={() =>
                void shareText("Invite to Even", message).then(
                  (how) => setMsg({ kind: "ok", text: how === "shared" ? "Shared." : "Copied: paste it in a message." }),
                  (err) => setMsg(failed(err, "admin")),
                )
              }
            >
              Send invite
            </button>
            <button type="button" className="secondary" onClick={() => setMade(null)}>
              Done
            </button>
          </div>
        </div>
      )}
      <MsgLine msg={msg} />
    </section>
  );
}

function Invites({ invites, onCancel }: { invites: AdminInvite[]; onCancel: (i: AdminInvite) => void }) {
  if (invites.length === 0) return null;
  return (
    <section className="card">
      <h2>Invites</h2>
      <ul className="device-list">
        {invites.map((i) => (
          <li key={i.id} className="row">
            <span className="grow">
              <strong>{i.email}</strong> <StatusBadge status={INVITE_STATUS[i.status]}>{i.status}</StatusBadge>
              <br />
              <span className="muted small">
                made {when(i.createdAt)} · {i.status === "used" ? `used ${when(i.usedAt)}` : `until ${when(i.expiresAt)}`}
              </span>
            </span>
            {i.status === "open" && (
              <button type="button" className="secondary" onClick={() => onCancel(i)}>
                Cancel
              </button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

function AccountRow({
  account: a,
  self,
  api,
  act,
}: {
  account: AdminAccount;
  self: boolean;
  api: AdminApi;
  act: (fn: () => Promise<unknown>, ok: string) => Promise<void>;
}) {
  const [devices, setDevices] = useState<AdminDevice[] | null>(null);
  const open = devices !== null;
  const showDevices = async () => setDevices(open ? null : await api.devices(a.id));

  return (
    <li className="stack">
      <div className="row">
        <span className="grow">
          <strong>{a.displayName}</strong> {a.isAdmin && <StatusBadge status="info">admin</StatusBadge>}{" "}
          {a.suspendedAt !== null && <StatusBadge status="critical">suspended</StatusBadge>}
          <br />
          <span className="muted small">
            {a.email} · {plural(a.devices, "device")} · {plural(a.friends, "friend")} · last seen {when(a.lastSeenAt)}
            <br />
            {mb(a.bytes)} of {mb(a.quotaBytes)} · since {new Date(a.createdAt).toLocaleDateString()}
          </span>
        </span>
        <button type="button" className="secondary" onClick={() => void showDevices()} aria-expanded={open}>
          {open ? "Close" : "Manage"}
        </button>
      </div>
      {devices && (
        <div className="stack">
          <ul className="device-list">
            {devices.map((d) => (
              <li key={d.id} className="row">
                <span className="grow small">
                  {d.name}{" "}
                  <span className="muted">
                    ({d.kind}, by {d.addedBy})
                  </span>
                  <br />
                  <span className="muted">{d.revokedAt ? `removed ${when(d.revokedAt)}` : `last seen ${when(d.lastSeenAt)}`}</span>
                </span>
                {d.revokedAt === null && (
                  <button
                    type="button"
                    className="secondary"
                    onClick={() =>
                      void act(async () => {
                        await api.revokeDevice(a.id, d.id);
                        setDevices(await api.devices(a.id));
                      }, `${d.name} removed. It cannot sync any more.`)
                    }
                  >
                    Remove
                  </button>
                )}
              </li>
            ))}
          </ul>
          <label>
            Space on the server
            <select
              value={QUOTAS_MB.includes(a.quotaBytes / 1_048_576) ? a.quotaBytes / 1_048_576 : ""}
              onChange={(e) =>
                void act(() => api.setQuota(a.id, Number(e.target.value) * 1_048_576), `${a.displayName} now has ${mb(Number(e.target.value) * 1_048_576)}.`)
              }
            >
              {!QUOTAS_MB.includes(a.quotaBytes / 1_048_576) && <option value="">{mb(a.quotaBytes)}</option>}
              {QUOTAS_MB.map((q) => (
                <option key={q} value={q}>
                  {mb(q * 1_048_576)}
                </option>
              ))}
            </select>
          </label>
          {!self && (
            <div className="actions">
              <button
                type="button"
                className="secondary"
                onClick={() =>
                  void act(
                    () => api.setSuspended(a.id, a.suspendedAt === null),
                    a.suspendedAt === null ? `${a.displayName} is suspended: no sign-in or sync, nothing deleted.` : `${a.displayName} can sync again.`,
                  )
                }
              >
                {a.suspendedAt === null ? "Suspend" : "Reactivate"}
              </button>
            </div>
          )}
        </div>
      )}
    </li>
  );
}

/** The admin MCP server for Claude: where to add it, and the sign-ins it holds. */
function ClaudeConnector({ url, grants, onDisconnect }: { url: string; grants: McpGrant[]; onDisconnect: (g: McpGrant) => void }) {
  return (
    <section className="card">
      <h2>Claude admin connector</h2>
      <p className="muted small">
        Let Claude manage invites, accounts and devices for you: in Claude, Settings &gt; Connectors &gt; Add custom connector, with this address. It asks you
        to sign in here as an admin. Claude never sees anyone's health data: these tools cannot reach it.
      </p>
      <p>
        <code>{url}</code>
      </p>
      <GrantList grants={grants} onDisconnect={onDisconnect} />
    </section>
  );
}
