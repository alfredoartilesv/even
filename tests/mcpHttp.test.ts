import test from "node:test";
import assert from "node:assert/strict";
import { McpHttpCaller, McpHttpError, parseRpcBody } from "../src/sources/mcpHttp";

const URL_SECRET = "https://example.test/mcp/abc123secret";
const KEY_SECRET = "key-xyz-789";

interface Seen {
  headers: Record<string, string>;
  body: { id?: number; method: string; params?: Record<string, unknown> };
}

/** A fake server speaking freddy's observed protocol: Bearer required, replies as SSE. */
function fakeFetch(opts: { sse?: boolean; toolText?: string; isError?: boolean; rpcError?: boolean; status?: number } = {}) {
  const seen: Seen[] = [];
  const f = (async (_url: string, init: RequestInit) => {
    const headers = init.headers as Record<string, string>;
    const body = JSON.parse(String(init.body));
    seen.push({ headers, body });
    if (opts.status) return new Response("no", { status: opts.status });
    if (headers.authorization !== `Bearer ${KEY_SECRET}`) return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
    if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
    const wrap = (result: unknown) => {
      const msg = JSON.stringify(opts.rpcError ? { jsonrpc: "2.0", id: body.id, error: { code: -32000, message: "boom" } } : { jsonrpc: "2.0", id: body.id, result });
      return opts.sse === false
        ? new Response(msg, { status: 200, headers: { "content-type": "application/json" } })
        : new Response(`event: message\ndata: ${msg}\n\n`, { status: 200, headers: { "content-type": "text/event-stream" } });
    };
    if (body.method === "initialize") return wrap({ serverInfo: { name: "freddy", version: "0.2.0" } });
    return wrap({ content: [{ type: "text", text: opts.toolText ?? "hello" }], isError: opts.isError ?? false });
  }) as unknown as typeof fetch;
  return { f, seen };
}

test("calls a tool: initialize, initialized notification, then tools/call", async () => {
  const { f, seen } = fakeFetch({ toolText: "line1" });
  const c = new McpHttpCaller({ url: URL_SECRET, apiKey: KEY_SECRET, fetch: f });
  assert.equal(await c.callTool("list_metrics", {}), "line1");
  assert.deepEqual(seen.map((s) => s.body.method), ["initialize", "notifications/initialized", "tools/call"]);
  assert.deepEqual(seen[2].body.params, { name: "list_metrics", arguments: {} });
});

test("initializes only once across calls", async () => {
  const { f, seen } = fakeFetch();
  const c = new McpHttpCaller({ url: URL_SECRET, apiKey: KEY_SECRET, fetch: f });
  await c.callTool("a", {});
  await c.callTool("b", {});
  assert.equal(seen.filter((s) => s.body.method === "initialize").length, 1);
});

test("sends only the CORS-allowed custom headers (no mcp-protocol-version)", async () => {
  const { f, seen } = fakeFetch();
  await new McpHttpCaller({ url: URL_SECRET, apiKey: KEY_SECRET, fetch: f }).callTool("x", {});
  const allowed = new Set(["content-type", "accept", "authorization", "mcp-session-id"]);
  for (const s of seen) for (const h of Object.keys(s.headers)) assert.ok(allowed.has(h.toLowerCase()), `unexpected header ${h}`);
});

test("accepts plain JSON replies too", async () => {
  const { f } = fakeFetch({ sse: false, toolText: "json-ok" });
  assert.equal(await new McpHttpCaller({ url: URL_SECRET, apiKey: KEY_SECRET, fetch: f }).callTool("x", {}), "json-ok");
});

test("wrong key -> clear error, and neither URL nor key appear in it", async () => {
  const { f } = fakeFetch();
  const c = new McpHttpCaller({ url: URL_SECRET, apiKey: "wrong", fetch: f });
  await assert.rejects(c.callTool("x", {}), (e: unknown) => {
    assert.ok(e instanceof McpHttpError);
    assert.equal(e.status, 401);
    assert.match(e.message, /rejected the credentials/);
    assert.ok(!e.message.includes("abc123secret") && !e.message.includes(KEY_SECRET) && !e.message.includes("wrong"));
    return true;
  });
});

test("network failure message does not leak the URL", async () => {
  const f = (async () => {
    throw new TypeError(`fetch failed for ${URL_SECRET}`, { cause: { code: "ENOTFOUND" } });
  }) as unknown as typeof fetch;
  await assert.rejects(new McpHttpCaller({ url: URL_SECRET, apiKey: KEY_SECRET, fetch: f }).callTool("x", {}), (e: unknown) => {
    assert.match((e as Error).message, /ENOTFOUND/);
    assert.ok(!(e as Error).message.includes("abc123secret"));
    return true;
  });
});

test("tool-level isError and JSON-RPC errors become exceptions", async () => {
  await assert.rejects(
    new McpHttpCaller({ url: URL_SECRET, apiKey: KEY_SECRET, fetch: fakeFetch({ isError: true, toolText: "bad metric" }).f }).callTool("x", {}),
    /tool "x" failed: bad metric/,
  );
  await assert.rejects(
    new McpHttpCaller({ url: URL_SECRET, apiKey: KEY_SECRET, fetch: fakeFetch({ rpcError: true }).f }).callTool("x", {}),
    /initialize failed: boom/,
  );
});

test("5xx surfaces as an HTTP error and a later call can retry initialize", async () => {
  let fail = true;
  const inner = fakeFetch().f;
  const f = (async (u: string, i: RequestInit) => (fail ? new Response("x", { status: 503 }) : inner(u, i))) as unknown as typeof fetch;
  const c = new McpHttpCaller({ url: URL_SECRET, apiKey: KEY_SECRET, fetch: f });
  await assert.rejects(c.callTool("x", {}), /HTTP 503/);
  fail = false;
  assert.equal(await c.callTool("x", {}), "hello");
});

test("parseRpcBody picks the reply matching the id from a multi-event stream", () => {
  const sse = `data: {"jsonrpc":"2.0","method":"notifications/progress"}\n\ndata: {"jsonrpc":"2.0","id":7,"result":{"ok":true}}\n\n`;
  assert.deepEqual(parseRpcBody("text/event-stream; charset=utf-8", sse, 7)?.result, { ok: true });
  assert.equal(parseRpcBody("text/event-stream", sse, 8), null);
  assert.equal(parseRpcBody("application/json", "", 1), null);
});

test("empty URL is rejected up front", () => {
  assert.throws(() => new McpHttpCaller({ url: "" }), /MCP URL is empty/);
});
