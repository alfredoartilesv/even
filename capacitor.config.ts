import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "app.health.personal",
  appName: "Health",
  webDir: "dist",
  plugins: {
    // SQLCipher on both platforms; the passphrase is kept in the plugin's secure store.
    CapacitorSQLite: {
      androidIsEncryption: true,
      androidBiometric: { biometricAuth: false },
      iosIsEncryption: true,
      iosKeychainPrefix: "app.health.personal",
      iosBiometric: { biometricAuth: false },
    },
  },
};

export default config;
