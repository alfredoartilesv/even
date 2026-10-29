import test from "node:test";
import assert from "node:assert/strict";
import { applySignIn, getOwner, parseGoogleIdToken, releaseOwnership, signOut, type GoogleIdentity } from "../src/domain/account/account";
import { signInWithGoogle, signOutOfGoogle } from "../src/domain/account/service";
import { exportBackup, restoreBackup } from "../src/domain/backup/backup";
import { migratedDb } from "./helpers";

const CLIENT = "123-web.apps.googleusercontent.com";
const NOW = Date.UTC(2026, 9, 26, 10, 0, 0);
const DEV = "device-1";

/** An unsigned JWT with these claims (the app checks claims, not the signature: see account.ts). */
function idToken(claims: Record<string, unknown>): string {
  const b64url = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64url({ alg: "RS256", typ: "JWT" })}.${b64url(claims)}.sig`;
}
const good = (over: Record<string, unknown> = {}) =>
  idToken({
    iss: "https://accounts.google.com",
    aud: CLIENT,
    sub: "1001",
    email: "ana@example.com",
    email_verified: true,
    name: "Ana",
    exp: NOW / 1000 + 3600,
    ...over,
  });

const ana: GoogleIdentity = { subject: "1001", email: "ana@example.com", emailVerified: true, name: "Ana" };
const ben: GoogleIdentity = { subject: "2002", email: "ben@example.com", emailVerified: true, name: "Ben" };

test("ID token claims are read and checked: issuer, audience, expiry, subject", () => {
  assert.deepEqual(parseGoogleIdToken(good(), { webClientId: CLIENT, now: NOW }), ana);
  assert.equal(parseGoogleIdToken(good({ iss: "accounts.google.com", email_verified: "true" }), { webClientId: CLIENT, now: NOW }).emailVerified, true);
  assert.equal(parseGoogleIdToken(good({ aud: ["other", CLIENT] }), { webClientId: CLIENT, now: NOW }).subject, "1001");
  const bad: [string, RegExp][] = [
    ["not.a-jwt", /unreadable/],
    [good({ iss: "https://evil.example" }), /not issued by Google/],
    [good({ aud: "someone-else" }), /different app/],
    [good({ exp: NOW / 1000 - 3600 }), /expired/],
    [good({ sub: "" }), /no account id/],
  ];
  for (const [token, msg] of bad) assert.throws(() => parseGoogleIdToken(token, { webClientId: CLIENT, now: NOW }), msg);
  // Five minutes of clock skew are tolerated.
  assert.doesNotThrow(() => parseGoogleIdToken(good({ exp: NOW / 1000 - 120 }), { webClientId: CLIENT, now: NOW }));
});

test("first sign-in binds the owner and adopts existing data; the owner signs in again; another account is refused", async () => {
  const { db } = await migratedDb();
  await db.run(
    `INSERT INTO food_entries (id, eaten_at_ms, offset_min, local_day, name, created_at, updated_at, origin_device_id)
     VALUES ('f1', ?, 60, '2026-10-26', 'Toast', ?, ?, ?)`,
    [NOW, NOW, NOW, DEV],
  );
  assert.equal(await getOwner(db), null);

  const first = await applySignIn(db, ana, DEV, NOW);
  assert.equal(first.status, "bound");
  const owner = await getOwner(db);
  assert.deepEqual({ ...owner }, { provider: "google", ...ana, boundAtMs: NOW, lastSignInMs: NOW, signedIn: true });
  assert.equal((await db.all("SELECT * FROM food_entries")).length, 1, "existing data stays, now under the owner");

  await signOut(db, NOW + 1);
  assert.equal((await getOwner(db))!.signedIn, false, "signing out keeps the binding");

  const again = await applySignIn(db, { ...ana, email: "ana.new@example.com" }, DEV, NOW + 2);
  assert.equal(again.status, "signed_in");
  assert.equal((await getOwner(db))!.email, "ana.new@example.com", "email refreshed, subject is the key");
  assert.equal((await getOwner(db))!.boundAtMs, NOW);

  const other = await applySignIn(db, ben, DEV, NOW + 3);
  assert.deepEqual(other, { status: "other_owner", ownerEmail: "ana.new@example.com" });
  assert.equal((await getOwner(db))!.subject, "1001", "nothing changed");
});

test("releasing ownership lets the next account bind, and the data stays", async () => {
  const { db } = await migratedDb();
  await applySignIn(db, ana, DEV, NOW);
  await releaseOwnership(db, NOW + 1);
  assert.equal(await getOwner(db), null);
  const res = await applySignIn(db, ben, DEV, NOW + 2);
  assert.equal(res.status, "bound");
  assert.equal((await getOwner(db))!.subject, "2002");
  assert.equal((await db.all("SELECT * FROM account")).length, 1, "one row, re-bound in place");
});

test("a backup from another Google account is refused; on a fresh phone it restores with its owner", async () => {
  const { db: anaPhone } = await migratedDb();
  await applySignIn(anaPhone, ana, DEV, NOW);
  const { text } = await exportBackup(anaPhone, "correct horse battery", { iterations: 1000, now: NOW });

  const { db: benPhone } = await migratedDb();
  await applySignIn(benPhone, ben, DEV, NOW);
  await assert.rejects(restoreBackup(benPhone, text, "correct horse battery"), /belongs to another Google account \(ana@example.com\)/);
  assert.equal((await getOwner(benPhone))!.subject, "2002");

  const { db: fresh } = await migratedDb();
  await restoreBackup(fresh, text, "correct horse battery");
  assert.equal((await getOwner(fresh))!.subject, "1001", "the phone now belongs to the backup's owner");

  const { db: same } = await migratedDb();
  await applySignIn(same, ana, DEV, NOW + 5);
  await assert.doesNotReject(restoreBackup(same, text, "correct horse battery"));
});

test("sign-in flow: cancelled, plugin failure, bad token and success", async () => {
  const { db } = await migratedDb();
  const run = (signIn: () => Promise<string | null>) => signInWithGoogle(db, { signIn, webClientId: CLIENT, now: () => NOW });

  assert.deepEqual(await run(async () => null), { status: "cancelled" });
  const failed = await run(async () => {
    throw new Error("GetCredentialException: no network");
  });
  assert.equal(failed.status, "error");
  assert.ok(failed.status === "error" && !failed.message.includes("GetCredential"), "plugin internals are not shown");
  const wrongApp = await run(async () => good({ aud: "other" }));
  assert.ok(wrongApp.status === "error" && /different app/.test(wrongApp.message));
  assert.equal(await getOwner(db), null, "nothing bound by a failed sign-in");

  const ok = await run(async () => good());
  assert.equal(ok.status, "bound");

  let deviceSignedOut = false;
  await signOutOfGoogle(db, {
    signOut: async () => {
      deviceSignedOut = true;
      throw new Error("plugin hiccup");
    },
    now: () => NOW + 1,
  });
  assert.equal(deviceSignedOut, true);
  assert.equal((await getOwner(db))!.signedIn, false, "local sign-out happens even if the plugin fails");
});

test("one identity: a connected device restores only its own sync account's backups, whatever Google says", async () => {
  const pw = "correct horse battery";
  const fast = { iterations: 1000, now: NOW };
  const { db: phone } = await migratedDb();
  await applySignIn(phone, ana, DEV, NOW);
  const { text } = await exportBackup(phone, pw, { ...fast, syncAccountId: "acct-1" });

  const { db: other } = await migratedDb();
  await assert.rejects(restoreBackup(other, text, pw, { syncAccountId: "acct-2" }), /another Even account/);

  // Same sync account: restores even though this device's local Google owner differs.
  const { db: mine } = await migratedDb();
  await applySignIn(mine, ben, DEV, NOW);
  await restoreBackup(mine, text, pw, { syncAccountId: "acct-1" });

  // Not connected, or a backup made before connecting: the Google owner check, as before.
  const { db: offline } = await migratedDb();
  await applySignIn(offline, ben, DEV, NOW);
  await assert.rejects(restoreBackup(offline, text, pw), /another Google account/);
  const { text: older } = await exportBackup(phone, pw, fast);
  await assert.rejects(restoreBackup(offline, older, pw, { syncAccountId: "acct-1" }), /another Google account/);
});
