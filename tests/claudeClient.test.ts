import test from "node:test";
import assert from "node:assert/strict";
import type { HttpOptions, HttpResponse } from "@capacitor/core";
import { claudeCreate } from "../src/features/chat/client";
import { CHAT_MODEL, ChatApiError, startConversation } from "../src/features/chat/engine";
import { recordConsent } from "../src/features/chat/consent";
import { makeNativeFetch } from "../src/platform/nativeFetch";
import { migratedDb } from "./helpers";

const KEY = "sk-ant-api03-test-key-not-real-0000000000";

/** CapacitorHttp stand-in: records requests, answers like the Messages API. */
function fakeNative(status = 200, body: unknown = null) {
  const seen: HttpOptions[] = [];
  const request = async (o: HttpOptions): Promise<HttpResponse> => {
    seen.push(o);
    const data = body ?? {
      id: "msg_1",
      type: "message",
      role: "assistant",
      model: CHAT_MODEL,
      content: [{ type: "text", text: "Hola" }],
      stop_reason: "end_turn",
      stop_sequence: null,
      stop_details: null,
      usage: { input_tokens: 10, output_tokens: 2 },
    };
    return { status, headers: { "content-type": "application/json", "request-id": "req_1" }, data, url: o.url };
  };
  return { request, seen };
}

test("the SDK goes over native HTTP: right endpoint, headers and body, reply parsed", async () => {
  const native = fakeNative();
  const create = claudeCreate(KEY, makeNativeFetch(native.request, { readTimeoutMs: 300_000 }));
  const { db } = await migratedDb();
  await recordConsent(db, "claude.aggregates", true, "dev");
  const res = await startConversation({ db, create, deviceId: "dev", timeZone: "Europe/Madrid" }, "Hola");
  assert.equal(res.text, "Hola");

  const req = native.seen[0];
  assert.equal(req.method, "POST");
  assert.match(req.url, /^https:\/\/api\.anthropic\.com\/v1\/messages(\?|$)/);
  assert.equal(req.headers?.authorization, `Bearer ${KEY}`); // SDK 1.x sends API keys as a bearer token
  assert.match(String(req.headers?.["anthropic-beta"]), /server-side-fallback-2026-07-01/);
  assert.ok(req.headers?.["anthropic-version"]);
  assert.equal(req.readTimeout, 300_000);
  const body = req.data as Record<string, unknown>;
  assert.equal(typeof body, "object", "sent as an object so CapacitorHttp does not double-encode it");
  assert.equal(body.model, "claude-opus-5-5");
  assert.equal(body.fallbacks, "default");
  assert.equal("betas" in body, false, "betas travel as a header, not in the body");
});

test("an HTTP 401 from the API surfaces as an auth ChatApiError without the key", async () => {
  const native = fakeNative(401, { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } });
  const create = claudeCreate(KEY, makeNativeFetch(native.request));
  const { db } = await migratedDb();
  await recordConsent(db, "claude.aggregates", true, "dev");
  const err = await startConversation({ db, create, deviceId: "dev" }, "Hola").catch((e) => e);
  assert.ok(err instanceof ChatApiError);
  assert.equal(err.kind, "auth");
  assert.ok(!err.message.includes(KEY));
  assert.equal(native.seen.length, 1, "401 is not retried");
});
