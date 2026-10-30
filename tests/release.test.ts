import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { patchGradle, versionCode } from "../scripts/android-gradle.mjs";

// Releases: version and signing in the generated Gradle file, the Docker release stage, and the
// two workflows (PRs only test; a push to master builds, checks, tags and publishes).
const root = join(import.meta.dirname, "..");
const read = (f: string) => readFileSync(join(root, f), "utf8").replace(/\r\n/g, "\n");

// The shape `npx cap add android` generates (Capacitor 8).
const GENERATED = `android {
    defaultConfig {
        applicationId "app.health.personal"
        versionCode 1
        versionName "1.0"
    }
    buildTypes {
        release {
            minifyEnabled false
            proguardFiles getDefaultProguardFile('proguard-android.txt'), 'proguard-rules.pro'
        }
    }
}
`;

test("versionCode grows with every version and refuses what Android cannot order", () => {
  assert.equal(versionCode("0.1.0"), 100);
  assert.equal(versionCode("1.2.3"), 10203);
  assert.ok(versionCode("0.1.1") > versionCode("0.1.0") && versionCode("0.2.0") > versionCode("0.1.99") && versionCode("1.0.0") > versionCode("0.99.99"));
  assert.throws(() => versionCode("1.2"), /MAJOR.MINOR.PATCH/);
  assert.throws(() => versionCode("1.2.3-beta"), /MAJOR.MINOR.PATCH/);
  assert.throws(() => versionCode("1.100.0"), /below 100/);
  assert.throws(() => versionCode("0.0.0"), /at least 1/);
});

test("the Gradle patch sets the version and signs releases from the environment, idempotently", () => {
  const once = patchGradle(GENERATED, "0.3.1");
  assert.match(once, /versionCode 301\n/);
  assert.match(once, /versionName "0\.3\.1"\n/);
  assert.match(once, /signingConfigs \{\n\s+release \{\n\s+if \(System\.getenv\("HEALTH_KEYSTORE"\)\)/);
  assert.match(once, /buildTypes \{\n\s+release \{\n\s+signingConfig signingConfigs\.release\n\s+minifyEnabled false/);
  for (const v of ["HEALTH_KEYSTORE_PASSWORD", "HEALTH_KEY_ALIAS", "HEALTH_KEY_PASSWORD"]) assert.ok(once.includes(`System.getenv("${v}")`), v);
  assert.equal(patchGradle(once, "0.3.1"), once, "running it again changes nothing");
  assert.equal(patchGradle(once, "0.4.0").match(/signingConfigs \{/g)!.length, 1, "one signing block after a version bump");
  assert.match(patchGradle(once, "0.4.0"), /versionCode 400\n/);
});

test("the Gradle patch also signs a build.gradle generated on Windows (CRLF)", () => {
  const crlf = patchGradle(GENERATED.replace(/\n/g, "\r\n"), "0.3.1");
  assert.match(crlf, /buildTypes \{\r\n\s+release \{\r\n\s+signingConfig signingConfigs\.release\r\n\s+minifyEnabled false/);
  assert.equal(patchGradle(crlf, "0.3.1"), crlf, "running it again changes nothing");
  assert.throws(() => patchGradle("android {\n    buildTypes {\n    }\n}\n", "0.3.1"), /no buildTypes \{ release \{ block/);
});

test("the package.json version is a releasable version", () => {
  const { version } = JSON.parse(read("package.json"));
  assert.ok(versionCode(version) >= 1);
});

test("the release cert fingerprint is committed (public) and the keystore is not", () => {
  assert.match(read("release/cert-sha256.txt").trim(), /^[0-9a-f]{64}$/);
  const ignored = read(".gitignore") + read(".dockerignore");
  for (const p of ["*.jks", "*.keystore"])
    assert.ok(
      ignored.split("\n").some((l) => l.trim() === p),
      `${p} ignored by git and Docker`,
    );
});

test("the Docker release stage gets the keystore only as BuildKit secrets and checks the APK", () => {
  const df = read("Dockerfile");
  assert.match(df, /^FROM android-base AS release$/m);
  assert.match(df, /--mount=type=secret,id=keystore,target=\/run\/secrets\/keystore\.jks,required=true/);
  assert.match(df, /--mount=type=secret,id=keystore_env,target=\/run\/secrets\/keystore\.env,required=true/);
  assert.match(df, /assembleRelease[\s\\]+&& cd \.\. && node scripts\/release-check\.mjs --apk android\/app\/build\/outputs\/apk\/release\/app-release\.apk/);
  assert.match(df, /^FROM scratch AS release-apk\nCOPY --from=release \S+app-release\.apk/m);
  // Never as ARG or ENV: those end up in the image history.
  assert.doesNotMatch(df, /^(ARG|ENV)\b.*(PASSWORD|KEYSTORE)/m);
  assert.equal(JSON.parse(read("package.json")).scripts["docker:release"], "node scripts/docker-release.mjs");
});

test("release.yml is the only workflow: nothing runs on PRs or develop", () => {
  assert.deepEqual(readdirSync(join(root, ".github/workflows")), ["release.yml"]);
});

test("a push to master builds, checks, then tags and publishes the release", () => {
  const rel = read(".github/workflows/release.yml");
  assert.match(rel, /on:\n\s+push:\n\s+branches: \[master\]\n/);
  assert.doesNotMatch(rel, /pull_request|branches: \[develop/, "never on PRs or develop");
  // Version gate, then build -> publish, in that order. No emulator job (Actions minutes).
  assert.match(rel, /git ls-remote --exit-code --tags origin "refs\/tags\/v\$V"/);
  assert.match(rel, /build:\n[\s\S]*needs: version/);
  assert.doesNotMatch(rel, /emulator/);
  assert.match(rel, /publish:\n[\s\S]*needs: \[version, build\]/);
  assert.match(rel, /target: release-apk/);
  assert.match(rel, /secret-files: \|\n\s+keystore=\$\{\{ runner\.temp \}\}\/release\.jks\n\s+keystore_env=\$\{\{ runner\.temp \}\}\/release\.env/);
  assert.match(rel, /gh release create "\$TAG" "out\/even-\$TAG\.apk"/);
  // Only the publish job can write (tag and release); everything else reads.
  assert.match(rel, /^permissions:\n\s+contents: read$/m);
  assert.equal((rel.match(/contents: write/g) ?? []).length, 1);
  assert.match(rel, /publish:[\s\S]*permissions:\n\s+contents: write/);
});
