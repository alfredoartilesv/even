import test from "node:test";
import assert from "node:assert/strict";
import {
  clearClaudeKey,
  clearGarminKey,
  loadClaudeKey,
  loadGarminKey,
  memorySecretStore,
  removeLegacySecrets,
  saveClaudeKey,
  saveGarminKey,
  SECRET_KEYS,
} from "../src/features/settings/secrets";

test("Garmin personal API key: shape check, trim, store, clear", async () => {
  const store = memorySecretStore();
  assert.equal(await loadGarminKey(store), null);
  await assert.rejects(saveGarminKey(store, "   "), /Paste the personal API key/);
  await assert.rejects(saveGarminKey(store, "short"), /does not look like/);
  await assert.rejects(saveGarminKey(store, "has a space in the middle of it"), /does not look like/);
  await saveGarminKey(store, "  gpk_abcdefghijklmnopqrstuvwxyz  ");
  assert.equal(await loadGarminKey(store), "gpk_abcdefghijklmnopqrstuvwxyz");
  assert.equal(await store.get(SECRET_KEYS.garminKey), "gpk_abcdefghijklmnopqrstuvwxyz", "in secure storage, under its own name");
  await clearGarminKey(store);
  assert.equal(await loadGarminKey(store), null);
});

test("the freddy URL and key a phone still holds are removed, and nothing else", async () => {
  const store = memorySecretStore();
  await store.set("freddy.mcp_url", "https://freddy.coach/mcp/x");
  await store.set("freddy.mcp_key", "fk_1");
  await saveGarminKey(store, "gpk_abcdefghijklmnopqrstuvwxyz");
  await saveClaudeKey(store, "sk-ant-api03-abcdefghijklmnopqrstuvwxyz");

  await removeLegacySecrets(store);
  assert.equal(await store.get("freddy.mcp_url"), null);
  assert.equal(await store.get("freddy.mcp_key"), null);
  assert.equal(await loadGarminKey(store), "gpk_abcdefghijklmnopqrstuvwxyz");
  assert.equal(await loadClaudeKey(store), "sk-ant-api03-abcdefghijklmnopqrstuvwxyz");
  await removeLegacySecrets(store); // again: nothing to do, no error
});

test("Claude API key: shape check, trim, store, clear", async () => {
  const store = memorySecretStore();
  assert.equal(await loadClaudeKey(store), null);
  await assert.rejects(saveClaudeKey(store, "sk-proj-abc"), /starts with sk-ant-/);
  await saveClaudeKey(store, "  sk-ant-api03-abcdefghijklmnopqrstuvwxyz  ");
  assert.equal(await loadClaudeKey(store), "sk-ant-api03-abcdefghijklmnopqrstuvwxyz");
  await clearClaudeKey(store);
  assert.equal(await loadClaudeKey(store), null);
});