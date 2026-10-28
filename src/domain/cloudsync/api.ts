import type {
  AccountKeys,
  AdminAccount,
  AdminDevice,
  AdminInvite,
  AuditEntry,
  ServiceHealth,
  DeviceKind,
  Friend,
  Joined,
  Me,
  PairingStatus,
  PullResult,
  PushResult,
  RecoveryStart,
  RecoveryUpdateBody,
  Share,
  ShareKind,
  ShareRow,
  ShareRowsResult,
  SyncRow,
} from "../../core/syncWire";
import type { SyncTransport } from "./cloudSync";

export class SyncHttpError extends Error {
  constructor(
    readonly status: number,
    serverMessage?: string,
  ) {
    super(
      serverMessage && serverMessage !== "server error"
        ? serverMessage
        : status === 401
          ? "The sync server does not know this device any more. Connect it again."
          : status === 0
            ? "The sync server could not be reached. Check the connection and the server address."
            : `The sync server answered HTTP ${status}`,
    );
    this.name = "SyncHttpError";
  }
}

export interface Device {
  name: string;
  kind: DeviceKind;
}

/**
 * The sync server's API (server/app.ts). `fetchFn` is injected: on the phone the native HTTP of
 * src/platform (no WebView CORS), in the browser and in scripts the global fetch, in tests the
 * Hono app itself. Tokens go in headers only, never in a URL. `baseUrl` "" means the same origin
 * (the web app, which Vercel and the dev server route /v1 for).
 */
export function syncApi(baseUrl: string, fetchFn: typeof fetch = (...a) => fetch(...a), token?: string) {
  const base = baseUrl.replace(/\/+$/, "");
  async function call<T>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
    let res: Response;
    try {
      res = await fetchFn(`${base}${path}`, {
        method,
        headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw new SyncHttpError(0);
    }
    const data = (await res.json().catch(() => null)) as (T & { error?: string }) | null;
    if (!res.ok) throw new SyncHttpError(res.status, data?.error);
    return data as T;
  }
  const page = (after: number, limit: number) => `after=${after}&limit=${limit}`;
  return {
    withToken: (t: string) => syncApi(baseUrl, fetchFn, t),
    health: () => call<{ ok: boolean }>("GET", "/health"),

    signup: (b: { inviteCode: string; email: string; displayName: string; device: Device; keys: AccountKeys }) => call<Joined>("POST", "/v1/auth/signup", b),
    recoveryStart: (email: string) => call<RecoveryStart>("POST", "/v1/auth/recovery/start", { email }),
    recoveryFinish: (email: string, verifier: string, device: Device) => call<Joined>("POST", "/v1/auth/recovery/finish", { email, verifier, device }),
    pairingStart: (ephemeralPublic: string, tokenHash: string, device: Device) =>
      call<{ id: string; expiresAt: number }>("POST", "/v1/pairings", { ephemeralPublic, tokenHash, device }),
    pairingStatus: (id: string, pairingToken: string) =>
      call<PairingStatus>("GET", `/v1/pairings/${encodeURIComponent(id)}`, undefined, { "x-pairing-token": pairingToken }),

    me: () => call<Me>("GET", "/v1/me"),
    setDisplayName: (displayName: string) => call<{ ok: true }>("PUT", "/v1/me", { displayName }),
    deleteAccount: () => call<{ ok: true }>("DELETE", "/v1/me"),
    updateRecovery: (b: RecoveryUpdateBody) => call<{ ok: true }>("PUT", "/v1/me/recovery", b),
    linkGoogle: (idToken: string) => call<{ ok: true }>("POST", "/v1/me/google", { idToken }),
    revokeDevice: (id: string) => call<{ ok: true }>("DELETE", `/v1/devices/${encodeURIComponent(id)}`),
    pairingInfo: (id: string) =>
      call<{ ephemeralPublic: string; deviceName: string; deviceKind: string }>("GET", `/v1/pairings/${encodeURIComponent(id)}/info`),
    pairingApprove: (id: string, sealed: string) => call<{ deviceId: string }>("POST", `/v1/pairings/${encodeURIComponent(id)}/approve`, { sealed }),

    push: (rows: SyncRow[]) => call<PushResult>("POST", "/v1/push", { rows }),
    pull: (after: number, limit: number) => call<PullResult>("GET", `/v1/pull?${page(after, limit)}`),

    friends: () => call<Friend[]>("GET", "/v1/friends"),
    friendInvite: () => call<{ code: string; expiresAt: number }>("POST", "/v1/friends/invites"),
    acceptFriend: (code: string) => call<Friend>("POST", "/v1/friends/accept", { code }),
    removeFriend: (id: string) => call<{ ok: true }>("DELETE", `/v1/friends/${encodeURIComponent(id)}`),
    shares: () => call<{ outgoing: Share[]; incoming: Share[] }>("GET", "/v1/shares"),
    share: (friendId: string, kind: ShareKind, wrappedKey: string) => call<Share>("PUT", "/v1/shares", { friendId, kind, wrappedKey }),
    unshare: (id: string) => call<{ ok: true }>("DELETE", `/v1/shares/${encodeURIComponent(id)}`),
    pushShareRows: (id: string, rows: ShareRow[]) => call<{ accepted: number }>("POST", `/v1/shares/${encodeURIComponent(id)}/rows`, { rows }),
    pullShareRows: (id: string, after: number, limit: number) =>
      call<ShareRowsResult>("GET", `/v1/shares/${encodeURIComponent(id)}/rows?${page(after, limit)}`),

    // Admin (an admin account's device only; docs/users.md section 2.6)
    admin: {
      health: () => call<ServiceHealth>("GET", "/v1/admin/health"),
      invites: () => call<AdminInvite[]>("GET", "/v1/admin/invites"),
      createInvite: (email: string, days?: number) => call<{ code: string; invite: AdminInvite }>("POST", "/v1/admin/invites", { email, days }),
      cancelInvite: (id: string) => call<{ ok: true }>("DELETE", `/v1/admin/invites/${encodeURIComponent(id)}`),
      accounts: () => call<AdminAccount[]>("GET", "/v1/admin/accounts"),
      setQuota: (accountId: string, bytes: number) => call<{ ok: true }>("PUT", `/v1/admin/accounts/${encodeURIComponent(accountId)}/quota`, { bytes }),
      setSuspended: (accountId: string, suspended: boolean) =>
        call<{ ok: true }>("PUT", `/v1/admin/accounts/${encodeURIComponent(accountId)}/suspended`, { suspended }),
      devices: (accountId: string) => call<AdminDevice[]>("GET", `/v1/admin/accounts/${encodeURIComponent(accountId)}/devices`),
      revokeDevice: (accountId: string, deviceId: string) =>
        call<{ ok: true }>("DELETE", `/v1/admin/accounts/${encodeURIComponent(accountId)}/devices/${encodeURIComponent(deviceId)}`),
      audit: () => call<AuditEntry[]>("GET", "/v1/admin/audit"),
    },
  };
}

export type SyncApi = ReturnType<typeof syncApi>;

/** The push and pull a sync needs, from a signed-in API. */
export const transportOf = (api: SyncApi): SyncTransport => ({ push: api.push, pull: api.pull });
