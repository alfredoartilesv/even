import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { SyncHttpError } from "../src/domain/cloudsync/api";
import { sessionApi } from "../src/domain/cloudsync/session";
import { byPassphrase, firstPhone, type Phone } from "../scripts/lib/syncScenario";
import { testServer } from "./serverHelpers";

// docs/users.md section 2.6: an admin manages invites, accounts and devices, and never sees data.
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
async function adminAccount(): Promise<{ email: string; a: Phone; api: ReturnType<typeof sessionApi>["admin"] }> {
  const { email, a } = await account("admin");
  await server.stores.admin.setAdmin(email, true);
  return { email, a, api: sessionApi(a.session, server.fetchFn).admin };
}
const expectStatus = async (p: Promise<unknown>, status: number) => {
  await assert.rejects(p, (err: unknown) => err instanceof SyncHttpError && err.status === status);
};

test("only an admin account reaches the admin endpoints, and only the CLI makes one", async () => {
  const { email, a } = await account();
  const api = sessionApi(a.session, server.fetchFn);
  assert.equal((await api.me()).account.isAdmin, false);
  await expectStatus(api.admin.accounts(), 403);
  await expectStatus(api.admin.createInvite(newEmail()), 403);
  await server.stores.admin.setAdmin(email, true);
  assert.equal((await api.me()).account.isAdmin, true, "the app shows Settings > Admin from this");
  assert.ok((await api.admin.accounts()).some((x) => x.email === email));
  await server.stores.admin.setAdmin(email, false);
  await expectStatus(api.admin.accounts(), 403);
});

test("an admin's invite makes one account; a cancelled one makes none; both are in the audit log without the email or code", async () => {
  const { a, api } = await adminAccount();
  const email = newEmail();
  const { code, invite } = await api.createInvite(email, 3);
  assert.equal(invite.status, "open");
  assert.equal(invite.expiresAt - invite.createdAt, 3 * 86_400_000);
  await firstPhone(server, code, email, "friend");
  assert.equal((await api.invites()).find((i) => i.id === invite.id)?.status, "used");

  const other = newEmail();
  const second = await api.createInvite(other);
  await api.cancelInvite(second.invite.id);
  assert.equal((await api.invites()).find((i) => i.id === second.invite.id)?.status, "cancelled");
  await assert.rejects(firstPhone(server, second.code, other, "x"), /was used or has expired/);
  await expectStatus(api.cancelInvite(invite.id), 404); // used invites stay as they are

  const log = (await api.audit()).filter((e) => e.actor === a.session.accountId);
  assert.deepEqual(
    log.map((e) => [e.action, e.via]),
    [
      ["cancel-invite", "app"],
      ["create-invite", "app"],
      ["create-invite", "app"],
    ],
  );
  const text = JSON.stringify(log);
  assert.ok(!text.includes(email) && !text.includes(code) && !text.includes(second.code), "no email or code in the log");
});

test("the account list shows who and how much, never data", async () => {
  const { api } = await adminAccount();
  const { email, a } = await account();
  const row = (await api.accounts()).find((x) => x.email === email)!;
  assert.equal(row.id, a.session.accountId);
  assert.equal(row.devices, 1);
  assert.deepEqual(Object.keys(row).sort(), [
    "bytes",
    "createdAt",
    "devices",
    "displayName",
    "email",
    "friends",
    "id",
    "isAdmin",
    "lastSeenAt",
    "quotaBytes",
    "suspendedAt",
  ]);
  const devices = await api.devices(a.session.accountId);
  assert.deepEqual(Object.keys(devices[0]!).sort(), ["addedBy", "createdAt", "id", "kind", "lastSeenAt", "name", "revokedAt"]);
});

test("a suspended account cannot sync or add a device until it is reactivated; an admin cannot suspend themselves", async () => {
  const { a: admin, api } = await adminAccount();
  const { email, a } = await account();
  const user = sessionApi(a.session, server.fetchFn);
  await api.setSuspended(a.session.accountId, true);
  await expectStatus(user.pull(-1, 10), 403);
  await assert.rejects(byPassphrase(server, email), /suspended/);
  await api.setSuspended(a.session.accountId, false);
  await user.pull(-1, 10);
  await expectStatus(api.setSuspended(admin.session.accountId, true), 409);
});

test("an admin revokes a device: its token stops at once; the quota an admin sets is what the account sees", async () => {
  const { api } = await adminAccount();
  const { email, a } = await account();
  const b = await byPassphrase(server, email);
  await api.revokeDevice(a.session.accountId, b.session.deviceId);
  await expectStatus(sessionApi(b.session, server.fetchFn).pull(-1, 10), 401);
  await expectStatus(api.revokeDevice(a.session.accountId, b.session.deviceId), 404);
  await api.setQuota(a.session.accountId, 50 * 1_048_576);
  assert.equal((await sessionApi(a.session, server.fetchFn).me()).usage.quotaBytes, 50 * 1_048_576);
  await expectStatus(api.setQuota(a.session.accountId, 1), 400);
  await expectStatus(api.setQuota("no-such-account", 50 * 1_048_576), 404);
});

test("service health counts accounts, devices and open invites", async () => {
  const { api } = await adminAccount();
  const h = await api.health();
  assert.equal(h.database, "ok");
  assert.ok(h.accounts >= 1 && h.devices >= 1);
  assert.equal(h.build, "local");
});
