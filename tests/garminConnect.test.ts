import test from "node:test";
import assert from "node:assert/strict";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { GARMIN_SOURCE, KEY_REJECTED } from "../src/features/sync/garmin";
import { connectGarmin, disconnectGarmin, garminConnection, garminKeyVerifier } from "../src/features/sync/garminConnect";
import { loadGarminKey, memorySecretStore } from "../src/features/settings/secrets";
import { SecretInput } from "../src/ui/controls";
import { migratedDb } from "./helpers";

const KEY = "garmin-personal-key-not-real-WxYz";

/** Garmin's token endpoint stand-in: answers every request with this status and body. */
const tokenFetch = (status: number, body = "eyJhbGciOiJIUzI1NiJ9.token-not-real.signature") => {
  const seen: { url: string; auth: string | null }[] = [];
  const doFetch = (async (url: string, init?: RequestInit) => {
    seen.push({ url, auth: new Headers(init?.headers).get("authorization") });
    return new Response(body, { status });
  }) as typeof fetch;
  return { doFetch, seen };
};

const run = (db: Awaited<ReturnType<typeof migratedDb>>["db"], id: string, at: number, status: "ok" | "error", error: string | null = null) =>
  db.run("INSERT INTO sync_runs (id, source, started_ms, finished_ms, status, error) VALUES (?, ?, ?, ?, ?, ?)", [
    id,
    GARMIN_SOURCE,
    at,
    at + 1000,
    status,
    error,
  ]);

test("connect checks the key with Garmin (a token request) before saving it", async () => {
  const secrets = memorySecretStore();
  const { doFetch, seen } = tokenFetch(200);
  assert.deepEqual(await connectGarmin(secrets, `  ${KEY}\n`, garminKeyVerifier(doFetch)), { ok: true });
  assert.equal(await loadGarminKey(secrets), KEY, "saved trimmed");
  assert.equal(seen.length, 1);
  assert.equal(seen[0].auth, `ApiKey ${KEY}`);
});

test("a key Garmin refuses, or one that cannot be a key, is never saved", async () => {
  const secrets = memorySecretStore();
  const refused = await connectGarmin(secrets, KEY, garminKeyVerifier(tokenFetch(401).doFetch));
  assert.equal(refused.ok, false);
  assert.match((refused as { message: string }).message, new RegExp(`^${KEY_REJECTED}`));
  const { doFetch, seen } = tokenFetch(200);
  assert.equal((await connectGarmin(secrets, "too short", garminKeyVerifier(doFetch))).ok, false);
  assert.equal(seen.length, 0, "a bad shape is refused without asking Garmin");
  assert.equal(await loadGarminKey(secrets), null);
});

test("the card's state: not connected, connected with the key's last 4, needs attention only when the key was refused", async () => {
  const { db } = await migratedDb();
  const secrets = memorySecretStore();
  assert.equal((await garminConnection(db, secrets)).status, "not_connected");

  await connectGarmin(secrets, KEY, async () => {});
  await run(db, "r1", 1_000, "ok");
  assert.deepEqual(await garminConnection(db, secrets), { status: "connected", keyHint: "…WxYz", lastOkMs: 2_000, lastError: null });

  // Offline: the key is fine, the card stays connected and shows the error.
  await run(db, "r2", 5_000, "error", "Could not reach Garmin (timeout)");
  const offline = await garminConnection(db, secrets);
  assert.equal(offline.status, "connected");
  assert.equal(offline.lastError, "Could not reach Garmin (timeout)");

  await run(db, "r3", 9_000, "error", `${KEY_REJECTED} (HTTP 401). It may have expired: make a new one in Garmin Connect.`);
  assert.equal((await garminConnection(db, secrets)).status, "needs_attention");

  await disconnectGarmin(secrets);
  assert.equal((await garminConnection(db, secrets)).status, "not_connected");
  assert.equal(await loadGarminKey(secrets), null);
});

test("secret fields: hidden by default, Show and Clear buttons named for what they hold, Clear only with something to clear", () => {
  const empty = renderToStaticMarkup(h(SecretInput, { value: "", onChange: () => {}, noun: "key" }));
  assert.match(empty, /type="password"/);
  assert.match(empty, /aria-label="Show the key" aria-pressed="false"/);
  assert.doesNotMatch(empty, /Clear/);
  const filled = renderToStaticMarkup(h(SecretInput, { value: "hunter22", onChange: () => {} }));
  assert.match(filled, /aria-label="Clear the password"/);
  assert.match(filled, /spellCheck="false"|spellcheck="false"/);
  assert.equal((filled.match(/type="button"/g) ?? []).length, 2, "never submits the form");
});
