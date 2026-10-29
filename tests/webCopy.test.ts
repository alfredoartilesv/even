import test from "node:test";
import assert from "node:assert/strict";
import { IDLE_DAYS, idleExpired } from "../src/apps/web/browserCopy";
import { idbDelete, idbGet, idbPut, keepNothing, keepsNothing, openBytes, sealBytes } from "../src/platform/idb";

// docs/users.md section 2.2: how long the web app keeps its copy.
const DAY = 86_400_000;

test(`a browser copy expires after ${IDLE_DAYS} days without being opened, never on the first open`, () => {
  const now = Date.UTC(2026, 9, 28);
  assert.equal(idleExpired(undefined, now), false);
  assert.equal(idleExpired(now - IDLE_DAYS * DAY, now), false);
  assert.equal(idleExpired(now - IDLE_DAYS * DAY - 1, now), true);
});

test("on a shared computer nothing reaches IndexedDB: data, session and sealing key stay in the tab's memory", async () => {
  // Node has no IndexedDB: any write that went there would throw.
  assert.equal(typeof (globalThis as { indexedDB?: unknown }).indexedDB, "undefined");
  assert.equal(keepsNothing(), false);
  keepNothing();
  assert.equal(keepsNothing(), true);
  await idbPut("secret:cloudsync.session", "x");
  assert.equal(await idbGet("secret:cloudsync.session"), "x");
  const sealed = await sealBytes(new TextEncoder().encode("rows"));
  assert.equal(new TextDecoder().decode(await openBytes(sealed)), "rows", "the sealing key is made and kept in memory too");
  await idbDelete("secret:cloudsync.session");
  assert.equal(await idbGet("secret:cloudsync.session"), undefined);
});
