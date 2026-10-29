import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { syncApi } from "../src/domain/cloudsync/api";
import { passphraseKeys } from "../src/domain/cloudsync/keys";
import { sessionApi } from "../src/domain/cloudsync/session";
import { firstPhone, TEST_PASSPHRASE, type Phone } from "../scripts/lib/syncScenario";
import { testServer } from "./serverHelpers";

// docs/users.md section 9: Claude as an admin through OAuth and the MCP server, never seeing data.
let server: Awaited<ReturnType<typeof testServer>>;
before(async () => {
  server = await testServer();
});
after(() => server.pg.close());

const BASE = "http://sync.test";
const CALLBACK = "https://claude.ai/api/mcp/auth_callback";
const req = (path: string, init?: RequestInit) => server.app.request(`${BASE}${path}`, init);
const form = (fields: Record<string, string>) => ({
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams(fields).toString(),
});
const newEmail = () => `${crypto.randomUUID()}@example.com`;
const b64url = (bytes: ArrayBuffer) => Buffer.from(bytes).toString("base64url");

async function account(admin: boolean): Promise<{ email: string; a: Phone }> {
  const email = newEmail();
  const a = await firstPhone(server, await server.stores.accounts.createInvite(email), email, "a");
  if (admin) await server.stores.admin.setAdmin(email, true);
  return { email, a };
}

/** What the login page's script sends: the passphrase proof, never the passphrase. */
async function proof(email: string, passphrase = TEST_PASSPHRASE): Promise<string> {
  const { salt, iterations } = await syncApi(BASE, server.fetchFn).recoveryStart(email);
  return (await passphraseKeys(passphrase, salt, iterations)).verifier;
}

async function register(): Promise<string> {
  const res = await req("/oauth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "Claude", redirect_uris: [CALLBACK] }),
  });
  assert.equal(res.status, 201);
  return ((await res.json()) as { client_id: string }).client_id;
}

/** The whole sign-in, as claude.ai does it. Returns the authorize answer and, when it redirected, the tokens. */
async function connect(email: string, opts: { passphrase?: string; verifierOverride?: string } = {}) {
  const clientId = await register();
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)).buffer);
  const challenge = b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  const params = { client_id: clientId, redirect_uri: CALLBACK, code_challenge: challenge, code_challenge_method: "S256", state: "xyz" };
  const page = await req(`/oauth/authorize?${new URLSearchParams({ ...params, response_type: "code" })}`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/);
  const res = await req("/oauth/authorize", form({ ...params, email, verifier: await proof(email, opts.passphrase) }));
  if (res.status !== 302) return { res, clientId };
  const to = new URL(res.headers.get("location")!);
  assert.equal(`${to.origin}${to.pathname}`, CALLBACK);
  assert.equal(to.searchParams.get("state"), "xyz");
  const code = to.searchParams.get("code")!;
  const tokenRes = await req(
    "/oauth/token",
    form({ grant_type: "authorization_code", code, client_id: clientId, redirect_uri: CALLBACK, code_verifier: opts.verifierOverride ?? verifier }),
  );
  const tokens = tokenRes.ok ? ((await tokenRes.json()) as { access_token: string; refresh_token: string; expires_in: number }) : null;
  return { res, clientId, code, verifier, tokenRes, tokens };
}

let rpcId = 0;
async function mcp(token: string | null, method: string, params: Record<string, unknown> = {}) {
  const res = await req("/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
  });
  return {
    status: res.status,
    headers: res.headers,
    body: res.status === 200 ? ((await res.json()) as { result?: Record<string, unknown>; error?: unknown }) : null,
  };
}
const callTool = async (token: string, name: string, args: Record<string, unknown> = {}) => {
  const r = await mcp(token, "tools/call", { name, arguments: args });
  const result = r.body?.result as { content: { text: string }[]; isError?: boolean };
  return { isError: result.isError === true, text: result.content[0]!.text };
};

test("metadata tells Claude where to sign in: S256 only, public clients, the /mcp resource", async () => {
  const prm = (await (await req("/.well-known/oauth-protected-resource")).json()) as { resource: string; authorization_servers: string[] };
  assert.equal(prm.resource, `${BASE}/mcp`);
  assert.deepEqual(prm.authorization_servers, [BASE]);
  const as = (await (await req("/.well-known/oauth-authorization-server")).json()) as Record<string, unknown>;
  assert.equal(as.issuer, BASE);
  assert.deepEqual(as.code_challenge_methods_supported, ["S256"]);
  assert.deepEqual(as.token_endpoint_auth_methods_supported, ["none"]);
  assert.equal(as.registration_endpoint, `${BASE}/oauth/register`);
});

test("registration takes https redirects (http only to this machine); /mcp without a token points to the metadata", async () => {
  const bad = await req("/oauth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ redirect_uris: ["http://evil.example/cb"] }),
  });
  assert.equal(bad.status, 400);
  const none = await mcp(null, "tools/list");
  assert.equal(none.status, 401);
  assert.match(none.headers.get("www-authenticate") ?? "", /resource_metadata="http:\/\/sync\.test\/\.well-known\/oauth-protected-resource"/);
});

test("an admin signs in and Claude manages invites through the tools; every change is audited as mcp", async () => {
  const { email, a } = await account(true);
  const { tokens } = await connect(email);
  assert.ok(tokens && tokens.expires_in === 3600);
  const list = await mcp(tokens.access_token, "tools/list");
  const names = (list.body!.result as { tools: { name: string }[] }).tools.map((t) => t.name).sort();
  assert.deepEqual(names, [
    "audit_log",
    "cancel_invite",
    "create_invite",
    "list_accounts",
    "list_devices",
    "list_invites",
    "revoke_device",
    "service_health",
    "set_quota",
    "suspend_account",
  ]);
  const invited = newEmail();
  const made = JSON.parse((await callTool(tokens.access_token, "create_invite", { email: invited, days: 7 })).text) as { code: string };
  assert.match(made.code, /^[0-9A-Z]{10}$/);
  await firstPhone(server, made.code, invited, "friend"); // the code works
  const accounts = await callTool(tokens.access_token, "list_accounts");
  assert.ok(accounts.text.includes(invited));
  assert.ok(!/blob|adk|identity|sealed/i.test(accounts.text), "no data, keys or shares");
  const self = await callTool(tokens.access_token, "suspend_account", { account_id: a.session.accountId, suspended: true });
  assert.ok(self.isError && /own account/.test(self.text), "errors come back as tool errors Claude can read");
  const audit = await sessionApi(a.session, server.fetchFn).admin.audit();
  const mine = audit.filter((e) => e.actor === a.session.accountId).map((e) => [e.action, e.via]);
  assert.deepEqual(mine.slice(0, 2), [
    ["create-invite", "mcp"],
    ["mcp-connect", "mcp"],
  ]);
});

test("only an admin can allow it, with the right passphrase; the passphrase itself is never sent", async () => {
  const { email } = await account(false);
  const notAdmin = await connect(email);
  assert.equal(notAdmin.res.status, 403);
  assert.match(await notAdmin.res.text(), /Only an admin account/);
  const { email: adminEmail } = await account(true);
  const wrong = await connect(adminEmail, { passphrase: "not the passphrase at all" });
  assert.equal(wrong.res.status, 401);
  const page = await (
    await req(
      `/oauth/authorize?response_type=code&client_id=${await register()}&redirect_uri=${encodeURIComponent(CALLBACK)}&code_challenge=x&code_challenge_method=S256`,
    )
  ).text();
  assert.match(page, /<input id="p" type="password"/);
  assert.doesNotMatch(page, /name="passphrase"|<input name="[^"]*" id="p"/, "the passphrase field has no name, so the form never posts it");
});

test("a code needs its PKCE verifier and works once", async () => {
  const { email } = await account(true);
  const wrong = await connect(email, { verifierOverride: "x".repeat(43) });
  assert.equal(wrong.tokenRes?.status, 400);
  const ok = await connect(email);
  const again = await req(
    "/oauth/token",
    form({ grant_type: "authorization_code", code: ok.code!, client_id: ok.clientId, redirect_uri: CALLBACK, code_verifier: ok.verifier! }),
  );
  assert.equal(again.status, 400);
});

test("refresh tokens rotate; revoking the connection or the admin role stops Claude at once", async () => {
  const { email, a } = await account(true);
  const { tokens, clientId } = await connect(email);
  const refresh = (t: string) => req("/oauth/token", form({ grant_type: "refresh_token", refresh_token: t, client_id: clientId }));
  const next = (await (await refresh(tokens!.refresh_token)).json()) as { access_token: string; refresh_token: string };
  assert.equal((await refresh(tokens!.refresh_token)).status, 400, "a used refresh token is refused");
  assert.equal((await mcp(tokens!.access_token, "tools/list")).status, 401, "the old access token goes with it");
  assert.equal((await mcp(next.access_token, "tools/list")).status, 200);

  const api = sessionApi(a.session, server.fetchFn).admin;
  const [grant] = await api.mcpGrants();
  assert.equal(grant?.clientName, "Claude");
  await api.revokeMcpGrant(grant!.id);
  assert.equal((await mcp(next.access_token, "tools/list")).status, 401);

  const second = await connect(email);
  await server.stores.admin.setAdmin(email, false);
  assert.equal((await mcp(second.tokens!.access_token, "tools/list")).status, 401);
});

test("the login page's own script turns the passphrase into the proof the server checks, and clears the field", async () => {
  const { email } = await account(true);
  const html = await (
    await req(
      `/oauth/authorize?response_type=code&client_id=${await register()}&redirect_uri=${encodeURIComponent(CALLBACK)}&code_challenge=x&code_challenge_method=S256`,
    )
  ).text();
  const script = /<script nonce="[^"]+">([\s\S]*?)<\/script>/.exec(html)![1]!;
  // Just enough of a page for the script: the form, its fields, and fetch going to this server.
  const fields: Record<string, { value: string; disabled?: boolean; textContent?: string }> = {
    e: { value: ` ${email.toUpperCase()} ` },
    p: { value: TEST_PASSPHRASE },
    v: { value: "" },
    b: { value: "" },
  };
  let onSubmit: ((ev: { preventDefault(): void }) => Promise<void>) | null = null;
  let submitted = false;
  const f = { addEventListener: (_: string, fn: typeof onSubmit) => (onSubmit = fn), submit: () => (submitted = true) };
  const document = { getElementById: (id: string) => (id === "f" ? f : fields[id]) };
  const pageFetch = (path: string, init: RequestInit) => req(path, init);
  new Function("document", "fetch", "alert", script)(document, pageFetch, (m: string) => assert.fail(m));
  await onSubmit!({ preventDefault() {} });
  assert.ok(submitted);
  assert.equal(fields.v!.value, await proof(email));
  assert.equal(fields.p!.value, "", "the passphrase is cleared before the form goes");
});

test("codes only go to Claude's callbacks or this machine: a look-alike client cannot register its own address", async () => {
  for (const uri of ["https://evil.example/cb", "https://claude.ai.evil.example/cb", "https://user@claude.ai/cb", "http://claude.ai/cb"]) {
    const res = await req("/oauth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_name: "Claude", redirect_uris: [uri] }),
    });
    assert.equal(res.status, 400, uri);
  }
  for (const uri of ["https://claude.com/api/mcp/auth_callback", "http://localhost:6274/oauth/callback"]) {
    const res = await req("/oauth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: [uri] }),
    });
    assert.equal(res.status, 201, uri);
  }
  const page = await (
    await req(
      `/oauth/authorize?response_type=code&client_id=${await register()}&redirect_uri=${encodeURIComponent(CALLBACK)}&code_challenge=x&code_challenge_method=S256`,
    )
  ).text();
  assert.match(page, /goes back to <strong>claude\.ai<\/strong>/);
});
