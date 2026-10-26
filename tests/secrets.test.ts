import test from "node:test";
import assert from "node:assert/strict";
import {
  clearClaudeKey,
  clearFreddyCredentials,
  loadClaudeKey,
  loadFreddyCredentials,
  memorySecretStore,
  saveClaudeKey,
  saveFreddyCredentials,
} from "../src/features/settings/secrets";

test("freddy credentials: validate, trim, store, and clear", async () => {
  const store = memorySecretStore();
  assert.equal(await loadFreddyCredentials(store), null);
  await assert.rejects(saveFreddyCredentials(store, "not a url", "k"), /not a valid URL/);
  await assert.rejects(saveFreddyCredentials(store, "http://freddy.coach/mcp/x", "k"), /https/);

  await saveFreddyCredentials(store, "  https://freddy.coach/mcp/x  ", " fk_1 ");
  assert.deepEqual(await loadFreddyCredentials(store), { url: "https://freddy.coach/mcp/x", apiKey: "fk_1" });

  await saveFreddyCredentials(store, "https://freddy.coach/mcp/x", "");
  assert.deepEqual(await loadFreddyCredentials(store), { url: "https://freddy.coach/mcp/x", apiKey: null });

  await clearFreddyCredentials(store);
  assert.equal(await loadFreddyCredentials(store), null);
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