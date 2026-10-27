/**
 * Signed release APK from Docker: `npm run docker:release` -> out/app-release.apk.
 *
 * The release keystore and its passwords stay outside the repo. This script finds them through
 * an env file (HEALTH_RELEASE_ENV, default %USERPROFILE%/.android/health-release/health-release.env)
 * holding HEALTH_KEYSTORE (path to the .jks), HEALTH_KEYSTORE_PASSWORD, HEALTH_KEY_ALIAS and
 * HEALTH_KEY_PASSWORD, and hands both files to the build as BuildKit secrets, so no secret is ever
 * in an image layer, the build cache key or the command line. The build checks the APK
 * (scripts/release-check.mjs) before exporting it.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const envFile = process.env.HEALTH_RELEASE_ENV ?? join(homedir(), ".android", "health-release", "health-release.env");
if (!existsSync(envFile)) {
  console.error(`No release key env file at ${envFile}. Set HEALTH_RELEASE_ENV (docs/dev-setup.md section 6).`);
  process.exit(1);
}
const vars = Object.fromEntries(
  readFileSync(envFile, "utf8")
    .split(/\r?\n/)
    .map((l) => /^([A-Z_]+)=(.*)$/.exec(l))
    .filter(Boolean)
    .map((m) => [m[1], m[2]]),
);
for (const k of ["HEALTH_KEYSTORE", "HEALTH_KEYSTORE_PASSWORD", "HEALTH_KEY_ALIAS", "HEALTH_KEY_PASSWORD"]) {
  if (!vars[k]) {
    console.error(`${envFile} has no ${k}`);
    process.exit(1);
  }
}
if (!existsSync(vars.HEALTH_KEYSTORE)) {
  console.error(`The keystore ${vars.HEALTH_KEYSTORE} does not exist`);
  process.exit(1);
}

const r = spawnSync(
  "docker",
  [
    "build",
    "--target",
    "release-apk",
    "--secret",
    `id=keystore,src=${vars.HEALTH_KEYSTORE}`,
    "--secret",
    `id=keystore_env,src=${envFile}`,
    "--output",
    "out",
    ".",
  ],
  { stdio: "inherit" },
);
process.exit(r.status ?? 1);
