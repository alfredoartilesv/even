import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { memorySecretStore } from "../src/core/secretStore";
import { GARMIN_API_URL, GARMIN_RELAY_PATH, garminRelayAllowed, garminRelayFetch } from "../src/core/garminRelay";
import { createAccount, type SyncSession } from "../src/domain/cloudsync/session";
import { GarminApi, KEY_REJECTED } from "../src/domain/sync/garmin";
import { TEST_ITERATIONS, TEST_PASSPHRASE } from "../scripts/lib/syncScenario";
import { testServer } from "./serverHelpers";

// docs/architecture.md section 6c: the browser reaches Garmin through its own sync server.

/** Garmin stands in: what it was asked, and how it answers (a key "bad" is refused; "down" means unreachable). */
const asked: { url: string; method: string; auth: string | null }[] = [];
let down = false;
const garmin = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input);
  const auth = new Headers(init?.headers).get("authorization");
  asked.push({ url, method: init?.method ?? "GET", auth });
  if (down) throw new TypeError("fetch failed");
  if (url.endsWith("/token"))
    return auth === "ApiKey bad" ? new Response("no", { status: 401 }) : new Response("garmin-access-token-0123456789", { status: 200 });
  return Response.json({ summaries: [{ calendarDate: "2026-10-30", totalSteps: 9522 }] });
}) as typeof fetch;

let server: Awaited<ReturnType<typeof testServer>>;
let session: SyncSession;
before(async () => {
  server = await testServer({ garminFetch: garmin });
  const email = `${crypto.randomUUID()}@example.com`;
  session = await createAccount(
    server.base,
    memorySecretStore(),
    {
      inviteCode: await server.stores.accounts.createInvite(email),
      email,
      displayName: "Me",
      passphrase: TEST_PASSPHRASE,
      device: { name: "web", kind: "web" },
    },
    { fetchFn: server.fetchFn, iterations: TEST_ITERATIONS },
  );
});
after(() => server.pg.close());

const api = (apiKey: string, token = session.token) => new GarminApi({ apiKey, fetch: garminRelayFetch(server.base, token, server.fetchFn) });

test("the relay passes on exactly the calls the Garmin sync makes, nothing else", () => {
  assert.ok(garminRelayAllowed("POST", "/personalapitoken-service/personal-api/personal-api-key/token"));
  assert.ok(garminRelayAllowed("GET", "/usersummary-service/v2/dailysummaries"));
  assert.ok(garminRelayAllowed("GET", "/hrv-service/hrv/daily/2026-10-01/2026-10-28"));
  assert.ok(!garminRelayAllowed("GET", "/personalapitoken-service/personal-api/personal-api-key/token"), "wrong method");
  assert.ok(!garminRelayAllowed("GET", "/hrv-service/hrv/daily/../../userprofile-service"), "no other path through a pattern");
  assert.ok(!garminRelayAllowed("DELETE", "/usersummary-service/v2/dailysummaries"));
  assert.ok(!garminRelayAllowed("GET", "/anything-else"));
});

test("a signed-in browser syncs through the relay: Garmin gets the Garmin credential, never the device token", async () => {
  asked.length = 0;
  const g = api("good-key");
  await g.verify();
  const body = await g.get("/usersummary-service/v2/dailysummaries", { fromDate: "2026-10-01", untilDate: "2026-10-28" });
  assert.deepEqual(body, { summaries: [{ calendarDate: "2026-10-30", totalSteps: 9522 }] });
  assert.deepEqual(
    asked.map((a) => [a.method, a.url, a.auth]),
    [
      ["POST", `${GARMIN_API_URL}/personalapitoken-service/personal-api/personal-api-key/token`, "ApiKey good-key"],
      ["GET", `${GARMIN_API_URL}/usersummary-service/v2/dailysummaries?fromDate=2026-10-01&untilDate=2026-10-28`, "Bearer garmin-access-token-0123456789"],
    ],
  );
  assert.ok(asked.every((a) => !a.auth?.includes(session.token)));
});

test("Garmin refusing the key still reads as a refused key; the server refusing the browser does not", async () => {
  await assert.rejects(api("bad").verify(), (e: Error) => e.message.startsWith(KEY_REJECTED));
  asked.length = 0;
  await assert.rejects(api("good-key", "not-a-device-token").verify(), (e: Error) => /sign in again/.test(e.message) && !e.message.includes(KEY_REJECTED));
  assert.equal(asked.length, 0, "nothing reaches Garmin without a device");
});

test("the relay refuses other paths and a missing credential, and says when Garmin cannot be reached", async () => {
  asked.length = 0;
  const call = (path: string, headers: Record<string, string> = {}) =>
    server.fetchFn(`${server.base}${GARMIN_RELAY_PATH}${path}`, { headers: { authorization: `Bearer ${session.token}`, ...headers } });
  assert.equal((await call("/userprofile-service/socialProfile", { "x-garmin-authorization": "Bearer t" })).status, 404);
  assert.equal((await call("/userprofile-service/userprofile/settings")).status, 400);
  assert.equal(asked.length, 0);
  down = true;
  try {
    assert.equal((await call("/userprofile-service/userprofile/settings", { "x-garmin-authorization": "Bearer t" })).status, 502);
    await assert.rejects(api("good-key").verify(), /Could not reach Garmin \(the sync server could not pass it on, HTTP 502\)/);
  } finally {
    down = false;
  }
});
