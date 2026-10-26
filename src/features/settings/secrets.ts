import { createLogger } from "../../core/log";
import type { SecretStore } from "../../core/secretStore";

export { memorySecretStore, type SecretStore } from "../../core/secretStore";

/**
 * Secrets: the Garmin personal API key, the Claude API key (and the freddy MCP URL and key of
 * the earlier sync, no longer used by the app).
 * On the phone they live in the Android Keystore / iOS Keychain via
 * @aparajita/capacitor-secure-storage (src/platform/secureStore.ts). They are never
 * written to SQLite, so they are never in a backup file either.
 */

const log = createLogger("settings.secrets");

export const SECRET_KEYS = {
  freddyUrl: "freddy.mcp_url",
  freddyKey: "freddy.mcp_key",
  claudeKey: "anthropic.api_key",
  garminKey: "garmin.api_key",
} as const;

export async function loadGarminKey(store: SecretStore): Promise<string | null> {
  return (await store.get(SECRET_KEYS.garminKey))?.trim() || null;
}

/** The Garmin Connect personal API key. Shape check only: the first sync is the real test. */
export async function saveGarminKey(store: SecretStore, apiKey: string): Promise<void> {
  const k = apiKey.trim();
  if (!k) throw new Error("Paste the personal API key from Garmin Connect");
  if (/\s/.test(k) || k.length < 16) throw new Error("That does not look like a Garmin personal API key");
  await store.set(SECRET_KEYS.garminKey, k);
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

/** The user's own Anthropic API key. Shape check only: connectClaude (features/chat/connect.ts) verifies it first. */
export async function saveClaudeKey(store: SecretStore, apiKey: string): Promise<void> {
  const k = normalizeClaudeKey(apiKey);
  await store.set(SECRET_KEYS.claudeKey, k);
  log.info("Claude API key saved");
}

export async function clearClaudeKey(store: SecretStore): Promise<void> {
  await store.remove(SECRET_KEYS.claudeKey);
  log.info("Claude API key removed");
}

export interface FreddyCredentials {
  url: string;
  apiKey: string | null;
}

export async function loadFreddyCredentials(store: SecretStore): Promise<FreddyCredentials | null> {
  const url = (await store.get(SECRET_KEYS.freddyUrl))?.trim();
  if (!url) return null;
  const apiKey = (await store.get(SECRET_KEYS.freddyKey))?.trim() || null;
  return { url, apiKey };
}

/** Validate and store. An empty key removes it (freddy currently needs one, see docs 4b). */
export async function saveFreddyCredentials(store: SecretStore, url: string, apiKey: string): Promise<void> {
  const u = url.trim();
  let parsed: URL;
  try {
    parsed = new URL(u);
  } catch {
    throw new Error("The freddy MCP URL is not a valid URL");
  }
  if (parsed.protocol !== "https:") throw new Error("The freddy MCP URL must start with https://");
  await store.set(SECRET_KEYS.freddyUrl, u);
  const k = apiKey.trim();
  if (k) await store.set(SECRET_KEYS.freddyKey, k);
  else await store.remove(SECRET_KEYS.freddyKey);
  log.info("freddy credentials saved", { hasKey: Boolean(k) });
}

export async function clearFreddyCredentials(store: SecretStore): Promise<void> {
  await store.remove(SECRET_KEYS.freddyUrl);
  await store.remove(SECRET_KEYS.freddyKey);
  log.info("freddy credentials removed");
}

