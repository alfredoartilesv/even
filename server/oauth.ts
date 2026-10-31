import { Hono, type Context } from "hono";
import { sha256Hex } from "../src/core/hash.js";
import { HEALTH_MCP_PATH, type McpGrant } from "../src/core/syncWire.js";
import { uuidv7 } from "../src/core/uuidv7.js";
import { open } from "../src/domain/cloudsync/seal.js";
import { AuthError, type AccountStore } from "./accounts.js";
import type { AdminStore } from "./admin.js";
import { connectorKeys, openConnectorKeys, sealConnectorKeys, syncKeysOf, type ConnectorKeys } from "./connectorKeys.js";
import type { Pg } from "./pg.js";
import type { SyncStore } from "./store.js";

/**
 * OAuth 2.1 for the MCP servers (docs/users.md sections 9 and 10), the way claude.ai's custom
 * connectors expect it: protected-resource and authorization-server metadata, Dynamic Client
 * Registration (public clients, no secret), the authorization code flow with PKCE (S256 only),
 * and rotating refresh tokens. The login page asks for the admin's email and passphrase; the
 * passphrase is turned into the same proof as passphrase sign-in in the browser and never sent.
 * Two scopes, each with its own server: `admin` (/mcp, admin accounts only) and `health` (/mcp/health,
 * any account, its own data). A token works on its own scope's server only.
 *
 * A health sign-in also brings the sync keys: the page unwraps the account data key in the browser,
 * derives the two sync keys from it and sends only those (connectorKeys.ts keeps them sealed).
 */

export const ACCESS_MS = 60 * 60_000;
export const REFRESH_MS = 30 * 86_400_000;
const CODE_MS = 2 * 60_000;
export type McpScope = "admin" | "health";
export const MCP_SCOPES: McpScope[] = ["admin", "health"];

const random = () => Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
const s256 = async (verifier: string) => Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))).toString("base64url");

/**
 * Where a code may be sent: Claude's own callbacks, or an MCP client on this machine. Registration
 * is open (Claude registers itself), so without this anyone could register their own address under
 * the name "Claude" and send an admin a sign-in link that hands them the code.
 */
const CLAUDE_HOSTS = ["claude.ai", "claude.com"];
export function allowedRedirect(uri: string): boolean {
  try {
    const u = new URL(uri);
    if (u.hash || u.username || u.password) return false;
    if (u.protocol === "https:") return CLAUDE_HOSTS.includes(u.hostname);
    return u.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
  } catch {
    return false;
  }
}

/** What a health token opens: whose data, through which grant and device, with which keys. */
export interface Connector {
  accountId: string;
  grantId: string;
  deviceId: string;
  keys: ConnectorKeys;
}

export function oauthStore(pg: Pg, opts: { serverSecret: string }) {
  const { serverSecret } = opts;

  /** New tokens for a grant. A health grant's keys are sealed again with each new token, never kept plain. */
  async function issue(grantId: string, scope: McpScope, nowMs: number, keys?: ConnectorKeys) {
    const access = random();
    const refresh = random();
    const sealed = keys
      ? [await sealConnectorKeys(keys, access, serverSecret, "access"), await sealConnectorKeys(keys, refresh, serverSecret, "refresh")]
      : [null, null];
    await pg.query(
      `UPDATE mcp_grants SET access_hash = $2, access_expires_at = $3, refresh_hash = $4, refresh_expires_at = $5, keys_access = $6, keys_refresh = $7
        WHERE id = $1`,
      [grantId, await sha256Hex(access), nowMs + ACCESS_MS, await sha256Hex(refresh), nowMs + REFRESH_MS, sealed[0], sealed[1]],
    );
    return { access_token: access, token_type: "Bearer", expires_in: ACCESS_MS / 1000, refresh_token: refresh, scope };
  }

  /** The device a health grant's changes are pushed as. It has no usable token: nothing can sign in as it. */
  async function connectorDevice(accountId: string, clientName: string, nowMs: number): Promise<string> {
    const id = uuidv7(nowMs);
    await pg.query("INSERT INTO devices (id, owner_id, name, kind, added_by, token_hash, created_at) VALUES ($1, $2, $3, 'web', 'connector', $4, $5)", [
      id,
      accountId,
      `${clientName} connector`.slice(0, 60),
      await sha256Hex(random()),
      nowMs,
    ]);
    return id;
  }

  return {
    async register(name: string, redirectUris: string[], nowMs = Date.now()): Promise<string> {
      const id = uuidv7(nowMs);
      await pg.query("INSERT INTO oauth_clients (id, name, redirect_uris, created_at) VALUES ($1, $2, $3, $4)", [
        id,
        name,
        JSON.stringify(redirectUris),
        nowMs,
      ]);
      return id;
    },

    async client(id: string): Promise<{ name: string; redirectUris: string[] } | null> {
      const [c] = await pg.query<{ name: string; redirect_uris: string }>("SELECT name, redirect_uris FROM oauth_clients WHERE id = $1", [id]);
      return c ? { name: c.name, redirectUris: JSON.parse(c.redirect_uris) as string[] } : null;
    },

    async createCode(
      o: { clientId: string; accountId: string; redirectUri: string; challenge: string; scope?: McpScope },
      nowMs = Date.now(),
    ): Promise<string> {
      const code = random();
      await pg.query(
        "INSERT INTO oauth_codes (code_hash, client_id, account_id, redirect_uri, code_challenge, expires_at, scope) VALUES ($1, $2, $3, $4, $5, $6, $7)",
        [await sha256Hex(code), o.clientId, o.accountId, o.redirectUri, o.challenge, nowMs + CODE_MS, o.scope ?? "admin"],
      );
      return code;
    },

    /** The account of a health code still waiting for its keys, or null. */
    async pendingHealthCode(code: string, clientId: string, redirectUri: string, nowMs = Date.now()): Promise<string | null> {
      const [c] = await pg.query<{ account_id: string }>(
        `SELECT account_id FROM oauth_codes
          WHERE code_hash = $1 AND client_id = $2 AND redirect_uri = $3 AND scope = 'health' AND keys_sealed IS NULL AND used_at IS NULL AND expires_at > $4`,
        [await sha256Hex(code), clientId, redirectUri, nowMs],
      );
      return c?.account_id ?? null;
    },

    /**
     * The sign-in page's second step for a health code: the keys it derived, sealed with the code.
     * Once only, for the same client and redirect, before the code is used. Returns the account.
     */
    async attachKeys(o: { code: string; clientId: string; redirectUri: string; keys: ConnectorKeys }, nowMs = Date.now()): Promise<string | null> {
      const [c] = await pg.query<{ account_id: string }>(
        `UPDATE oauth_codes SET keys_sealed = $5
          WHERE code_hash = $1 AND client_id = $2 AND redirect_uri = $3 AND scope = 'health' AND keys_sealed IS NULL AND used_at IS NULL AND expires_at > $4
          RETURNING account_id`,
        [await sha256Hex(o.code), o.clientId, o.redirectUri, nowMs, await sealConnectorKeys(o.keys, o.code, serverSecret, "code")],
      );
      return c?.account_id ?? null;
    },

    /** Code for tokens: single use, unexpired, same client and redirect, and the PKCE verifier matches. */
    async exchangeCode(o: { code: string; clientId: string; redirectUri: string; verifier: string }, nowMs = Date.now()) {
      const [c] = await pg.query<{
        account_id: string;
        client_id: string;
        redirect_uri: string;
        code_challenge: string;
        scope: McpScope;
        keys_sealed: string | null;
      }>(
        // The keys sealed with the code are cleared as it is used: a code travels in a URL, so it may
        // be kept somewhere (history, logs) long after it is spent.
        `UPDATE oauth_codes o SET used_at = $2, keys_sealed = NULL
           FROM (SELECT code_hash, keys_sealed FROM oauth_codes WHERE code_hash = $1 AND used_at IS NULL AND expires_at > $2 FOR UPDATE) old
          WHERE o.code_hash = old.code_hash
          RETURNING o.account_id, o.client_id, o.redirect_uri, o.code_challenge, o.scope, old.keys_sealed`,
        [await sha256Hex(o.code), nowMs],
      );
      if (!c || c.client_id !== o.clientId || c.redirect_uri !== o.redirectUri || c.code_challenge !== (await s256(o.verifier))) return null;
      // A health code is good only once the sign-in page has brought the keys.
      let keys: ConnectorKeys | undefined;
      if (c.scope === "health") {
        if (!c.keys_sealed) return null;
        keys = await openConnectorKeys(c.keys_sealed, o.code, serverSecret, "code");
      }
      const id = uuidv7(nowMs);
      const clientName = (await this.client(o.clientId))?.name ?? "Claude";
      const deviceId = keys ? await connectorDevice(c.account_id, clientName, nowMs) : null;
      // Placeholder hashes, replaced by issue() at once.
      await pg.query(
        `INSERT INTO mcp_grants (id, client_id, account_id, access_hash, access_expires_at, refresh_hash, refresh_expires_at, created_at, scope, device_id)
         VALUES ($1, $2, $3, $4, 0, $5, 0, $6, $7, $8)`,
        [id, o.clientId, c.account_id, `pending-a-${id}`, `pending-r-${id}`, nowMs, c.scope, deviceId],
      );
      return { accountId: c.account_id, grantId: id, scope: c.scope, tokens: await issue(id, c.scope, nowMs, keys) };
    },

    /** A refresh token is good once: it is replaced with the new access token. */
    async refresh(o: { refreshToken: string; clientId: string }, nowMs = Date.now()) {
      // Spent in the same statement that finds it, so two uses of one refresh token cannot both win.
      const [g] = await pg.query<{ id: string; client_id: string; scope: McpScope; keys_refresh: string | null }>(
        `UPDATE mcp_grants g SET refresh_hash = 'spent-' || g.id || '-' || $2::text
           FROM (SELECT id, keys_refresh FROM mcp_grants WHERE refresh_hash = $1 AND refresh_expires_at > $2 AND revoked_at IS NULL FOR UPDATE) old
          WHERE g.id = old.id
          RETURNING g.id, g.client_id, g.scope, old.keys_refresh`,
        [await sha256Hex(o.refreshToken), nowMs],
      );
      if (!g || g.client_id !== o.clientId) return null;
      if (g.scope === "health" && !g.keys_refresh) return null;
      const keys = g.keys_refresh ? await openConnectorKeys(g.keys_refresh, o.refreshToken, serverSecret, "refresh") : undefined;
      return issue(g.id, g.scope, nowMs, keys);
    },

    /** The account behind a live admin access token, or null. */
    async accountFor(accessToken: string, nowMs = Date.now()): Promise<string | null> {
      const [g] = await pg.query<{ account_id: string }>(
        "UPDATE mcp_grants SET last_used_at = $2 WHERE access_hash = $1 AND access_expires_at > $2 AND revoked_at IS NULL AND scope = 'admin' RETURNING account_id",
        [await sha256Hex(accessToken), nowMs],
      );
      return g?.account_id ?? null;
    },

    /** What a live health access token opens, or null: its device must still be there and the account not suspended. */
    async connectorFor(accessToken: string, nowMs = Date.now()): Promise<Connector | null> {
      const [g] = await pg.query<{ id: string; account_id: string; device_id: string; keys_access: string }>(
        `UPDATE mcp_grants g SET last_used_at = $2 FROM devices d, accounts a
          WHERE g.access_hash = $1 AND g.access_expires_at > $2 AND g.revoked_at IS NULL AND g.scope = 'health' AND g.keys_access IS NOT NULL
            AND d.id = g.device_id AND d.revoked_at IS NULL AND a.id = g.account_id AND a.suspended_at IS NULL
          RETURNING g.id, g.account_id, g.device_id, g.keys_access`,
        [await sha256Hex(accessToken), nowMs],
      );
      if (!g) return null;
      try {
        return {
          accountId: g.account_id,
          grantId: g.id,
          deviceId: g.device_id,
          keys: await openConnectorKeys(g.keys_access, accessToken, serverSecret, "access"),
        };
      } catch {
        // Sealed under another SERVER_SECRET: the grant cannot be used, Claude has to connect again.
        return null;
      }
    },

    async grants(accountId: string, scope: McpScope = "admin", nowMs = Date.now()): Promise<McpGrant[]> {
      const rows = await pg.query<{
        id: string;
        client_id: string;
        name: string | null;
        created_at: number;
        last_used_at: number | null;
        access_expires_at: number;
      }>(
        `SELECT g.id, g.client_id, c.name, g.created_at, g.last_used_at, g.access_expires_at
           FROM mcp_grants g LEFT JOIN oauth_clients c ON c.id = g.client_id
          WHERE g.account_id = $1 AND g.scope = $3 AND g.revoked_at IS NULL AND g.refresh_expires_at > $2 ORDER BY g.created_at DESC`,
        [accountId, nowMs, scope],
      );
      return rows.map((r) => ({
        id: r.id,
        clientId: r.client_id,
        clientName: r.name ?? "unknown client",
        createdAt: r.created_at,
        lastUsedAt: r.last_used_at,
        accessExpiresAt: r.access_expires_at,
      }));
    },

    /** Stops the grant's tokens. A health grant's sealed keys are deleted and its device removed. */
    async revoke(accountId: string, grantId: string, scope: McpScope = "admin", nowMs = Date.now()): Promise<void> {
      // Health codes not yet exchanged would otherwise keep their sealed keys until they expire.
      if (scope === "health") await pg.query("UPDATE oauth_codes SET keys_sealed = NULL WHERE account_id = $1 AND keys_sealed IS NOT NULL", [accountId]);
      const rows = await pg.query<{ device_id: string | null }>(
        `UPDATE mcp_grants SET revoked_at = $3, keys_access = NULL, keys_refresh = NULL
          WHERE id = $1 AND account_id = $2 AND scope = $4 AND revoked_at IS NULL RETURNING device_id`,
        [grantId, accountId, nowMs, scope],
      );
      if (rows.length === 0) throw new AuthError(404, "No such connection");
      if (rows[0].device_id) await pg.query("UPDATE devices SET revoked_at = $2 WHERE id = $1 AND revoked_at IS NULL", [rows[0].device_id, nowMs]);
    },
  };
}

export type OAuthStore = ReturnType<typeof oauthStore>;

/** This server's public origin: PUBLIC_URL when set (Vercel), else what the request came to. */
export function originOf(c: Context, publicUrl?: string): string {
  if (publicUrl) return publicUrl.replace(/\/+$/, "");
  const url = new URL(c.req.url);
  const proto = c.req.header("x-forwarded-proto")?.split(",")[0]?.trim() ?? url.protocol.replace(":", "");
  const host = c.req.header("x-forwarded-host")?.split(",")[0]?.trim() ?? url.host;
  return `${proto}://${host}`;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

/**
 * Which server a sign-in is for: the health connector when Claude names its address (the RFC 8707
 * resource) or its scope, else the admin server, as before the health connector existed.
 */
export function scopeOf(params: Record<string, string | undefined>): McpScope {
  let path = "";
  try {
    path = params.resource ? new URL(params.resource).pathname.replace(/\/+$/, "") : "";
  } catch {
    path = "";
  }
  return path === HEALTH_MCP_PATH || (params.scope ?? "").split(" ").includes("health") ? "health" : "admin";
}

// The admin page: the script derives the passphrase proof (keys.ts passphraseKeys) and posts only that.
const ADMIN_SCRIPT = `const f=document.getElementById("f"),b=document.getElementById("b");
const b64=(u)=>btoa(String.fromCharCode(...u));
f.addEventListener("submit",async(ev)=>{if(document.getElementById("v").value)return;ev.preventDefault();b.disabled=true;b.textContent="Checking…";
try{const email=document.getElementById("e").value.trim().toLowerCase();
const r=await fetch("/v1/auth/recovery/start",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({email})});
if(!r.ok)throw new Error("The server did not answer");const {salt,iterations}=await r.json();
const base=await crypto.subtle.importKey("raw",new TextEncoder().encode(document.getElementById("p").value.normalize("NFKC")),"PBKDF2",false,["deriveBits"]);
const bits=new Uint8Array(await crypto.subtle.deriveBits({name:"PBKDF2",hash:"SHA-256",salt:Uint8Array.from(atob(salt),(c)=>c.charCodeAt(0)),iterations},base,512));
document.getElementById("v").value=b64(bits.slice(32));document.getElementById("p").value="";f.submit();}
catch(err){b.disabled=false;b.textContent="Allow";alert(err.message);}});`;

// The health page, in two steps. 1: the proof goes to /oauth/authorize/start, which answers with a
// code and the wrapped account data key. 2: the browser unwraps it with the passphrase's other half,
// derives the two sync keys (seal.ts syncKeyBits) and posts those with the code. The passphrase and
// the account data key never leave the browser.
const HEALTH_SCRIPT = `const f=document.getElementById("f"),b=document.getElementById("b"),$=(id)=>document.getElementById(id);
const te=new TextEncoder(),b64=(u)=>btoa(String.fromCharCode(...new Uint8Array(u))),unb64=(s)=>Uint8Array.from(atob(s),(c)=>c.charCodeAt(0));
f.addEventListener("submit",async(ev)=>{if($("code").value)return;ev.preventDefault();b.disabled=true;b.textContent="Opening your keys…";
try{const email=$("e").value.trim().toLowerCase();
const r=await fetch("/v1/auth/recovery/start",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({email})});
if(!r.ok)throw new Error("The server did not answer");const {salt,iterations}=await r.json();
const base=await crypto.subtle.importKey("raw",te.encode($("p").value.normalize("NFKC")),"PBKDF2",false,["deriveBits"]);
const bits=new Uint8Array(await crypto.subtle.deriveBits({name:"PBKDF2",hash:"SHA-256",salt:unb64(salt),iterations},base,512));
const params=Object.fromEntries([...f.querySelectorAll("input[data-param]")].map((i)=>[i.name,i.value]));
const s=await fetch("/oauth/authorize/start",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({...params,email,verifier:b64(bits.slice(32))})});
const j=await s.json().catch(()=>({}));if(!s.ok)throw new Error(j.error||"Sign-in failed");
const wrap=await crypto.subtle.importKey("raw",bits.slice(0,32),"AES-GCM",false,["decrypt"]),w=unb64(j.adkWrapped);
const adk=await crypto.subtle.decrypt({name:"AES-GCM",iv:w.subarray(0,12),additionalData:te.encode("adk")},wrap,w.subarray(12));
const hk=await crypto.subtle.importKey("raw",adk,"HKDF",false,["deriveBits"]);
const key=async(info)=>b64(await crypto.subtle.deriveBits({name:"HKDF",hash:"SHA-256",salt:new Uint8Array(0),info:te.encode(info)},hk,256));
$("mac").value=await key("even-sync-key-v1");$("enc").value=await key("even-sync-row-v1");
$("tz").value=Intl.DateTimeFormat().resolvedOptions().timeZone||"UTC";$("code").value=j.code;$("p").value="";f.submit();}
catch(err){b.disabled=false;b.textContent="Allow";alert(err.message);}});`;

/** The sign-in page for either scope. */
function loginPage(o: { scope: McpScope; clientName: string; params: Record<string, string>; error?: string; nonce: string }): string {
  const goesTo = o.params.redirect_uri ? new URL(o.params.redirect_uri).host : "";
  const hidden = Object.entries(o.params)
    .map(([k, v]) => `<input type="hidden" data-param name="${esc(k)}" value="${esc(v)}">`)
    .join("");
  const health = o.scope === "health";
  const intro = health
    ? `<h1>Even</h1><p><strong>${esc(o.clientName)}</strong> asks to read your Even data and, if you allow changes in the app, add entries to it. While it stays connected, Even's server opens your synced data to answer it.</p>
<p class="muted">What it may see is still what you allow in Even (Settings &gt; Claude connector), and everything it is sent is listed there. Disconnect it there or in Claude at any time.</p>`
    : `<h1>Even admin</h1><p><strong>${esc(o.clientName)}</strong> asks to manage Even's accounts, invites and devices as you. It cannot see anyone's health data.</p>`;
  const passphraseNote = health
    ? "Your passphrase stays in this browser: it opens your keys here, and only the two keys that read your synced data are sent."
    : "Only an admin account can allow this. Your passphrase stays in this browser: only a proof derived from it is sent.";
  const fields = health
    ? `<input type="hidden" name="code" id="code"><input type="hidden" name="mac" id="mac"><input type="hidden" name="enc" id="enc"><input type="hidden" name="tz" id="tz">`
    : `<input type="hidden" name="verifier" id="v">`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${health ? "Even sign-in" : "Even admin sign-in"}</title>
<style nonce="${o.nonce}">body{font:16px system-ui,sans-serif;max-width:26rem;margin:3rem auto;padding:0 1rem;color:#1c1917;background:#fafaf9}
label{display:block;margin:.8rem 0}input{display:block;width:100%;box-sizing:border-box;padding:.6rem;font:inherit;margin-top:.3rem}
button{padding:.7rem 1.2rem;font:inherit;background:#0f766e;color:#fff;border:0;border-radius:.5rem}.err{color:#b91c1c}.muted{color:#57534e;font-size:.9rem}</style></head>
<body>${intro}
<p class="muted">After you allow it, this browser goes back to <strong>${esc(goesTo)}</strong>. Allow only if you started this from Claude.</p>
<p class="muted">${passphraseNote}</p>
${o.error ? `<p class="err">${esc(o.error)}</p>` : ""}
<form id="f" method="post" action="/oauth/authorize">${hidden}${fields}
<label>Email<input id="e" type="email" required autocomplete="username"${health ? "" : ` name="email"`}></label>
<label>Passphrase<input id="p" type="password" required autocomplete="current-password"></label>
<button id="b" type="submit">Allow</button></form>
<script nonce="${o.nonce}">
${health ? HEALTH_SCRIPT : ADMIN_SCRIPT}
</script></body></html>`;
}

const AUTH_PARAMS = ["client_id", "redirect_uri", "code_challenge", "code_challenge_method", "state", "resource", "scope"] as const;

/** A valid IANA time zone, or null. */
function timeZoneOrNull(tz: string): string | null {
  try {
    return new Intl.DateTimeFormat("en", { timeZone: tz }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
}

/** The OAuth endpoints and metadata, routed into the sync API's app. */
export function oauthApp(
  s: { oauth: OAuthStore; accounts: AccountStore; admin: AdminStore; sync: SyncStore },
  opts: { publicUrl?: string; clientIp: (c: Context) => string },
): Hono {
  const app = new Hono();
  const resourceMeta = (path: string, scope: McpScope) => (c: Context) => {
    const origin = originOf(c, opts.publicUrl);
    return c.json({ resource: `${origin}${path}`, authorization_servers: [origin], scopes_supported: [scope], bearer_methods_supported: ["header"] });
  };
  app.get("/.well-known/oauth-protected-resource", resourceMeta("/mcp", "admin"));
  app.get("/.well-known/oauth-protected-resource/mcp", resourceMeta("/mcp", "admin"));
  app.get(`/.well-known/oauth-protected-resource${HEALTH_MCP_PATH}`, resourceMeta(HEALTH_MCP_PATH, "health"));
  app.get("/.well-known/oauth-authorization-server", (c) => {
    const origin = originOf(c, opts.publicUrl);
    return c.json({
      issuer: origin,
      authorization_endpoint: `${origin}/oauth/authorize`,
      token_endpoint: `${origin}/oauth/token`,
      registration_endpoint: `${origin}/oauth/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      scopes_supported: MCP_SCOPES,
    });
  });

  app.post("/oauth/register", async (c) => {
    await s.accounts.limit(`oauth-register:${opts.clientIp(c)}`, 20, 3_600_000, Date.now());
    const body = (await c.req.json().catch(() => null)) as { redirect_uris?: unknown; client_name?: unknown } | null;
    const uris = Array.isArray(body?.redirect_uris) ? body.redirect_uris.filter((u): u is string => typeof u === "string") : [];
    if (uris.length === 0 || uris.length > 10 || !uris.every(allowedRedirect)) {
      return c.json(
        { error: "invalid_redirect_uri", error_description: "redirect_uris must be Claude's callback (claude.ai, claude.com) or http on localhost" },
        400,
      );
    }
    const name = typeof body?.client_name === "string" && body.client_name.trim() ? body.client_name.trim().slice(0, 80) : "MCP client";
    const id = await s.oauth.register(name, uris);
    return c.json(
      {
        client_id: id,
        client_id_issued_at: Math.floor(Date.now() / 1000),
        client_name: name,
        redirect_uris: uris,
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      },
      201,
    );
  });

  /** The client and redirect must match a registration before anything is shown or redirected. */
  async function checkRequest(params: Record<string, string>) {
    const client = params.client_id ? await s.oauth.client(params.client_id) : null;
    if (!client || !params.redirect_uri || !client.redirectUris.includes(params.redirect_uri)) return { error: "Unknown client or redirect address" } as const;
    if (!params.code_challenge || params.code_challenge_method !== "S256") return { error: "PKCE (S256) is required" } as const;
    return { client } as const;
  }

  const page = (c: Context, params: Record<string, string>, clientName: string, error?: string, status: 200 | 400 | 401 | 403 | 429 = 200) => {
    const nonce = random();
    const redirectOrigin = params.redirect_uri ? new URL(params.redirect_uri).origin : "";
    c.header(
      "content-security-policy",
      `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; form-action 'self' ${redirectOrigin}; frame-ancestors 'none'; base-uri 'none'`,
    );
    c.header("cache-control", "no-store");
    c.header("referrer-policy", "no-referrer");
    return c.html(loginPage({ scope: scopeOf(params), clientName, params, error, nonce }), status);
  };

  const redirectWithCode = (c: Context, params: Record<string, string>, code: string) => {
    const to = new URL(params.redirect_uri!);
    to.searchParams.set("code", code);
    if (params.state) to.searchParams.set("state", params.state);
    to.searchParams.set("iss", originOf(c, opts.publicUrl));
    return c.redirect(to.toString(), 302);
  };

  app.get("/oauth/authorize", async (c) => {
    const params = Object.fromEntries(AUTH_PARAMS.map((k) => [k, c.req.query(k) ?? ""]).filter(([, v]) => v));
    if (c.req.query("response_type") !== "code") return c.text("response_type must be code", 400);
    const checked = await checkRequest(params);
    if ("error" in checked) return c.text(checked.error ?? "Bad request", 400);
    return page(c, params, checked.client.name);
  });

  // The health page's first step (HEALTH_SCRIPT): the passphrase proof for a code that has no keys
  // yet, and the account data key wrapped as the account's devices keep it, for the browser to open.
  app.post("/oauth/authorize/start", async (c) => {
    const body = ((await c.req.json().catch(() => null)) ?? {}) as Record<string, unknown>;
    const str = (k: string) => (typeof body[k] === "string" ? (body[k] as string) : "");
    const params = Object.fromEntries(AUTH_PARAMS.map((k) => [k, str(k)]).filter(([, v]) => v));
    c.header("cache-control", "no-store");
    const checked = await checkRequest(params);
    if ("error" in checked || scopeOf(params) !== "health") return c.json({ error: "Unknown client or redirect address" }, 400);
    try {
      const accountId = await s.accounts.verifyPassphrase(str("email").trim().toLowerCase(), str("verifier"), opts.clientIp(c));
      const code = await s.oauth.createCode({
        clientId: params.client_id!,
        accountId,
        redirectUri: params.redirect_uri!,
        challenge: params.code_challenge!,
        scope: "health",
      });
      return c.json({ code, adkWrapped: await s.accounts.wrappedAdk(accountId) });
    } catch (err) {
      if (err instanceof AuthError) return c.json({ error: err.message }, err.status === 429 ? 429 : err.status === 403 ? 403 : 401);
      throw err;
    }
  });

  app.post("/oauth/authorize", async (c) => {
    const form = await c.req.parseBody();
    const str = (k: string) => (typeof form[k] === "string" ? (form[k] as string) : "");
    const params = Object.fromEntries(AUTH_PARAMS.map((k) => [k, str(k)]).filter(([, v]) => v));
    const checked = await checkRequest(params);
    if ("error" in checked) return c.text(checked.error ?? "Bad request", 400);
    if (scopeOf(params) === "health") {
      // The second step: the keys the page derived, for the code the first step gave it.
      const keys = connectorKeys.safeParse({ mac: str("mac"), enc: str("enc"), timeZone: timeZoneOrNull(str("tz")) ?? "UTC" });
      const accountId = keys.success ? await s.oauth.pendingHealthCode(str("code"), params.client_id!, params.redirect_uri!) : null;
      if (!keys.success || !accountId) return page(c, params, checked.client.name, "That sign-in expired. Try again.", 400);
      if (!(await opensOwnRows(s.sync, accountId, keys.data))) return page(c, params, checked.client.name, "These keys do not open this account's data.", 400);
      if (!(await s.oauth.attachKeys({ code: str("code"), clientId: params.client_id!, redirectUri: params.redirect_uri!, keys: keys.data }))) {
        return page(c, params, checked.client.name, "That sign-in expired. Try again.", 400);
      }
      return redirectWithCode(c, params, str("code"));
    }
    const email = str("email").trim().toLowerCase();
    let accountId: string;
    try {
      accountId = await s.accounts.verifyPassphrase(email, str("verifier"), opts.clientIp(c));
    } catch (err) {
      if (err instanceof AuthError) return page(c, params, checked.client.name, err.message, err.status === 429 ? 429 : err.status === 403 ? 403 : 401);
      throw err;
    }
    if (!(await s.admin.isAdmin(accountId))) return page(c, params, checked.client.name, "Only an admin account can allow this.", 403);
    const code = await s.oauth.createCode({ clientId: params.client_id!, accountId, redirectUri: params.redirect_uri!, challenge: params.code_challenge! });
    return redirectWithCode(c, params, code);
  });

  app.post("/oauth/token", async (c) => {
    const form = await c.req.parseBody();
    const str = (k: string) => (typeof form[k] === "string" ? (form[k] as string) : "");
    c.header("cache-control", "no-store");
    const bad = () => c.json({ error: "invalid_grant" }, 400);
    if (str("grant_type") === "authorization_code") {
      const res = await s.oauth.exchangeCode({
        code: str("code"),
        clientId: str("client_id"),
        redirectUri: str("redirect_uri"),
        verifier: str("code_verifier"),
      });
      if (!res) return bad();
      // The audit log is for admin actions. A health connection shows in the owner's own Settings.
      if (res.scope === "admin") await s.admin.record({ id: res.accountId, via: "mcp" }, "mcp-connect", res.accountId, { grant: res.grantId });
      return c.json(res.tokens);
    }
    if (str("grant_type") === "refresh_token") {
      const tokens = await s.oauth.refresh({ refreshToken: str("refresh_token"), clientId: str("client_id") });
      return tokens ? c.json(tokens) : bad();
    }
    return c.json({ error: "unsupported_grant_type" }, 400);
  });
  return app;
}

/**
 * Keys from the sign-in page must open the account's own rows: else a wrong key would be kept and
 * every tool would fail. An account with nothing synced yet has nothing to check against.
 */
async function opensOwnRows(sync: SyncStore, accountId: string, keys: ConnectorKeys): Promise<boolean> {
  const { rows } = await sync.pull(accountId, -1, 1);
  if (rows.length === 0) return true;
  try {
    await open(await syncKeysOf(keys), rows[0].tbl, rows[0].key, rows[0].blob);
    return true;
  } catch {
    return false;
  }
}
