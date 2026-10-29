import { Capacitor } from "@capacitor/core";
import { SecureStorage } from "@aparajita/capacitor-secure-storage";
import type { SecretStore } from "../core/secretStore";
import { idbDelete, idbGet, idbPut, openBytes, sealBytes } from "./idb";

/**
 * Keystore/Keychain-backed store on the phone. In the browser the plugin would fall back to
 * localStorage (readable by any script, unsealed), so the web app keeps secrets in IndexedDB
 * instead, sealed with this browser profile's non-extractable key (idb.ts): the sync session
 * survives a reload, and nothing is readable on disk.
 */
const webStore: SecretStore = {
  async get(k) {
    const sealed = await idbGet<{ iv: Uint8Array; data: ArrayBuffer }>(`secret:${k}`);
    return sealed ? new TextDecoder().decode(await openBytes(sealed)) : null;
  },
  async set(k, v) {
    await idbPut(`secret:${k}`, await sealBytes(new TextEncoder().encode(v)));
  },
  async remove(k) {
    await idbDelete(`secret:${k}`);
  },
};

export const secretStore: SecretStore = Capacitor.isNativePlatform()
  ? {
      get: (k) => SecureStorage.getItem(k),
      set: (k, v) => SecureStorage.setItem(k, v),
      remove: (k) => SecureStorage.removeItem(k),
    }
  : webStore;
