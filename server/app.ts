import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { GARMIN_RELAY_PATH } from "../src/core/garminRelay.js";
import { createLogger } from "../src/core/log.js";
import {
  adminInviteBody,
  friendAcceptBody,
  googleLinkBody,
  MAX_PUSH_BYTES,
  pairingApproveBody,
  pairingStartBody,
  profileBody,
  pushBody,
  quotaBody,
  recoveryFinishBody,
  recoveryStartBody,
  recoveryUpdateBody,
  SHARE_DAYS,
  shareBody,
  shareRowsBody,
  signupBody,
  suspendBody,
  SYNC_PAGE,
  syncRow,
} from "../src/core/syncWire.js";
import { AuthError, SUSPENDED, type AccountStore } from "./accounts.js";
import type { Actor, AdminStore } from "./admin.js";
import { relayToGarmin } from "./garminRelay.js";
import { dropOwnerData, healthMcpApp } from "./healthMcp.js";
import { mcpApp } from "./mcp.js";
import { oauthApp, type OAuthStore } from "./oauth.js";
import type { FriendStore } from "./friends.js";
import type { GoogleVerifier } from "./google.js";
import type { Device, SyncStore } from "./store.js";

const log = createLogger("server");

export interface Stores {
  sync: SyncStore;
  accounts: AccountStore;
  friends: FriendStore;
  admin: AdminStore;
  oauth: OAuthStore;
  google: GoogleVerifier;
}

/**
 * The sync API (docs/architecture.md section 6, docs/users.md). The same app runs in the `sync`
 * Docker container (server/node.ts) and as a Vercel function (api/index.ts).
 *
 * No auth:   GET /health, POST /v1/auth/signup | recovery/start | recovery/finish, POST /v1/pairings,
 *            GET /v1/pairings/:id (with the new device's own token in x-pairing-token)
 * Device:    everything else, `Authorization: Bearer <device token>`; a suspended account's devices get 403
 * Garmin:    /v1/garmin/*, the web app's Garmin calls passed on to Garmin (server/garminRelay.ts)
 * Admin:     /v1/admin/*, a device of an admin account (docs/users.md section 2.6)
 * MCP:       /mcp with an OAuth access token for an admin account; /mcp/health with one of the health scope for any
 *            account (server/healthMcp.ts); /oauth/* and /.well-known/* (server/oauth.ts)
 */
type Env = { Variables: { device: Device } };

/** The client's address for rate limits: Vercel's header, else the socket the request came on. */
function clientIp(c: Context): string {
  const fwd = c.req.header("x-forwarded-for")?.split(",")[0]?.trim();
  return fwd || c.req.header("x-real-ip") || "local";
}

async function parse<T>(c: Context, schema: { safeParse(v: unknown): { success: true; data: T } | { success: false } }): Promise<T> {
  const body = schema.safeParse(await c.req.json().catch(() => null));
  if (!body.success) throw new AuthError(400, "bad request");
  return body.data;
}

const cursor = (c: Context) => {
  const after = Number(c.req.query("after") ?? -1);
  const limit = Number(c.req.query("limit") ?? SYNC_PAGE);
  if (!Number.isSafeInteger(after) || after < -1 || !Number.isInteger(limit) || limit < 1 || limit > SYNC_PAGE) throw new AuthError(400, "bad request");
  return { after, limit };
};

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

/** garminFetch stands in for Garmin in tests. */
export function createApp(s: Stores, opts: { publicUrl?: string; garminFetch?: typeof fetch } = {}) {
  const app = new Hono<Env>();

  app.get("/health", (c) => c.json({ ok: true }));
  // Claude as an admin, through its custom connector: outside /v1, with its own tokens.
  app.route("/", oauthApp(s, { publicUrl: opts.publicUrl, clientIp }));
  app.route("/", mcpApp(s, { publicUrl: opts.publicUrl }));
  app.route("/", healthMcpApp(s, { publicUrl: opts.publicUrl }));

  // ---- Joining: invite, passphrase, pairing ----
  app.post("/v1/auth/signup", async (c) => {
    const joined = await s.accounts.signup(await parse(c, signupBody), clientIp(c));
    log.info("account created", { account: joined.accountId, device: joined.deviceId });
    return c.json(joined);
  });
  app.post("/v1/auth/recovery/start", async (c) => c.json(await s.accounts.recoveryStart((await parse(c, recoveryStartBody)).email)));
  app.post("/v1/auth/recovery/finish", async (c) => {
    const b = await parse(c, recoveryFinishBody);
    const joined = await s.accounts.recoveryFinish(b.email, b.verifier, b.device, clientIp(c));
    log.info("device added by passphrase", { account: joined.accountId, device: joined.deviceId });
    return c.json(joined);
  });
  app.post("/v1/pairings", async (c) => c.json(await s.accounts.pairingStart(await parse(c, pairingStartBody), clientIp(c))));
  app.get("/v1/pairings/:id", async (c) => c.json(await s.accounts.pairingStatus(c.req.param("id"), c.req.header("x-pairing-token") ?? "")));

  // ---- Everything else needs a device ----
  app.use("/v1/*", async (c, next) => {
    const token = /^Bearer (\S+)$/.exec(c.req.header("authorization") ?? "")?.[1];
    const device = token ? await s.sync.deviceFor(token) : null;
    if (!device) return c.json({ error: "unauthorized" }, 401);
    if (device.suspended) return c.json({ error: SUSPENDED }, 403);
    c.set("device", device);
    await next();
  });

  // The browser cannot reach Garmin itself (no CORS): a device passes its Garmin calls through here.
  app.on(["GET", "POST"], `${GARMIN_RELAY_PATH}/*`, (c) => relayToGarmin(c, opts.garminFetch));

  app.get("/v1/me", async (c) => c.json(await s.accounts.me(c.get("device").ownerId, c.get("device").id)));
  app.put("/v1/me", async (c) => {
    await s.accounts.setDisplayName(c.get("device").ownerId, (await parse(c, profileBody)).displayName);
    return c.json({ ok: true });
  });
  app.delete("/v1/me", async (c) => {
    const { ownerId } = c.get("device");
    await s.accounts.deleteAccount(ownerId);
    log.info("account deleted", { account: ownerId });
    return c.json({ ok: true });
  });
  app.put("/v1/me/recovery", async (c) => {
    await s.accounts.updateRecovery(c.get("device").ownerId, await parse(c, recoveryUpdateBody));
    return c.json({ ok: true });
  });
  app.post("/v1/me/google", async (c) => {
    const { subject } = await s.google((await parse(c, googleLinkBody)).idToken);
    await s.accounts.linkGoogle(c.get("device").ownerId, subject);
    return c.json({ ok: true });
  });
  app.delete("/v1/devices/:id", async (c) => {
    await s.accounts.revokeDevice(c.get("device").ownerId, c.req.param("id"));
    log.info("device revoked", { by: c.get("device").id, device: c.req.param("id") });
    return c.json({ ok: true });
  });
  app.get("/v1/pairings/:id/info", async (c) => c.json(await s.accounts.pairingInfo(c.req.param("id"))));
  app.post("/v1/pairings/:id/approve", async (c) => {
    const { sealed } = await parse(c, pairingApproveBody);
    const res = await s.accounts.pairingApprove(c.req.param("id"), c.get("device").ownerId, sealed);
    log.info("device added by pairing", { by: c.get("device").id, device: res.deviceId });
    return c.json(res);
  });

  // The health connector's connections (docs/users.md section 10): any account sees and cuts off its own.
  app.get("/v1/connector/grants", async (c) => c.json(await s.oauth.grants(c.get("device").ownerId, "health")));
  app.delete("/v1/connector/grants/:id", async (c) => {
    await s.oauth.revoke(c.get("device").ownerId, c.req.param("id"), "health");
    dropOwnerData(c.req.param("id"));
    log.info("connector disconnected", { device: c.get("device").id, grant: c.req.param("id") });
    return c.json({ ok: true });
  });

  // ---- Sync ----
  app.post("/v1/push", bodyLimit({ maxSize: MAX_PUSH_BYTES, onError: (c) => c.json({ error: "too large" }, 413) }), async (c) => {
    const { rows } = await parse(c, pushBody);
    const device = c.get("device");
    const size = rows.reduce((n, r) => n + r.blob.length, 0);
    if (size > 0 && (await s.accounts.quotaLeft(device.ownerId)) < size)
      return c.json({ error: "Your account is full: remove photos or ask for more space" }, 507);
    const res = await s.sync.push(device, rows);
    log.info("push", { device: device.id, rows: rows.length, accepted: res.accepted });
    return c.json(res);
  });
  app.get("/v1/pull", async (c) => {
    const { after, limit } = cursor(c);
    const device = c.get("device");
    const res = await s.sync.pull(device.ownerId, after, limit);
    log.info("pull", { device: device.id, rows: res.rows.length, more: res.more });
    return c.json(res);
  });
  app.get("/v1/pull/newest", async (c) => {
    const { after, limit } = cursor(c);
    const b = c.req.query("before");
    const before = b === undefined ? null : Number(b);
    const tbl = c.req.query("tbl") ?? null;
    if ((before !== null && (!Number.isSafeInteger(before) || before <= after)) || (tbl !== null && !syncRow.shape.tbl.safeParse(tbl).success))
      throw new AuthError(400, "bad request");
    const device = c.get("device");
    const res = await s.sync.pullNewest(device.ownerId, after, before, limit, tbl);
    log.info("pull newest", { device: device.id, rows: res.rows.length, more: res.more, oneTable: tbl !== null });
    return c.json(res);
  });

  // ---- Friends and shares ----
  app.get("/v1/friends", async (c) => c.json(await s.friends.list(c.get("device").ownerId)));
  app.post("/v1/friends/invites", async (c) => c.json(await s.friends.createInvite(c.get("device").ownerId)));
  app.post("/v1/friends/accept", async (c) => {
    await s.accounts.limit(`friend-accept:${c.get("device").ownerId}`, 20, 3_600_000, Date.now());
    return c.json(await s.friends.accept(c.get("device").ownerId, (await parse(c, friendAcceptBody)).code));
  });
  app.delete("/v1/friends/:id", async (c) => {
    await s.friends.remove(c.get("device").ownerId, c.req.param("id"));
    return c.json({ ok: true });
  });
  app.get("/v1/shares", async (c) => c.json(await s.friends.shares(c.get("device").ownerId)));
  app.put("/v1/shares", async (c) => {
    const b = await parse(c, shareBody);
    return c.json(await s.friends.share(c.get("device").ownerId, b.friendId, b.kind, b.wrappedKey));
  });
  app.delete("/v1/shares/:id", async (c) => {
    await s.friends.unshare(c.get("device").ownerId, c.req.param("id"));
    return c.json({ ok: true });
  });
  app.post("/v1/shares/:id/rows", async (c) => {
    const { rows } = await parse(c, shareRowsBody);
    return c.json({ accepted: await s.friends.pushRows(c.get("device").ownerId, c.req.param("id"), rows, daysAgo(SHARE_DAYS + 1)) });
  });
  app.get("/v1/shares/:id/rows", async (c) => {
    const { after, limit } = cursor(c);
    return c.json(await s.friends.pullRows(c.get("device").ownerId, c.req.param("id"), after, limit));
  });

  // ---- Admin: who and when, never data ----
  app.use("/v1/admin/*", async (c, next) => {
    if (!(await s.admin.isAdmin(c.get("device").ownerId))) return c.json({ error: "Only an admin can do this" }, 403);
    await next();
  });
  const actor = (c: Context<Env>): Actor => ({ id: c.get("device").ownerId, via: "app" });
  app.get("/v1/admin/health", async (c) => c.json(await s.admin.health()));
  app.get("/v1/admin/invites", async (c) => c.json(await s.admin.listInvites()));
  app.post("/v1/admin/invites", async (c) => {
    const b = await parse(c, adminInviteBody);
    return c.json(await s.admin.createInvite(actor(c), b.email, b.days));
  });
  app.delete("/v1/admin/invites/:id", async (c) => {
    await s.admin.cancelInvite(actor(c), c.req.param("id"));
    return c.json({ ok: true });
  });
  app.get("/v1/admin/accounts", async (c) => c.json(await s.admin.listAccounts()));
  app.put("/v1/admin/accounts/:id/quota", async (c) => {
    await s.admin.setQuota(actor(c), c.req.param("id"), (await parse(c, quotaBody)).bytes);
    return c.json({ ok: true });
  });
  app.put("/v1/admin/accounts/:id/suspended", async (c) => {
    await s.admin.setSuspended(actor(c), c.req.param("id"), (await parse(c, suspendBody)).suspended);
    return c.json({ ok: true });
  });
  app.get("/v1/admin/accounts/:id/devices", async (c) => c.json(await s.admin.listDevices(c.req.param("id"))));
  app.delete("/v1/admin/accounts/:id/devices/:device", async (c) => {
    await s.admin.revokeDevice(actor(c), c.req.param("id"), c.req.param("device"));
    return c.json({ ok: true });
  });
  app.get("/v1/admin/audit", async (c) => c.json(await s.admin.auditLog()));
  // Claude's connections (MCP grants) of this admin: see and cut them off.
  app.get("/v1/admin/mcp-grants", async (c) => c.json(await s.oauth.grants(c.get("device").ownerId)));
  app.delete("/v1/admin/mcp-grants/:id", async (c) => {
    await s.oauth.revoke(c.get("device").ownerId, c.req.param("id"));
    await s.admin.record(actor(c), "mcp-revoke", c.get("device").ownerId, { grant: c.req.param("id") });
    return c.json({ ok: true });
  });

  app.onError((err, c) => {
    if (err instanceof AuthError) return c.json({ error: err.message }, err.status);
    log.error("request failed", { err, path: c.req.path });
    return c.json({ error: "server error" }, 500);
  });

  return app;
}
