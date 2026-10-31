import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { memorySecretStore } from "../src/core/secretStore";
import { syncApi, SyncHttpError } from "../src/domain/cloudsync/api";
import { friendData, shareKind, summaries } from "../src/domain/cloudsync/friends";
import {
  approvePairing,
  changePassphrase,
  createAccount,
  deleteAccount,
  disconnect,
  loadSession,
  lookUpPairing,
  pairingQrText,
  parsePairingCode,
  sessionApi,
  startPairing,
} from "../src/domain/cloudsync/session";
import { upsertSamples } from "../src/domain/metrics/samples";
import { addFood, byPairing, byPassphrase, firstPhone, foods, roundTrip, TEST_ITERATIONS, TEST_PASSPHRASE, type Phone } from "../scripts/lib/syncScenario";
import { testServer } from "./serverHelpers";

// docs/users.md, case by case, against the real server on PGlite.
let server: Awaited<ReturnType<typeof testServer>>;
before(async () => {
  server = await testServer();
});
after(() => server.pg.close());

const newEmail = () => `${crypto.randomUUID()}@example.com`;
async function account(name = "a"): Promise<{ email: string; a: Phone }> {
  const email = newEmail();
  return { email, a: await firstPhone(server, await server.stores.accounts.createInvite(email), email, name) };
}
const expectStatus = async (p: Promise<unknown>, status: number) => {
  await assert.rejects(p, (err: unknown) => err instanceof SyncHttpError && err.status === status);
};

// ---- 2.1 First phone ----

test("an invite makes one account for its email, once", async () => {
  const email = newEmail();
  const code = await server.stores.accounts.createInvite(email);
  const make = (e: string, c = code) =>
    createAccount(
      server.base,
      memorySecretStore(),
      { inviteCode: c, email: e, displayName: "Me", passphrase: TEST_PASSPHRASE, device: { name: "s23", kind: "phone" } },
      { fetchFn: server.fetchFn, iterations: TEST_ITERATIONS },
    );
  await expectStatus(make(newEmail()), 403);
  const store = memorySecretStore();
  const s = await createAccount(
    server.base,
    store,
    {
      inviteCode: code.toLowerCase().replace(/(.{5})/, "$1-"),
      email: email.toUpperCase(),
      displayName: "Me",
      passphrase: TEST_PASSPHRASE,
      device: { name: "s23", kind: "phone" },
    },
    { fetchFn: server.fetchFn, iterations: TEST_ITERATIONS },
  );
  assert.equal(s.email, email, "emails are kept in lower case; codes typed with dashes or in lower case work");
  assert.deepEqual(await loadSession(store), s, "the session is kept in the secret store");
  await expectStatus(make(email), 403); // used
});

test("a weak passphrase is refused before anything is sent", async () => {
  const email = newEmail();
  await assert.rejects(
    createAccount(
      server.base,
      memorySecretStore(),
      { inviteCode: await server.stores.accounts.createInvite(email), email, displayName: "Me", passphrase: "short", device: { name: "x", kind: "phone" } },
      { fetchFn: server.fetchFn },
    ),
    /at least 12 characters/,
  );
});

test("the server never holds the passphrase or the account data key", async () => {
  const { a } = await account();
  const [keys] = await server.pg.query<Record<string, string>>("SELECT * FROM account_keys WHERE account_id = $1", [a.session.accountId]);
  const stored = JSON.stringify(keys);
  assert.ok(!stored.includes(TEST_PASSPHRASE));
  assert.ok(!stored.includes(a.session.adk));
  assert.ok(!stored.includes(JSON.stringify(a.session.identityPrivate.d)), "the identity private key is sealed");
});

// ---- 2.2 More devices ----

test("a second device joins with email and passphrase and syncs", async () => {
  const { email, a } = await account();
  const b = await byPassphrase(server, email);
  assert.equal(b.session.adk, a.session.adk);
  assert.deepEqual(await roundTrip(a, b, 1_000), []);
});

test("a wrong passphrase, or an email with no account, gets the same answer", async () => {
  const { email } = await account();
  await assert.rejects(byPassphrase(server, email, "b", "not the passphrase at all"), /do not match/);
  await assert.rejects(byPassphrase(server, newEmail(), "b"), /do not match/);
  // Unknown emails get a stable made-up salt, so the salt does not tell whether an account exists.
  const api = syncApi(server.base, server.fetchFn);
  const ghost = newEmail();
  assert.deepEqual(await api.recoveryStart(ghost), await api.recoveryStart(ghost));
});

test("pairing: the new device shows a code, a connected device approves it, the new device gets the keys", async () => {
  const { a } = await account();
  const c = await byPairing(server, a, "laptop");
  assert.equal(c.session.adk, a.session.adk);
  assert.equal(c.session.accountId, a.session.accountId);
  assert.deepEqual(await roundTrip(a, c, 1_000), []);
  const me = await sessionApi(a.session, server.fetchFn).me();
  assert.deepEqual(
    me.devices.map((d) => [d.name, d.addedBy]),
    [
      ["a", "invite"],
      ["laptop", "pairing"],
    ],
  );
});

test("pairing refuses a code whose key fingerprint does not match (a swapped key)", async () => {
  const { a } = await account();
  const stop = new AbortController();
  const req = await startPairing(server.base, memorySecretStore(), { name: "x", kind: "web" }, { fetchFn: server.fetchFn, pollMs: 10, signal: stop.signal });
  const waiting = req.done.catch((err: Error) => err.message);
  const [id] = req.code.split("-");
  await assert.rejects(approvePairing(a.session, `${id}-AAAAAA`, { fetchFn: server.fetchFn }), /does not match/);
  await assert.rejects(approvePairing(a.session, "nonsense", { fetchFn: server.fetchFn }), /12 characters/);
  stop.abort();
  assert.equal(await waiting, "Pairing cancelled", "the new device stops waiting when asked");
});

test("a pairing code works once, and the sealed keys are forgotten after pick-up", async () => {
  const { a } = await account();
  const req = await startPairing(server.base, memorySecretStore(), { name: "x", kind: "web" }, { fetchFn: server.fetchFn, pollMs: 10 });
  await approvePairing(a.session, req.code, { fetchFn: server.fetchFn });
  await req.done;
  await assert.rejects(approvePairing(a.session, req.code, { fetchFn: server.fetchFn }), /not valid any more/);
  const [p] = await server.pg.query<{ sealed: string | null }>("SELECT sealed FROM pairings WHERE id = $1", [req.code.split("-")[0]]);
  assert.equal(p.sealed, null);
});

test("a pairing QR holds the code behind a prefix; typed and scanned codes read the same, other QR codes not at all", () => {
  const qr = pairingQrText("ABC234-XYZ567");
  assert.equal(qr, "even-pair:ABC234-XYZ567");
  const want = { id: "ABC234", fingerprint: "XYZ567" };
  assert.deepEqual(parsePairingCode(qr), want);
  assert.deepEqual(parsePairingCode("abc234 xyz567"), want, "typed in lower case, with a space");
  assert.deepEqual(parsePairingCode("ABC234XYZ567"), want);
  assert.equal(parsePairingCode("https://example.com/menu"), null);
  assert.equal(parsePairingCode("WIFI:S:home;T:WPA;P:secret;;"), null);
  assert.equal(parsePairingCode("even-pair:ABC234"), null);
});

test("a scanned pairing QR shows the asking device's name before approval, and the browser joins only after it", async () => {
  const { a } = await account();
  const store = memorySecretStore();
  let hookRan = false;
  const req = await startPairing(
    server.base,
    store,
    { name: "Chrome on Windows (shared)", kind: "web" },
    { fetchFn: server.fetchFn, pollMs: 10, beforeSave: () => (hookRan = true) },
  );
  const scanned = pairingQrText(req.code);
  assert.deepEqual(await lookUpPairing(a.session, scanned, { fetchFn: server.fetchFn }), { deviceName: "Chrome on Windows (shared)", deviceKind: "web" });
  assert.equal(await loadSession(store), null, "looking up lets nobody in");
  assert.equal(hookRan, false, "the shared-computer choice waits for the keys");
  await approvePairing(a.session, scanned, { fetchFn: server.fetchFn });
  const joined = await req.done;
  assert.ok(hookRan, "the shared-computer choice applied before the session was saved");
  assert.equal((await loadSession(store))?.deviceId, joined.deviceId);
  await assert.rejects(lookUpPairing(a.session, scanned, { fetchFn: server.fetchFn }), /not valid any more/);
});

test("looking up a pairing code refuses a swapped key, like approving does", async () => {
  const { a } = await account();
  const stop = new AbortController();
  const req = await startPairing(server.base, memorySecretStore(), { name: "x", kind: "web" }, { fetchFn: server.fetchFn, pollMs: 10, signal: stop.signal });
  const done = req.done.catch(() => null);
  await assert.rejects(lookUpPairing(a.session, pairingQrText(`${req.code.split("-")[0]}-AAAAAA`), { fetchFn: server.fetchFn }), /does not match/);
  stop.abort();
  await done;
});

// ---- 2.5 Devices and safety ----

test("a revoked device is refused at once; a disconnected device forgets its session", async () => {
  const { email, a } = await account();
  const b = await byPassphrase(server, email);
  await sessionApi(a.session, server.fetchFn).revokeDevice(b.session.deviceId);
  await expectStatus(b.sync(1_000), 401);
  const store = memorySecretStore();
  const c = await byPassphrase(server, email, "c");
  await store.set("cloudsync.session", JSON.stringify(c.session));
  await disconnect(store, c.session, { fetchFn: server.fetchFn });
  assert.equal(await loadSession(store), null);
  await expectStatus(c.sync(1_001), 401);
});

test("a device cannot revoke another account's devices", async () => {
  const one = await account();
  const other = await account();
  await expectStatus(sessionApi(one.a.session, server.fetchFn).revokeDevice(other.a.session.deviceId), 404);
});

test("a new passphrase works and the old one stops", async () => {
  const { email, a } = await account();
  await changePassphrase(a.session, "a whole new passphrase here", { fetchFn: server.fetchFn, iterations: TEST_ITERATIONS });
  await assert.rejects(byPassphrase(server, email, "b"), /do not match/);
  const b = await byPassphrase(server, email, "b", "a whole new passphrase here");
  assert.equal(b.session.adk, a.session.adk);
});

test("deleting the account removes everything the server held for it", async () => {
  const { a } = await account();
  await addFood(a, "f", "x", 1, 1_000);
  await a.sync(1_001);
  const store = memorySecretStore();
  await deleteAccount(store, a.session, { fetchFn: server.fetchFn });
  for (const [table, col] of [
    ["accounts", "id"],
    ["account_keys", "account_id"],
    ["devices", "owner_id"],
    ["sync_rows", "owner_id"],
  ]) {
    assert.equal((await server.pg.query(`SELECT 1 FROM ${table} WHERE ${col} = $1`, [a.session.accountId])).length, 0, table);
  }
  assert.equal((await foods(a)).length, 1, "the device keeps its own data");
});

test("rate limits: passphrase guesses stop after five an hour", async () => {
  const limited = await testServer({ rateLimits: true });
  try {
    const email = newEmail();
    await firstPhone(limited, await limited.stores.accounts.createInvite(email), email);
    for (let i = 0; i < 5; i++) await assert.rejects(byPassphrase(limited, email, "b", `wrong guess number ${i}`), /do not match/);
    await assert.rejects(byPassphrase(limited, email, "b"), /Too many attempts/, "even the right passphrase waits");
  } finally {
    await limited.pg.close();
  }
});

test("Google can be linked to one account only", async () => {
  const one = await account();
  const other = await account();
  await sessionApi(one.a.session, server.fetchFn).linkGoogle(`google:sub-1:${one.email}`);
  assert.equal((await sessionApi(one.a.session, server.fetchFn).me()).account.googleLinked, true);
  await expectStatus(sessionApi(other.a.session, server.fetchFn).linkGoogle(`google:sub-1:${other.email}`), 409);
  await expectStatus(sessionApi(other.a.session, server.fetchFn).linkGoogle("a forged token that Google never signed"), 401);
});

test("every account endpoint needs a device token", async () => {
  for (const [method, path] of [
    ["GET", "/v1/me"],
    ["DELETE", "/v1/me"],
    ["GET", "/v1/friends"],
    ["GET", "/v1/shares"],
    ["POST", "/v1/friends/invites"],
    ["GET", "/v1/pull"],
  ]) {
    assert.equal((await server.app.request(path, { method })).status, 401, `${method} ${path}`);
  }
});

test("app upserts still work on rows waiting to be pushed (the outbox triggers never conflict)", async () => {
  const { a } = await account();
  const sample = {
    source: "garmin",
    device: "fr",
    externalId: "d1",
    metric: "daily_steps",
    startMs: Date.UTC(2026, 9, 1),
    offsetMin: 0,
    valueNum: 100,
    unit: "steps",
  };
  await upsertSamples(a.db, [sample], 1_000);
  await upsertSamples(a.db, [{ ...sample, valueNum: 200 }], 2_000);
  const [row] = await a.db.all<{ value_num: number }>("SELECT value_num FROM health_samples");
  assert.equal(row.value_num, 200);
});

// ---- 2.4 Friends ----

async function friends(): Promise<{ me: Phone; friend: Phone }> {
  const me = (await account("me")).a;
  const friend = (await account("friend")).a;
  const { code } = await sessionApi(me.session, server.fetchFn).friendInvite();
  await sessionApi(friend.session, server.fetchFn).acceptFriend(code);
  return { me, friend };
}

test("a friend code connects two accounts both ways, once, and not with yourself", async () => {
  const { me, friend } = await friends();
  const [mine] = await sessionApi(me.session, server.fetchFn).friends();
  const [theirs] = await sessionApi(friend.session, server.fetchFn).friends();
  assert.equal(mine.accountId, friend.session.accountId);
  assert.equal(theirs.accountId, me.session.accountId);
  const { code } = await sessionApi(me.session, server.fetchFn).friendInvite();
  await expectStatus(sessionApi(me.session, server.fetchFn).acceptFriend(code), 400);
  await sessionApi(friend.session, server.fetchFn).acceptFriend(code);
  await expectStatus(sessionApi(friend.session, server.fetchFn).acceptFriend(code), 404);
});

test("a friend sees only the kinds shared, as daily summaries, and the server cannot read them", async () => {
  const { me, friend } = await friends();
  const day = "2026-10-27";
  await upsertSamples(me.db, [
    {
      source: "garmin",
      device: "fr",
      externalId: day,
      metric: "daily_steps",
      startMs: Date.parse(`${day}T12:00:00Z`),
      offsetMin: 0,
      valueNum: 12345,
      unit: "steps",
    },
  ]);
  await addFood(me, "f", "secret cake", 640, Date.parse(`${day}T12:00:00Z`));
  const api = sessionApi(me.session, server.fetchFn);
  const [f] = await api.friends();
  await shareKind(api, me.session, f, "activity");
  await me.sync();
  const seen = await friendData(sessionApi(friend.session, server.fetchFn), friend.session, me.session.accountId);
  assert.deepEqual(
    seen.map((k) => k.share.kind),
    ["activity"],
  );
  assert.deepEqual(seen[0].days.find((d) => d.day === day)?.values, { steps: 12345 });
  const stored = JSON.stringify(await server.pg.query("SELECT * FROM share_rows"));
  assert.ok(!stored.includes("12345"), "the summary is sealed");
  assert.ok(!JSON.stringify(seen).includes("secret cake"), "no food names, ever");
});

test("someone who is not the friend cannot read a share, and stopping it removes it at once", async () => {
  const { me, friend } = await friends();
  const stranger = (await account("stranger")).a;
  const api = sessionApi(me.session, server.fetchFn);
  const share = await shareKind(api, me.session, (await api.friends())[0], "sleep");
  await expectStatus(sessionApi(stranger.session, server.fetchFn).pullShareRows(share.id, -1, 10), 404);
  await expectStatus(sessionApi(friend.session, server.fetchFn).unshare(share.id), 403);
  await api.unshare(share.id);
  assert.deepEqual(await friendData(sessionApi(friend.session, server.fetchFn), friend.session, me.session.accountId), []);
});

test("only friends can be shared with, and unfriending ends every share both ways", async () => {
  const { me, friend } = await friends();
  const stranger = (await account("stranger")).a;
  const api = sessionApi(me.session, server.fetchFn);
  await expectStatus(api.share(stranger.session.accountId, "sleep", "AAAA"), 403);
  await shareKind(api, me.session, (await api.friends())[0], "sleep");
  const fApi = sessionApi(friend.session, server.fetchFn);
  await shareKind(fApi, friend.session, (await fApi.friends())[0], "weight");
  await api.removeFriend(friend.session.accountId);
  assert.deepEqual(await api.shares(), { outgoing: [], incoming: [] });
  assert.deepEqual(await fApi.friends(), []);
});

test("summaries per kind: nutrition totals and alcohol grams, nothing else", async () => {
  const { a } = await account();
  const day = "2026-10-26";
  await addFood(a, "f", "pasta", 700, Date.parse(`${day}T13:00:00Z`));
  await a.db.run(
    "INSERT INTO drink_entries (id, drunk_at_ms, offset_min, local_day, name, volume_ml, abv_percent, created_at, updated_at, origin_device_id) VALUES ('d', ?, 0, ?, 'beer', 330, 5, 1, 1, 'a')",
    [Date.parse(`${day}T20:00:00Z`), day],
  );
  assert.deepEqual((await summaries(a.db, "nutrition", day, day)).get(day), { kcal: 700 });
  assert.deepEqual((await summaries(a.db, "alcohol", day, day)).get(day), { alcoholG: 13 });
  assert.equal((await summaries(a.db, "sleep", day, day)).size, 0);
});
