/**
 * Changes to the generated android/app/build.gradle, as pure functions (tests/release.test.ts).
 * Applied by scripts/android-harden.mjs after every `cap add` / `cap sync`.
 *
 * - versionName = package.json version; versionCode derived from it (Android needs it to grow
 *   with every release: 1.2.3 -> 10203).
 * - A release signing config that reads the keystore and its passwords from the environment
 *   (HEALTH_KEYSTORE, HEALTH_KEYSTORE_PASSWORD, HEALTH_KEY_ALIAS, HEALTH_KEY_PASSWORD), so no
 *   secret is ever written into a file. Without them a release build fails, never ships unsigned.
 */

/** "1.2.3" -> 10203. Each part must stay under 100. */
export function versionCode(version) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!m) throw new Error(`package.json version "${version}" is not MAJOR.MINOR.PATCH`);
  const [major, minor, patch] = m.slice(1).map(Number);
  if (minor > 99 || patch > 99) throw new Error(`version ${version}: minor and patch must be below 100`);
  const code = major * 10000 + minor * 100 + patch;
  if (code < 1) throw new Error("versionCode must be at least 1 (0.0.0 is not a release)");
  return code;
}

const SIGNING_MARK = "// health-app: release signing from the environment";
const SIGNING = `    ${SIGNING_MARK}
    signingConfigs {
        release {
            if (System.getenv("HEALTH_KEYSTORE")) {
                storeFile file(System.getenv("HEALTH_KEYSTORE"))
                storePassword System.getenv("HEALTH_KEYSTORE_PASSWORD")
                keyAlias System.getenv("HEALTH_KEY_ALIAS")
                keyPassword System.getenv("HEALTH_KEY_PASSWORD")
            }
        }
    }
`;

/** The patched build.gradle text. Idempotent. */
export function patchGradle(gradle, version) {
  let g = gradle.replace(/versionName\s+\S+/, `versionName "${version}"`).replace(/versionCode\s+\d+/, `versionCode ${versionCode(version)}`);
  if (!g.includes(SIGNING_MARK)) {
    if (!/\n    buildTypes \{/.test(g)) throw new Error("build.gradle has no buildTypes block");
    g = g.replace(/\n    buildTypes \{/, `\n${SIGNING}    buildTypes {`);
  }
  if (!/release \{\n\s*signingConfig signingConfigs\.release/.test(g)) {
    g = g.replace(/(buildTypes \{\n\s*release \{\n)/, "$1            signingConfig signingConfigs.release\n");
  }
  return g;
}
