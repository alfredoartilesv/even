import test from "node:test";
import assert from "node:assert/strict";
import type { HttpOptions, HttpResponse } from "@capacitor/core";
import { McpHttpCaller } from "../src/features/sync/mcpHttp";
import { makeNativeFetch } from "../src/platform/nativeFetch";

const URL_ = "https://example.test/mcp/secret-path";

test("sends JSON bodies as objects (CapacitorHttp serialises them) and returns a real Response", async () => {
  const seen: HttpOptions[] = [];
  const nf = makeNativeFetch(async (o) => {
    seen.push(o);
    return { status: 200, headers: { "content-type": "text/event-stream" }, data: 'data: {"id":1}\n\n', url: o.url };
  });
  const res = await nf(URL_, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer k" },
    body: JSON.stringify({ a: 1 }),
  });
  assert.deepEqual(seen[0].data, { a: 1 });
  assert.equal(seen[0].method, "POST");
  assert.equal(seen[0].responseType, "text");
  assert.equal(seen[0].headers?.authorization, "Bearer k");
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "text/event-stream");
  assert.equal(await res.text(), 'data: {"id":1}\n\n');
});

test("re-serialises replies the plugin already parsed, and handles empty 202/204", async () => {
  const replies: HttpResponse[] = [
    { status: 200, headers: { "content-type": "application/json" }, data: { jsonrpc: "2.0", id: 1 }, url: URL_ },
    { status: 202, headers: {}, data: "", url: URL_ },
    { status: 204, headers: {}, data: null, url: URL_ },
  ];
  const nf = makeNativeFetch(async () => replies.shift()!);
  assert.deepEqual(await (await nf(URL_)).json(), { jsonrpc: "2.0", id: 1 });
  assert.equal(await (await nf(URL_)).text(), "");
  assert.equal((await nf(URL_)).status, 204);
});

test("network failures surface as a TypeError, and McpHttpCaller's message leaks no URL", async () => {
  const nf = makeNativeFetch(async () => {
    throw new Error(`could not reach ${URL_}`);
  });
  await assert.rejects(nf(URL_), TypeError);
  const caller = new McpHttpCaller({ url: URL_, apiKey: "k", fetch: nf });
  await assert.rejects(caller.callTool("list_metrics", {}), (e: Error) => {
    assert.match(e.message, /Network error contacting freddy/);
    assert.ok(!e.message.includes("secret-path"));
    return true;
  });
});

test("McpHttpCaller works end to end over the native adapter (SSE replies)", async () => {
  const nf = makeNativeFetch(async (o) => {
    const body = o.data as { id?: number; method: string };
    if (body.id === undefined) return { status: 202, headers: {}, data: "", url: o.url };
    const result = body.method === "initialize" ? { protocolVersion: "2025-03-26" } : { content: [{ type: "text", text: "hello" }] };
    return {
      status: 200,
      headers: { "content-type": "text/event-stream" },
      data: `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: body.id, result })}\n\n`,
      url: o.url,
    };
  });
  const caller = new McpHttpCaller({ url: URL_, apiKey: "k", fetch: nf });
  assert.equal(await caller.callTool("list_metrics", {}), "hello");
});
