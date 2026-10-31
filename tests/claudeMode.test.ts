import test from "node:test";
import assert from "node:assert/strict";
import { memorySecretStore } from "../src/core/secretStore";
import { chatAvailable, claudeMode, setClaudeMode } from "../src/domain/chat/mode";
import { saveClaudeKey } from "../src/domain/settings/secrets";
import { migratedDb } from "./helpers";

const KEY = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789";

test("without a key a device starts on the connector and has no Chat tab", async () => {
  const { db } = await migratedDb();
  const secrets = memorySecretStore();
  assert.equal(await claudeMode(db, secrets), "connector");
  assert.equal(await chatAvailable(db, secrets), false);
});

test("a saved key keeps the Chat tab until the owner chooses the connector, and choosing back brings it again", async () => {
  const { db } = await migratedDb();
  const secrets = memorySecretStore();
  await saveClaudeKey(secrets, KEY);
  assert.equal(await claudeMode(db, secrets), "api");
  assert.equal(await chatAvailable(db, secrets), true);
  await setClaudeMode(db, "connector");
  assert.equal(await chatAvailable(db, secrets), false, "the key stays saved, the tab goes");
  await setClaudeMode(db, "api");
  assert.equal(await chatAvailable(db, secrets), true);
});

test("choosing the API key way without a key still shows no Chat tab", async () => {
  const { db } = await migratedDb();
  const secrets = memorySecretStore();
  await setClaudeMode(db, "api");
  assert.equal(await chatAvailable(db, secrets), false);
});
