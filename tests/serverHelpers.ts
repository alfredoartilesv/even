import { createApp } from "../server/app";
import { AuthError } from "../server/accounts";
import { migrateServer } from "../server/migrate";
import { pglitePg } from "../server/db";
import { createStores } from "../server/stores";

/** Google stands in: a token "google:<subject>:<email>" is valid, anything else is not. */
async function fakeGoogle(idToken: string) {
  const [tag, subject, email] = idToken.split(":");
  if (tag !== "google" || !subject || !email) throw new AuthError(401, "Google did not confirm this account");
  return { subject, email };
}

/** A migrated server: the Hono app, its stores, and a fetch that calls the app in-process. Rate limits off unless asked for; Garmin is garminFetch. */
export async function testServer(opts: { rateLimits?: boolean; garminFetch?: typeof fetch } = {}) {
  const pg = await pglitePg(); // in memory
  await migrateServer(pg);
  const stores = createStores(pg, { SERVER_SECRET: "test-secret" }, { google: fakeGoogle, rateLimits: opts.rateLimits ?? false });
  const app = createApp(stores, { garminFetch: opts.garminFetch });
  const fetchFn = ((input: string, init?: RequestInit) => app.request(input, init)) as typeof fetch;
  return { pg, stores, app, fetchFn, base: "http://sync.test" };
}

export const CLAUDE_CALLBACK = "https://claude.ai/api/mcp/auth_callback";
const b64url = (bytes: ArrayBuffer) => Buffer.from(bytes).toString("base64url");

/** What claude.ai does against the OAuth endpoints and the MCP servers, on a test server. */
export function claudeClient(server: { app: { request: (url: string, init?: RequestInit) => Response | Promise<Response> }; base: string }) {
  const req = async (path: string, init?: RequestInit) => server.app.request(`${server.base}${path}`, init);
  const form = (fields: Record<string, string>) => ({
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields).toString(),
  });
  let rpcId = 0;
  const rpc = async (path: string, token: string | null, method: string, params: Record<string, unknown> = {}) => {
    const res = await req(path, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
    });
    return {
      status: res.status,
      headers: res.headers,
      body: res.status === 200 ? ((await res.json()) as { result?: Record<string, unknown>; error?: unknown }) : null,
    };
  };
  return {
    req,
    form,
    rpc,
    async call(path: string, token: string, name: string, args: Record<string, unknown> = {}) {
      const r = await rpc(path, token, "tools/call", { name, arguments: args });
      const result = r.body?.result as { content: { text: string }[]; isError?: boolean };
      return { isError: result.isError === true, text: result.content[0]!.text };
    },
    async register(): Promise<string> {
      const res = await req("/oauth/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ client_name: "Claude", redirect_uris: [CLAUDE_CALLBACK] }),
      });
      if (res.status !== 201) throw new Error(`register: ${res.status}`);
      return ((await res.json()) as { client_id: string }).client_id;
    },
    /** A PKCE pair. */
    async pkce(): Promise<{ verifier: string; challenge: string }> {
      const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)).buffer);
      return { verifier, challenge: b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))) };
    },
    async exchange(clientId: string, code: string, verifier: string) {
      const res = await req(
        "/oauth/token",
        form({ grant_type: "authorization_code", code, client_id: clientId, redirect_uri: CLAUDE_CALLBACK, code_verifier: verifier }),
      );
      return { res, tokens: res.ok ? ((await res.json()) as { access_token: string; refresh_token: string; expires_in: number; scope: string }) : null };
    },
  };
}
