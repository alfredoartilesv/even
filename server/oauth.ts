import { Hono, type Context } from "hono";
import { sha256Hex } from "../src/core/hash.js";
import type { McpGrant } from "../src/core/syncWire.js";
import { uuidv7 } from "../src/core/uuidv7.js";
import { AuthError, type AccountStore } from "./accounts.js";
import type { AdminStore } from "./admin.js";
import type { Pg } from "./pg.js";

/**
 * OAuth 2.1 for the admin MCP server (docs/users.md section 9), the way claude.ai's custom
 * connectors expect it: protected-resource and authorization-server metadata, Dynamic Client
 * Registration (public clients, no secret), the authorization code flow with PKCE (S256 only),
 * and rotating refresh tokens. The login page asks for the admin's email and passphrase; the
 * passphrase is turned into the same proof as passphrase sign-in in the browser and never sent.
 * Only an admin account that is not suspended gets a code, and a token reaches /mcp only.
 */

export const ACCESS_MS = 60 * 60_000;
export const REFRESH_MS = 30 * 86_400_000;
const CODE_MS = 2 * 60_000;
export const MCP_SCOPE = "admin";

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

export function oauthStore(pg: Pg) {
  async function issue(grantId: string, nowMs: number) {
    const access = random();
    const refresh = random();
    await pg.query("UPDATE mcp_grants SET access_hash = $2, access_expires_at = $3, refresh_hash = $4, refresh_expires_at = $5 WHERE id = $1", [
      grantId,
      await sha256Hex(access),
      nowMs + ACCESS_MS,
      await sha256Hex(refresh),
      nowMs + REFRESH_MS,
    ]);
    return { access_token: access, token_type: "Bearer", expires_in: ACCESS_MS / 1000, refresh_token: refresh, scope: MCP_SCOPE };
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

    async createCode(o: { clientId: string; accountId: string; redirectUri: string; challenge: string }, nowMs = Date.now()): Promise<string> {
      const code = random();
      await pg.query("INSERT INTO oauth_codes (code_hash, client_id, account_id, redirect_uri, code_challenge, expires_at) VALUES ($1, $2, $3, $4, $5, $6)", [
        await sha256Hex(code),
        o.clientId,
        o.accountId,
        o.redirectUri,
        o.challenge,
        nowMs + CODE_MS,
      ]);
      return code;
    },

    /** Code for tokens: single use, unexpired, same client and redirect, and the PKCE verifier matches. */
    async exchangeCode(o: { code: string; clientId: string; redirectUri: string; verifier: string }, nowMs = Date.now()) {
      const [c] = await pg.query<{ account_id: string; client_id: string; redirect_uri: string; code_challenge: string }>(
        "UPDATE oauth_codes SET used_at = $2 WHERE code_hash = $1 AND used_at IS NULL AND expires_at > $2 RETURNING account_id, client_id, redirect_uri, code_challenge",
        [await sha256Hex(o.code), nowMs],
      );
      if (!c || c.client_id !== o.clientId || c.redirect_uri !== o.redirectUri || c.code_challenge !== (await s256(o.verifier))) return null;
      const id = uuidv7(nowMs);
      // Placeholder hashes, replaced by issue() at once.
      await pg.query(
        `INSERT INTO mcp_grants (id, client_id, account_id, access_hash, access_expires_at, refresh_hash, refresh_expires_at, created_at)
         VALUES ($1, $2, $3, $4, 0, $5, 0, $6)`,
        [id, o.clientId, c.account_id, `pending-a-${id}`, `pending-r-${id}`, nowMs],
      );
      return { accountId: c.account_id, grantId: id, tokens: await issue(id, nowMs) };
    },

    /** A refresh token is good once: it is replaced with the new access token. */
    async refresh(o: { refreshToken: string; clientId: string }, nowMs = Date.now()) {
      const [g] = await pg.query<{ id: string; client_id: string }>(
        "SELECT id, client_id FROM mcp_grants WHERE refresh_hash = $1 AND refresh_expires_at > $2 AND revoked_at IS NULL",
        [await sha256Hex(o.refreshToken), nowMs],
      );
      if (!g || g.client_id !== o.clientId) return null;
      return issue(g.id, nowMs);
    },

    /** The account behind a live access token, or null. */
    async accountFor(accessToken: string, nowMs = Date.now()): Promise<string | null> {
      const [g] = await pg.query<{ account_id: string }>(
        "UPDATE mcp_grants SET last_used_at = $2 WHERE access_hash = $1 AND access_expires_at > $2 AND revoked_at IS NULL RETURNING account_id",
        [await sha256Hex(accessToken), nowMs],
      );
      return g?.account_id ?? null;
    },

    async grants(accountId: string, nowMs = Date.now()): Promise<McpGrant[]> {
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
          WHERE g.account_id = $1 AND g.revoked_at IS NULL AND g.refresh_expires_at > $2 ORDER BY g.created_at DESC`,
        [accountId, nowMs],
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

    async revoke(accountId: string, grantId: string, nowMs = Date.now()): Promise<void> {
      const rows = await pg.query("UPDATE mcp_grants SET revoked_at = $3 WHERE id = $1 AND account_id = $2 AND revoked_at IS NULL RETURNING 1", [
        grantId,
        accountId,
        nowMs,
      ]);
      if (rows.length === 0) throw new AuthError(404, "No such connection");
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

/** The sign-in page. The script derives the passphrase proof (keys.ts passphraseKeys) and posts only that. */
function loginPage(o: { clientName: string; params: Record<string, string>; error?: string; nonce: string }): string {
  const goesTo = o.params.redirect_uri ? new URL(o.params.redirect_uri).host : "";
  const hidden = Object.entries(o.params)
    .map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`)
    .join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Even admin sign-in</title>
<style nonce="${o.nonce}">body{font:16px system-ui,sans-serif;max-width:26rem;margin:3rem auto;padding:0 1rem;color:#1c1917;background:#fafaf9}
label{display:block;margin:.8rem 0}input{display:block;width:100%;box-sizing:border-box;padding:.6rem;font:inherit;margin-top:.3rem}
button{padding:.7rem 1.2rem;font:inherit;background:#0f766e;color:#fff;border:0;border-radius:.5rem}.err{color:#b91c1c}.muted{color:#57534e;font-size:.9rem}</style></head>
<body><h1>Even admin</h1><p><strong>${esc(o.clientName)}</strong> asks to manage Even's accounts, invites and devices as you. It cannot see anyone's health data.</p>
<p class="muted">After you allow it, this browser goes back to <strong>${esc(goesTo)}</strong>. Allow only if you started this from Claude.</p>
<p class="muted">Only an admin account can allow this. Your passphrase stays in this browser: only a proof derived from it is sent.</p>
${o.error ? `<p class="err">${esc(o.error)}</p>` : ""}
<form id="f" method="post" action="/oauth/authorize">${hidden}<input type="hidden" name="verifier" id="v">
<label>Email<input name="email" id="e" type="email" required autocomplete="username"></label>
<label>Passphrase<input id="p" type="password" required autocomplete="current-password"></label>
<button id="b" type="submit">Allow</button></form>
<script nonce="${o.nonce}">
const f=document.getElementById("f"),b=document.getElementById("b");
const b64=(u)=>btoa(String.fromCharCode(...u));
f.addEventListener("submit",async(ev)=>{if(document.getElementById("v").value)return;ev.preventDefault();b.disabled=true;b.textContent="Checking…";
try{const email=document.getElementById("e").value.trim().toLowerCase();
const r=await fetch("/v1/auth/recovery/start",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({email})});
if(!r.ok)throw new Error("The server did not answer");const {salt,iterations}=await r.json();
const base=await crypto.subtle.importKey("raw",new TextEncoder().encode(document.getElementById("p").value.normalize("NFKC")),"PBKDF2",false,["deriveBits"]);
const bits=new Uint8Array(await crypto.subtle.deriveBits({name:"PBKDF2",hash:"SHA-256",salt:Uint8Array.from(atob(salt),(c)=>c.charCodeAt(0)),iterations},base,512));
document.getElementById("v").value=b64(bits.slice(32));document.getElementById("p").value="";f.submit();}
catch(err){b.disabled=false;b.textContent="Allow";alert(err.message);}});
</script></body></html>`;
}

const AUTH_PARAMS = ["client_id", "redirect_uri", "code_challenge", "code_challenge_method", "state", "resource", "scope"] as const;

/** The OAuth endpoints and metadata, routed into the sync API's app. */
export function oauthApp(
  s: { oauth: OAuthStore; accounts: AccountStore; admin: AdminStore },
  opts: { publicUrl?: string; clientIp: (c: Context) => string },
): Hono {
  const app = new Hono();
  const resourceMeta = (c: Context) => {
    const origin = originOf(c, opts.publicUrl);
    return c.json({ resource: `${origin}/mcp`, authorization_servers: [origin], scopes_supported: [MCP_SCOPE], bearer_methods_supported: ["header"] });
  };
  app.get("/.well-known/oauth-protected-resource", resourceMeta);
  app.get("/.well-known/oauth-protected-resource/mcp", resourceMeta);
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
      scopes_supported: [MCP_SCOPE],
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
    return c.html(loginPage({ clientName, params, error, nonce }), status);
  };

  app.get("/oauth/authorize", async (c) => {
    const params = Object.fromEntries(AUTH_PARAMS.map((k) => [k, c.req.query(k) ?? ""]).filter(([, v]) => v));
    if (c.req.query("response_type") !== "code") return c.text("response_type must be code", 400);
    const checked = await checkRequest(params);
    if ("error" in checked) return c.text(checked.error ?? "Bad request", 400);
    return page(c, params, checked.client.name);
  });

  app.post("/oauth/authorize", async (c) => {
    const form = await c.req.parseBody();
    const str = (k: string) => (typeof form[k] === "string" ? (form[k] as string) : "");
    const params = Object.fromEntries(AUTH_PARAMS.map((k) => [k, str(k)]).filter(([, v]) => v));
    const checked = await checkRequest(params);
    if ("error" in checked) return c.text(checked.error ?? "Bad request", 400);
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
    const to = new URL(params.redirect_uri!);
    to.searchParams.set("code", code);
    if (params.state) to.searchParams.set("state", params.state);
    to.searchParams.set("iss", originOf(c, opts.publicUrl));
    return c.redirect(to.toString(), 302);
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
      await s.admin.record({ id: res.accountId, via: "mcp" }, "mcp-connect", res.accountId, { grant: res.grantId });
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
