import test from "node:test";
import assert from "node:assert/strict";
import { memorySecretStore } from "../src/core/secretStore";
import { chatAvailable } from "../src/domain/chat/mode";
import { clearClaudeKey, saveClaudeKey } from "../src/domain/settings/secrets";

const KEY = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789";

test("without a key there is no Chat tab", async () => {
  assert.equal(await chatAvailable(memorySecretStore()), false);
});

test("a saved key shows the Chat tab, whatever the connector is doing, and removing it hides the tab", async () => {
  const secrets = memorySecretStore();
  await saveClaudeKey(secrets, KEY);
  assert.equal(await chatAvailable(secrets), true);
  await clearClaudeKey(secrets);
  assert.equal(await chatAvailable(secrets), false);
});
