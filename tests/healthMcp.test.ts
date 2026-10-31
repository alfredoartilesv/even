import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { localDay } from "../src/core/tz";
import { listAgentActions, undoAgentAction } from "../src/domain/chat/actions";
import { recordConsent, type ConnectorScope, type ConsentScope } from "../src/domain/chat/consent";
import { listDisclosures } from "../src/domain/chat/store";
import { syncApi } from "../src/domain/cloudsync/api";
import { aesOpen, fromHex, passphraseKeys } from "../src/domain/cloudsync/keys";
import { open, seal, syncKeyBits, syncKeys, syncKeysFromBits, toB64 } from "../src/domain/cloudsync/seal";
import { addFood, firstPhone, TEST_PASSPHRASE, type Phone } from "../scripts/lib/syncScenario";
import { claudeClient, CLAUDE_CALLBACK, testServer } from "./serverHelpers";

// docs/users.md section 10: Claude's own apps read and add to the owner's data through the health
// connector, with the phone's consents, its disclosure log and its undo.
let server: Awaited<ReturnType<typeof testServer>>;
let client: ReturnType<typeof claudeClient>;
before(async () => {
  server = await testServer();
  client = claudeClient(server);
});
after(() => server.pg.close());

const BASE = "http://sync.test";
const HEALTH = "/mcp/health";
const TZ = "Europe/Madrid";
const newEmail = () => `${crypto.randomUUID()}@example.com`;

async function owner(): Promise<{ email: string; phone: Phone }> {
  const email = newEmail();
  const phone = await firstPhone(server, await server.stores.accounts.createInvite(email), email, "phone");
  return { email, phone };
}

async function allow(phone: Phone, ...scopes: (ConsentScope | ConnectorScope)[]): Promise<void> {
  for (const s of scopes) await recordConsent(phone.db, s, true, phone.name);
  await phone.sync();
}

/**
 * The health sign-in as claude.ai and the page's script (server/oauth.ts HEALTH_SCRIPT) do it: the
 * proof to /oauth/authorize/start, the wrapped key opened here, only the two sync keys posted back.
 * `keys` replaces what the page would send.
 */
async function connect(email: string, opts: { keys?: { mac: string; enc: string }; passphrase?: string } = {}) {
  const clientId = await client.register();
  const { verifier, challenge } = await client.pkce();
  const params = {
    client_id: clientId,
    redirect_uri: CLAUDE_CALLBACK,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "s",
    resource: `${BASE}${HEALTH}`,
  };
  const page = await client.req(`/oauth/authorize?${new URLSearchParams({ ...params, response_type: "code" })}`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /opens your synced data/);
  const { salt, iterations } = await syncApi(BASE, server.fetchFn).recoveryStart(email);
  const pass = await passphraseKeys(opts.passphrase ?? TEST_PASSPHRASE, salt, iterations);
  const start = await client.req("/oauth/authorize/start", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...params, email, verifier: pass.verifier }),
  });
  if (start.status !== 200) return { start, clientId };
  const { code, adkWrapped } = (await start.json()) as { code: string; adkWrapped: string };
  const bits = await syncKeyBits(await aesOpen(pass.wrap, adkWrapped, "adk"));
  const keys = opts.keys ?? { mac: toB64(bits.mac), enc: toB64(bits.enc) };
  const res = await client.req("/oauth/authorize", client.form({ ...params, code, ...keys, tz: TZ }));
  if (res.status !== 302) return { start, res, clientId, code, verifier };
  const back = new URL(res.headers.get("location")!);
  assert.equal(back.searchParams.get("code"), code);
  const { res: tokenRes, tokens } = await client.exchange(clientId, code, verifier);
  return { start, res, clientId, code, verifier, tokenRes, tokens };
}

const call = (token: string, name: string, args: Record<string, unknown> = {}) => client.call(HEALTH, token, name, args);

test("the browser's two sync keys seal and open rows exactly as the account data key does", async () => {
  const secret = crypto.getRandomValues(new Uint8Array(32));
  const full = await syncKeys(secret);
  const fromBits = await syncKeysFromBits(await syncKeyBits(secret));
  const blob = await seal(full, "food_entries", "k", { c: ["id"], v: ["x"] });
  assert.deepEqual(await open(fromBits, "food_entries", "k", blob), { c: ["id"], v: ["x"] });
  assert.deepEqual(await open(full, "food_entries", "k", await seal(fromBits, "food_entries", "k", { c: ["id"], v: ["y"] })), { c: ["id"], v: ["y"] });
});

test("Claude finds the health connector's own sign-in: its resource, scope and a 401 that points there", async () => {
  const prm = (await (await client.req(`/.well-known/oauth-protected-resource${HEALTH}`)).json()) as { resource: string; scopes_supported: string[] };
  assert.equal(prm.resource, `${BASE}${HEALTH}`);
  assert.deepEqual(prm.scopes_supported, ["health"]);
  const none = await client.rpc(HEALTH, null, "tools/list");
  assert.equal(none.status, 401);
  assert.match(none.headers.get("www-authenticate") ?? "", /oauth-protected-resource\/mcp\/health"/);
});

test("any account connects; the server keeps only hashes and sealed keys, and lists the phone's tools", async () => {
  const { email, phone } = await owner();
  await addFood(phone, "f1", "oats", 380, Date.now());
  await phone.sync();
  const { tokens } = await connect(email);
  assert.ok(tokens);
  assert.equal(tokens.scope, "health");
  const list = await client.rpc(HEALTH, tokens.access_token, "tools/list");
  const names = (list.body!.result as { tools: { name: string; annotations: { readOnlyHint: boolean } }[] }).tools;
  assert.equal(names[0].name, "get_context");
  for (const n of ["list_metrics", "nutrition_summary", "list_food_entries", "log_food", "add_day_note"])
    assert.ok(
      names.some((t) => t.name === n),
      n,
    );
  assert.equal(names.find((t) => t.name === "log_food")?.annotations.readOnlyHint, false, "Claude asks before a change");
  // Nothing in Postgres opens the keys: not the token, not the keys themselves.
  const [g] = await server.pg.query<Record<string, string>>("SELECT * FROM mcp_grants WHERE account_id = $1", [phone.session.accountId]);
  const bits = await syncKeyBits(fromHex(phone.session.adk));
  for (const v of Object.values(g)) {
    assert.ok(!String(v).includes(tokens.access_token) && !String(v).includes(toB64(bits.enc)) && !String(v).includes(toB64(bits.mac)));
  }
  assert.ok(g.keys_access && g.keys_refresh);
  const [d] = await server.pg.query<{ added_by: string }>("SELECT added_by FROM devices WHERE id = $1", [g.device_id]);
  assert.equal(d.added_by, "connector");
});

test("nothing is read until the owner turns the connector on in the app; then each kind needs its own consent", async () => {
  const { email, phone } = await owner();
  const now = Date.now();
  await addFood(phone, "f1", "porridge", 410, now);
  await phone.sync();
  const { tokens } = await connect(email);
  const off = await call(tokens!.access_token, "nutrition_summary", { from: localDay(now, "UTC"), to: localDay(now, "UTC") });
  assert.ok(off.isError);
  assert.match(off.text, /Claude connector/);

  await allow(phone, "claude.connector", "claude.aggregates");
  const ctx = await call(tokens!.access_token, "get_context");
  assert.ok(!ctx.isError, ctx.text);
  assert.match(ctx.text, /time zone Europe\/Madrid/);
  const raw = await call(tokens!.access_token, "list_food_entries", { from: localDay(now, "UTC"), to: localDay(now, "UTC") });
  assert.ok(raw.isError);
  assert.match(raw.text, /claude\.raw_series/);
  await allow(phone, "claude.raw_series");
  const entries = await call(tokens!.access_token, "list_food_entries", { from: localDay(now, "UTC"), to: localDay(now, "UTC") });
  assert.ok(!entries.isError, entries.text);
  assert.match(entries.text, /porridge/);

  // What was sent reaches the phone's "Sent to Claude" list, as the connector's.
  await phone.sync();
  const sent = await listDisclosures(phone.db);
  assert.deepEqual(sent.map((d) => d.toolName).sort(), ["get_context", "list_food_entries"]);
  assert.ok(sent.every((d) => d.summary.startsWith("Connector: ") && d.conversationId === null));
});

test("changes need their own consent, sync to the phone, are logged and can be undone there", async () => {
  const { email, phone } = await owner();
  await allow(phone, "claude.connector", "claude.aggregates");
  const { tokens } = await connect(email);
  const today = localDay(Date.now(), TZ);
  const note = { day: today, mood: 4, energy: 3, note: "Slept well" };
  const refused = await call(tokens!.access_token, "add_day_note", note);
  assert.ok(refused.isError);
  assert.match(refused.text, /changes/);

  await allow(phone, "claude.connector_changes");
  const saved = await call(tokens!.access_token, "add_day_note", note);
  assert.ok(!saved.isError, saved.text);
  assert.match(saved.text, /"status":"saved"/);
  await phone.sync();
  const [row] = await phone.db.all<{ body: string; deleted_at: number | null }>("SELECT body, deleted_at FROM day_notes WHERE local_day = ?", [today]);
  assert.equal(row.body, "Slept well");
  const [action] = await listAgentActions(phone.db);
  assert.equal(action.tool, "add_day_note");
  assert.equal(action.status, "applied");
  await undoAgentAction(phone.db, action.id);
  const [gone] = await phone.db.all<{ deleted_at: number | null }>("SELECT deleted_at FROM day_notes WHERE local_day = ?", [today]);
  assert.notEqual(gone.deleted_at, null);
  // The undo reaches the connector's copy on its next call: the day is free again.
  await phone.sync();
  const again = await call(tokens!.access_token, "add_day_note", { ...note, note: "Second try" });
  assert.ok(!again.isError, again.text);
});

test("keys that do not open the account's rows, or a code without keys, are refused", async () => {
  const { email, phone } = await owner();
  await addFood(phone, "f1", "toast", 200, Date.now());
  await phone.sync();
  const wrong = toB64(crypto.getRandomValues(new Uint8Array(32)));
  const bad = await connect(email, { keys: { mac: wrong, enc: wrong } });
  assert.equal(bad.res?.status, 400);
  assert.match(await bad.res!.text(), /do not open/);
  // The code from the first step alone is worth nothing.
  const { res: tokenRes } = await client.exchange(bad.clientId, bad.code!, bad.verifier!);
  assert.equal(tokenRes.status, 400);
  const wrongPass = await connect(email, { passphrase: "not the passphrase at all" });
  assert.equal(wrongPass.start.status, 401);
});

test("tokens are scoped: admin tokens cannot reach the health connector, health tokens not the admin server", async () => {
  const { email, phone } = await owner();
  await allow(phone, "claude.connector", "claude.aggregates");
  const { tokens } = await connect(email);
  assert.equal((await client.rpc("/mcp", tokens!.access_token, "tools/list")).status, 401);
  await server.stores.admin.setAdmin(email, true);
  const clientId = await client.register();
  const { verifier, challenge } = await client.pkce();
  const code = await server.stores.oauth.createCode({ clientId, accountId: phone.session.accountId, redirectUri: CLAUDE_CALLBACK, challenge });
  const { tokens: admin } = await client.exchange(clientId, code, verifier);
  assert.equal(admin!.scope, "admin");
  assert.equal((await client.rpc("/mcp", admin!.access_token, "tools/list")).status, 200);
  assert.equal((await client.rpc(HEALTH, admin!.access_token, "tools/list")).status, 401);
});

test("a refreshed token still opens the data; disconnecting in the app stops it and removes its device", async () => {
  const { email, phone } = await owner();
  await allow(phone, "claude.connector", "claude.aggregates");
  const { tokens, clientId } = await connect(email);
  const refreshed = await client.req("/oauth/token", client.form({ grant_type: "refresh_token", refresh_token: tokens!.refresh_token, client_id: clientId }));
  const next = (await refreshed.json()) as { access_token: string };
  assert.ok(!(await call(next.access_token, "list_metrics")).isError);
  assert.equal((await client.rpc(HEALTH, tokens!.access_token, "tools/list")).status, 401, "the old access token is gone");

  const api = syncApi(BASE, server.fetchFn, phone.session.token);
  const grants = await api.connectorGrants();
  assert.equal(grants.length, 1);
  await api.revokeConnectorGrant(grants[0].id);
  assert.equal((await client.rpc(HEALTH, next.access_token, "tools/list")).status, 401);
  const [g] = await server.pg.query<{ keys_access: string | null; device_id: string }>("SELECT keys_access, device_id FROM mcp_grants WHERE id = $1", [
    grants[0].id,
  ]);
  assert.equal(g.keys_access, null, "its sealed keys are deleted");
  const [d] = await server.pg.query<{ revoked_at: number | null }>("SELECT revoked_at FROM devices WHERE id = $1", [g.device_id]);
  assert.notEqual(d.revoked_at, null);
});

test("the code's copy of the keys is cleared once used, and a refresh token works once only", async () => {
  const { email, phone } = await owner();
  await allow(phone, "claude.connector", "claude.aggregates");
  const { tokens, clientId } = await connect(email);
  const codes = await server.pg.query<{ keys_sealed: string | null }>("SELECT keys_sealed FROM oauth_codes WHERE account_id = $1", [phone.session.accountId]);
  assert.ok(codes.length > 0 && codes.every((c) => c.keys_sealed === null));
  const refresh = () => client.req("/oauth/token", client.form({ grant_type: "refresh_token", refresh_token: tokens!.refresh_token, client_id: clientId }));
  const [first, second] = await Promise.all([refresh(), refresh()]);
  assert.deepEqual([first.status, second.status].sort(), [200, 400]);
});

test("without the summaries consent even a write tool answers nothing about existing data", async () => {
  const { email, phone } = await owner();
  await allow(phone, "claude.connector", "claude.connector_changes");
  const { tokens } = await connect(email);
  const res = await call(tokens!.access_token, "add_day_note", { day: localDay(Date.now(), TZ), mood: 3, energy: 3, note: "x" });
  assert.ok(res.isError);
  assert.match(res.text, /claude\.aggregates/);
  await phone.sync();
  assert.equal((await phone.db.all("SELECT 1 FROM day_notes")).length, 0);
});

test("removing the connector's device, or suspending the account, stops it; deleting the account removes its grants", async () => {
  const { email, phone } = await owner();
  await allow(phone, "claude.connector", "claude.aggregates");
  const api = syncApi(BASE, server.fetchFn, phone.session.token);
  const one = await connect(email);
  const [g] = await server.pg.query<{ device_id: string }>("SELECT device_id FROM mcp_grants WHERE account_id = $1", [phone.session.accountId]);
  await api.revokeDevice(g.device_id);
  assert.equal((await client.rpc(HEALTH, one.tokens!.access_token, "tools/list")).status, 401);
  assert.deepEqual(await api.connectorGrants(), [], "its grant goes with it");

  const two = await connect(email);
  await server.stores.admin.setSuspended({ id: "cli", via: "cli" }, phone.session.accountId, true);
  assert.equal((await client.rpc(HEALTH, two.tokens!.access_token, "tools/list")).status, 401);
  await server.stores.admin.setSuspended({ id: "cli", via: "cli" }, phone.session.accountId, false);

  await api.deleteAccount();
  for (const t of ["mcp_grants", "oauth_codes", "devices"]) {
    const col = t === "devices" ? "owner_id" : "account_id";
    assert.equal((await server.pg.query(`SELECT 1 FROM ${t} WHERE ${col} = $1`, [phone.session.accountId])).length, 0, t);
  }
});
