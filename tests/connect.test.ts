import test from "node:test";
import assert from "node:assert/strict";
import Anthropic from "@anthropic-ai/sdk";
import type { HttpOptions, HttpResponse } from "@capacitor/core";
import { claudeKeyVerifier } from "../src/domain/chat/client";
import { claudeConnection, connectClaude, disconnectClaude, watchConnection } from "../src/domain/chat/connect";
import { CHAT_MODEL, ChatApiError, type ClaudeCreate } from "../src/domain/chat/engine";
import { loadClaudeKey, memorySecretStore } from "../src/domain/settings/secrets";
import { makeNativeFetch } from "../src/platform/nativeFetch";
import { migratedDb } from "./helpers";

const KEY = "sk-ant-api03-test-key-not-real-000000AbCd";
const NOW = 1_800_000_000_000;

/** CapacitorHttp stand-in for GET /v1/models/{id}. */
function fakeNative(status: number, body: unknown) {
  const seen: HttpOptions[] = [];
  const request = async (o: HttpOptions): Promise<HttpResponse> => {
    seen.push(o);
    // retry-after-ms 1 (0 counts as unset): the SDK retries a 529 once (maxRetries 1); the real back-off would add half a second to the test.
    return { status, headers: { "content-type": "application/json", "retry-after-ms": "1" }, data: body, url: o.url };
  };
  return { request, seen };
}
const modelInfo = { type: "model", id: CHAT_MODEL, display_name: "Claude Haiku 5.5", created_at: "2026-09-01T00:00:00Z" };
const apiError = (type: string, message: string) => ({ type: "error", error: { type, message } });

test("connect verifies the key with a free model lookup over native HTTP, then stores it", async () => {
  const { db } = await migratedDb();
  const secrets = memorySecretStore();
  const native = fakeNative(200, modelInfo);
  const res = await connectClaude(db, secrets, `  ${KEY}  `, claudeKeyVerifier(makeNativeFetch(native.request)), NOW);

  assert.equal(res.ok, true);
  const req = native.seen[0];
  assert.equal(req.method, "GET");
  assert.match(req.url, new RegExp(`/v1/models/${CHAT_MODEL}$`));
  assert.equal(req.headers?.authorization, `Bearer ${KEY}`);
  assert.equal(await loadClaudeKey(secrets), KEY, "trimmed and stored in the secret store");
  assert.deepEqual(await claudeConnection(db, secrets), { status: "connected", keyHint: "…AbCd", verifiedAtMs: NOW, problem: null });

  const settings = await db.all<{ key: string; value: string }>("SELECT key, value FROM app_settings");
  assert.ok(!settings.some((s) => s.value.includes("test-key")), "the key itself is never written to SQLite");
});

test("a key Claude rejects is never saved, with a message safe to show", async () => {
  const { db } = await migratedDb();
  const secrets = memorySecretStore();
  const cases: [number, unknown, RegExp][] = [
    [401, apiError("authentication_error", "invalid x-api-key"), /rejected the API key/],
    [404, apiError("not_found_error", "model not found"), /cannot use claude-haiku-5-5/],
    [529, apiError("overloaded_error", "Overloaded"), /overloaded/],
  ];
  for (const [status, body, expected] of cases) {
    const res = await connectClaude(db, secrets, KEY, claudeKeyVerifier(makeNativeFetch(fakeNative(status, body).request)), NOW);
    assert.equal(res.ok, false);
    if (!res.ok) {
      assert.match(res.message, expected);
      assert.ok(!res.message.includes(KEY));
    }
  }
  const bad = await connectClaude(db, secrets, "sk-proj-not-anthropic", async () => assert.fail("not called for a malformed key"), NOW);
  assert.deepEqual(bad, { ok: false, message: "That does not look like an Anthropic API key (it starts with sk-ant-)" });
  assert.equal(await loadClaudeKey(secrets), null);
  assert.equal((await claudeConnection(db, secrets)).status, "not_connected");
});

test("a key rejected during chat marks the connection, the next good reply clears it", async () => {
  const { db } = await migratedDb();
  const secrets = memorySecretStore();
  await connectClaude(db, secrets, KEY, async () => {}, NOW);

  const replies: Array<Error | object> = [new Anthropic.AuthenticationError(401, { type: "error" }, "invalid x-api-key", new Headers()), { id: "msg" }];
  const base: ClaudeCreate = async () => {
    const r = replies.shift()!;
    if (r instanceof Error) throw r;
    return r as never;
  };
  const create = watchConnection(db, base, () => NOW + 1);

  await assert.rejects(create({} as never), Anthropic.AuthenticationError, "rethrown unchanged");
  const broken = await claudeConnection(db, secrets);
  assert.equal(broken.status, "needs_attention");
  assert.match(broken.problem!, /revoked or expired/);

  await create({} as never);
  assert.equal((await claudeConnection(db, secrets)).status, "connected");
});

test("other errors do not mark the connection; disconnect forgets the key and its facts", async () => {
  const { db } = await migratedDb();
  const secrets = memorySecretStore();
  await connectClaude(db, secrets, KEY, async () => {}, NOW);
  const create = watchConnection(db, async () => {
    throw new ChatApiError("network", "offline", true);
  });
  await assert.rejects(create({} as never), /offline/);
  assert.equal((await claudeConnection(db, secrets)).status, "connected");

  await disconnectClaude(db, secrets, NOW + 2);
  assert.equal(await loadClaudeKey(secrets), null);
  assert.deepEqual(await claudeConnection(db, secrets), { status: "not_connected", keyHint: null, verifiedAtMs: null, problem: null });
});
