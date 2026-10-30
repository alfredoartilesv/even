import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { Hono, type Context } from "hono";
import * as z from "zod";
import { createLogger } from "../src/core/log.js";
import { INVITE_MAX_DAYS, QUOTA_MAX_BYTES, QUOTA_MIN_BYTES } from "../src/core/syncWire.js";
import { AuthError } from "./accounts.js";
import type { Actor, AdminStore } from "./admin.js";
import { originOf, type OAuthStore } from "./oauth.js";

/**
 * The admin MCP server (docs/users.md section 9): Claude, as a custom connector, manages Even with
 * the same functions as Settings > Admin. Every tool is an admin action on accounts, invites and
 * devices; none reads a row, a key or a share, so Claude never sees anyone's health data. Every
 * change lands in the audit log with via "mcp".
 *
 * Stateless Streamable HTTP (a new server per request, JSON answers): it runs as one Vercel
 * function. Requests need an OAuth access token from server/oauth.ts, for an admin account.
 */

const log = createLogger("server.mcp");
const MB = 1_048_576;

/** A tool's answer: the result as JSON text, or the error message as a tool error Claude can read. */
async function answer(fn: () => Promise<unknown>) {
  try {
    const out = await fn();
    return { content: [{ type: "text" as const, text: JSON.stringify(out ?? { ok: true }, null, 2) }] };
  } catch (err) {
    if (err instanceof AuthError) return { content: [{ type: "text" as const, text: err.message }], isError: true };
    throw err;
  }
}

export function adminMcpServer(admin: AdminStore, actor: Actor): McpServer {
  const server = new McpServer(
    { name: "even-admin", version: "1.0.0" },
    {
      instructions:
        "Manage the Even service: invites, accounts, quotas, devices, suspension, and the audit log. These tools never return health data: the server holds it sealed. Ask before suspending an account or removing a device.",
    },
  );
  const read = { readOnlyHint: true, openWorldHint: false };
  const change = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };
  const destructive = { readOnlyHint: false, destructiveHint: true, openWorldHint: false };
  const accountId = z.string().min(1).max(64).describe("The account's id, from list_accounts");

  server.registerTool(
    "service_health",
    { title: "Service health", description: "Accounts, devices, storage used and open invites, and the deployed build.", annotations: read },
    () => answer(() => admin.health()),
  );
  server.registerTool(
    "list_invites",
    { title: "List invites", description: "The latest 200 invites: email, status (open, used, expired, cancelled), dates.", annotations: read },
    () => answer(() => admin.listInvites()),
  );
  server.registerTool(
    "create_invite",
    {
      title: "Create invite",
      description: "An invite for one email. Returns the code once: give it to the person with the web address. They choose New account and use that email.",
      inputSchema: {
        email: z.string().email().max(254),
        days: z.number().int().min(1).max(INVITE_MAX_DAYS).optional().describe("Days it stays valid, 14 if left out"),
      },
      annotations: change,
    },
    ({ email, days }) => answer(() => admin.createInvite(actor, email, days)),
  );
  server.registerTool(
    "cancel_invite",
    {
      title: "Cancel invite",
      description: "An unused invite stops working at once.",
      inputSchema: { invite_id: z.string().regex(/^[0-9a-f]{64}$/) },
      annotations: change,
    },
    ({ invite_id }) => answer(() => admin.cancelInvite(actor, invite_id)),
  );
  server.registerTool(
    "list_accounts",
    {
      title: "List accounts",
      description: "Every account: name, email, devices, last seen, storage against its quota, friend count, admin, suspended. No health data.",
      annotations: read,
    },
    () => answer(() => admin.listAccounts()),
  );
  server.registerTool(
    "list_devices",
    {
      title: "List devices",
      description: "An account's phones and browsers, with when each was added, last seen and removed.",
      inputSchema: { account_id: accountId },
      annotations: read,
    },
    ({ account_id }) => answer(() => admin.listDevices(account_id)),
  );
  server.registerTool(
    "revoke_device",
    {
      title: "Remove device",
      description: "The device's access stops at once (a lost or stolen phone). Its local data stays on it.",
      inputSchema: { account_id: accountId, device_id: z.string().min(1).max(64) },
      annotations: destructive,
    },
    ({ account_id, device_id }) => answer(() => admin.revokeDevice(actor, account_id, device_id)),
  );
  server.registerTool(
    "set_quota",
    {
      title: "Set storage quota",
      description: `How much an account may store on the server, in megabytes (${QUOTA_MIN_BYTES / MB} to ${QUOTA_MAX_BYTES / MB}).`,
      inputSchema: {
        account_id: accountId,
        megabytes: z
          .number()
          .int()
          .min(QUOTA_MIN_BYTES / MB)
          .max(QUOTA_MAX_BYTES / MB),
      },
      annotations: change,
    },
    ({ account_id, megabytes }) => answer(() => admin.setQuota(actor, account_id, megabytes * MB)),
  );
  server.registerTool(
    "suspend_account",
    {
      title: "Suspend or reactivate account",
      description: "Suspended: no sign-in, pairing or sync; nothing is deleted. suspended false reactivates. You cannot suspend your own account.",
      inputSchema: { account_id: accountId, suspended: z.boolean() },
      annotations: destructive,
    },
    ({ account_id, suspended }) => answer(() => admin.setSuspended(actor, account_id, suspended)),
  );
  server.registerTool(
    "audit_log",
    {
      title: "Audit log",
      description: "The latest admin actions: who (account id or cli), through what (app, mcp, cli), on which account or invite, when.",
      inputSchema: { limit: z.number().int().min(1).max(500).optional() },
      annotations: read,
    },
    ({ limit }) => answer(() => admin.auditLog(limit)),
  );
  return server;
}

/** /mcp: a bearer token from the OAuth flow, for an admin account that is not suspended. */
export function mcpApp(s: { oauth: OAuthStore; admin: AdminStore }, opts: { publicUrl?: string }): Hono {
  const app = new Hono();
  app.all("/mcp", async (c: Context) => {
    const token = /^Bearer (\S+)$/.exec(c.req.header("authorization") ?? "")?.[1];
    const accountId = token ? await s.oauth.accountFor(token) : null;
    if (!accountId || !(await s.admin.isAdmin(accountId))) {
      // Where Claude finds how to sign in (RFC 9728).
      c.header("www-authenticate", `Bearer resource_metadata="${originOf(c, opts.publicUrl)}/.well-known/oauth-protected-resource"`);
      return c.json({ error: "unauthorized" }, 401);
    }
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    const server = adminMcpServer(s.admin, { id: accountId, via: "mcp" });
    await server.connect(transport);
    log.info("mcp request", { account: accountId, method: c.req.method });
    return transport.handleRequest(c.req.raw);
  });
  return app;
}
