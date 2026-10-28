import { createLogger } from "../../core/log";
import type { SecretStore } from "../../core/secretStore";

export { memorySecretStore, type SecretStore } from "../../core/secretStore";

/**
 * Secrets: the Garmin personal API key and the Claude API key.
 * On the phone they live in the Android Keystore / iOS Keychain via
 * @aparajita/capacitor-secure-storage (src/platform/secureStore.ts). They are never
 * written to SQLite, so they are never in a backup file either.
 */

const log = createLogger("settings.secrets");

export const SECRET_KEYS = {
  claudeKey: "anthropic.api_key",
  garminKey: "garmin.api_key",
} as const;

export async function loadGarminKey(store: SecretStore): Promise<string | null> {
  return (await store.get(SECRET_KEYS.garminKey))?.trim() || null;
}

/** Trimmed key, or a message safe to show when it cannot be a Garmin Connect personal API key. */
export function normalizeGarminKey(apiKey: string): string {
  const k = apiKey.trim();
  if (!k) throw new Error("Paste the personal API key from Garmin Connect");
  if (/\s/.test(k) || k.length < 16) throw new Error("That does not look like a Garmin personal API key");
  return k;
}

/** The Garmin Connect personal API key. Shape check only: connectGarmin checks it with Garmin first. */
export async function saveGarminKey(store: SecretStore, apiKey: string): Promise<void> {
  await store.set(SECRET_KEYS.garminKey, normalizeGarminKey(apiKey));
  log.info("Garmin API key saved");
}

export async function clearGarminKey(store: SecretStore): Promise<void> {
  await store.remove(SECRET_KEYS.garminKey);
  log.info("Garmin API key removed");
}

export async function loadClaudeKey(store: SecretStore): Promise<string | null> {
  return (await store.get(SECRET_KEYS.claudeKey))?.trim() || null;
}

/** Trimmed key if it has the shape of an Anthropic API key; throws a message safe to show otherwise. */
export function normalizeClaudeKey(apiKey: string): string {
  const k = apiKey.trim();
  if (!/^sk-ant-[A-Za-z0-9_-]{20,}$/.test(k)) throw new Error("That does not look like an Anthropic API key (it starts with sk-ant-)");
  return k;
}

/** The user's own Anthropic API key. Shape check only: connectClaude (domain/chat/connect.ts) verifies it first. */
export async function saveClaudeKey(store: SecretStore, apiKey: string): Promise<void> {
  const k = normalizeClaudeKey(apiKey);
  await store.set(SECRET_KEYS.claudeKey, k);
  log.info("Claude API key saved");
}

export async function clearClaudeKey(store: SecretStore): Promise<void> {
  await store.remove(SECRET_KEYS.claudeKey);
  log.info("Claude API key removed");
}

/** Where the earlier freddy sync kept its MCP URL and key. Only read to delete them. */
const LEGACY_FREDDY_KEYS = ["freddy.mcp_url", "freddy.mcp_key"];

/** Remove the freddy URL and key a phone may still hold from before the Garmin sync. Safe to call on every start. */
export async function removeLegacySecrets(store: SecretStore): Promise<void> {
  let removed = 0;
  for (const k of LEGACY_FREDDY_KEYS) {
    if ((await store.get(k)) === null) continue;
    await store.remove(k);
    removed++;
  }
  if (removed) log.info("old freddy credentials removed", { removed });
}
