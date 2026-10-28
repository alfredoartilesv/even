import test from "node:test";
import assert from "node:assert/strict";
import type { HttpOptions, HttpResponse } from "@capacitor/core";
import { GarminApi } from "../src/domain/sync/garmin";
import { makeNativeFetch } from "../src/platform/nativeFetch";

const URL_ = "https://example.test/api/secret-path";

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

test("network failures surface as a TypeError, and GarminApi's message leaks no URL or key", async () => {
  const nf = makeNativeFetch(async () => {
    throw new Error(`could not reach ${URL_}`);
  });
  await assert.rejects(nf(URL_), TypeError);
  const api = new GarminApi({ apiKey: "secret-key-0123456789", fetch: nf, baseUrl: URL_ });
  await assert.rejects(api.get("/userprofile-service/userprofile/settings"), (e: Error) => {
    assert.match(e.message, /Could not reach Garmin/);
    assert.ok(!e.message.includes("secret-path"));
    assert.ok(!e.message.includes("secret-key"));
    return true;
  });
});

test("GarminApi works end to end over the native adapter (plain-text token, then JSON GET)", async () => {
  const seen: HttpOptions[] = [];
  const nf = makeNativeFetch(async (o) => {
    seen.push(o);
    if (o.url.endsWith("/token")) return { status: 200, headers: { "content-type": "text/plain" }, data: "tok_" + "x".repeat(40), url: o.url };
    // CapacitorHttp may hand back JSON already parsed.
    return { status: 200, headers: { "content-type": "application/json" }, data: { timeZone: "Europe/Madrid" }, url: o.url };
  });
  const api = new GarminApi({ apiKey: "secret-key-0123456789", fetch: nf, baseUrl: "https://example.test" });
  assert.deepEqual(await api.get("/userprofile-service/userprofile/settings"), { timeZone: "Europe/Madrid" });
  assert.equal(seen[0].method, "POST");
  assert.equal(seen[0].headers?.authorization, "ApiKey secret-key-0123456789");
  assert.equal(seen[1].method, "GET");
  assert.equal(seen[1].headers?.authorization, "Bearer tok_" + "x".repeat(40));
  assert.equal(seen[1].data, undefined, "a GET has no body");
});
