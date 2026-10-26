import { Capacitor } from "@capacitor/core";
import { SecureStorage } from "@aparajita/capacitor-secure-storage";
import { memorySecretStore, type SecretStore } from "../core/secretStore";

/**
 * Keystore/Keychain-backed store on the phone. In the browser dev build the plugin
 * would fall back to localStorage, so we use a memory store there instead: secrets
 * typed into `npm run dev` are forgotten on reload, by design.
 */
export const secretStore: SecretStore = Capacitor.isNativePlatform()
  ? {
      get: (k) => SecureStorage.getItem(k),
      set: (k, v) => SecureStorage.setItem(k, v),
      remove: (k) => SecureStorage.removeItem(k),
    }
  : memorySecretStore();
