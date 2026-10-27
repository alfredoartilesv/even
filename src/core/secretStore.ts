/**
 * Where secrets live (Garmin key, Claude key). Implemented by the Keystore/Keychain
 * adapter in src/platform/secureStore.ts; tests and the browser build use the memory store.
 */
export interface SecretStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

/** In-memory store: tests, and the browser dev build (forgotten on reload). */
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
