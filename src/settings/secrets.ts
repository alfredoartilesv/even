/**
 * Secrets: the freddy MCP URL and key now, the Claude API key later.
 * On the phone they live in the Android Keystore / iOS Keychain via
 * @aparajita/capacitor-secure-storage (src/settings/secureStore.ts). They are never
 * written to SQLite, so they are never in a backup file either.
 */
export interface SecretStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

export const SECRET_KEYS = {
  freddyUrl: "freddy.mcp_url",
  freddyKey: "freddy.mcp_key",
} as const;

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
}

export async function clearFreddyCredentials(store: SecretStore): Promise<void> {
  await store.remove(SECRET_KEYS.freddyUrl);
  await store.remove(SECRET_KEYS.freddyKey);
}

/** In-memory store for tests and for the browser dev build (nothing persists). */
export function memorySecretStore(): SecretStore {
  const m = new Map<string, string>();
  return {
    async get(k) {
      return m.get(k) ?? null;
    },
    async set(k, v) {
      m.set(k, v);
    },
    async remove(k) {
      m.delete(k);
    },
  };
}
