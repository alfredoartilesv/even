/**
 * The browser's own storage for the web app (docs/users.md section 2.2): one IndexedDB database with
 * one object store, holding the sealed database file, the sealed secrets, and the non-extractable
 * AES key that seals them (a CryptoKey can be stored, never read back as bytes). Browser only.
 */
const NAME = "even";
const STORE = "kv";

let opening: Promise<IDBDatabase> | null = null;

function db(): Promise<IDBDatabase> {
  opening ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB did not open"));
  });
  return opening;
}

function run<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest): Promise<T> {
  return db().then(
    (d) =>
      new Promise<T>((resolve, reject) => {
        const req = fn(d.transaction(STORE, mode).objectStore(STORE));
        req.onsuccess = () => resolve(req.result as T);
        req.onerror = () => reject(req.error ?? new Error("IndexedDB request failed"));
      }),
  );
}

/**
 * On a shared computer (ticked when connecting) nothing goes to IndexedDB: the database file, the
 * session and the sealing key live in this map, so closing or reloading the tab forgets them all.
 * There is no way back to storing in the same tab: a reload starts clean.
 */
let memory: Map<string, unknown> | null = null;
export function keepNothing(): void {
  memory ??= new Map();
}
export const keepsNothing = () => memory !== null;

export const idbGet = <T>(key: string) => (memory ? Promise.resolve(memory.get(key) as T | undefined) : run<T | undefined>("readonly", (s) => s.get(key)));
export const idbPut = (key: string, value: unknown) =>
  memory ? Promise.resolve(void memory.set(key, value)) : run<void>("readwrite", (s) => s.put(value, key));
export const idbDelete = (key: string) => (memory ? Promise.resolve(void memory.delete(key)) : run<void>("readwrite", (s) => s.delete(key)));

/** Deletes this browser's whole store, the sealing key included (a copy left unused too long). */
export async function idbReset(): Promise<void> {
  if (opening) (await opening).close();
  opening = null;
  await new Promise<void>((resolve, reject) => {
    const req = indexedDB.deleteDatabase(NAME);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error ?? new Error("IndexedDB was not deleted"));
    req.onblocked = () => resolve(); // finishes once nothing holds it; the page reloads after
  });
}

/** The key everything here is sealed with: made once per browser profile, never extractable. */
export async function deviceKey(): Promise<CryptoKey> {
  const existing = await idbGet<CryptoKey>("device-key");
  if (existing) return existing;
  const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  await idbPut("device-key", key);
  return key;
}

export async function sealBytes(plain: Uint8Array): Promise<{ iv: Uint8Array; data: ArrayBuffer }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  return { iv, data: await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await deviceKey(), plain as BufferSource) };
}

export async function openBytes(sealed: { iv: Uint8Array; data: ArrayBuffer }): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: sealed.iv as BufferSource }, await deviceKey(), sealed.data));
}
