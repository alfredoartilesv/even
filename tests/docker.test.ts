import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// The Docker build is the standard way to test and build (docs/dev-setup.md section 4). These checks
// keep it pinned, in step with the native setup, and unable to carry secrets or health data.
const root = join(import.meta.dirname, "..");
const read = (f: string) => readFileSync(join(root, f), "utf8").replace(/\r\n/g, "\n");
const dockerfile = read("Dockerfile");
const ignore = read(".dockerignore")
  .split("\n")
  .map((l) => l.trim())
  .filter((l) => l && !l.startsWith("#"));
const arg = (name: string) => new RegExp(`^ARG ${name}=(.+)$`, "m").exec(dockerfile)?.[1];

test("secrets and health data never enter the Docker build context", () => {
  for (const entry of [".env", ".env.*", "imports", "*.sqlite", "*.db", "node_modules", "android"]) {
    assert.ok(ignore.includes(entry), `.dockerignore must list ${entry}`);
  }
  assert.ok(ignore.includes("!.env.example"), "the example env file (no secrets) may go in");
  assert.doesNotMatch(dockerfile, /GARMIN_API_KEY|ANTHROPIC_API_KEY|--env-file/, "no keys in the image");
});

test("base images are pinned by digest", () => {
  for (const name of ["NODE_IMAGE", "JDK_IMAGE"]) {
    assert.match(arg(name) ?? "", /^[\w./-]+:[\w.-]+@sha256:[0-9a-f]{64}$/, `${name} pinned by digest`);
  }
});

test("Node in the image is the version in .nvmrc, and JDK 21 as in the native setup", () => {
  const nvmrc = read(".nvmrc").trim();
  assert.equal(arg("NODE_VERSION"), nvmrc);
  assert.ok(arg("NODE_IMAGE")!.startsWith(`node:${nvmrc}-`), "the Node image tag matches NODE_VERSION");
  assert.match(arg("JDK_IMAGE")!, /^eclipse-temurin:21-/);
  assert.match(read("docs/dev-setup.md"), /Temurin 21/);
});

test("the Android SDK download is checksum-verified and the SDK packages match the app", () => {
  assert.match(arg("CMDLINE_TOOLS") ?? "", /^commandlinetools-linux-\d+_latest\.zip$/);
  assert.match(arg("CMDLINE_TOOLS_SHA1") ?? "", /^[0-9a-f]{40}$/);
  assert.match(dockerfile, /sha1sum -c -/);
  // One debug key per machine, so a new Docker APK can update the installed one.
  assert.ok(dockerfile.includes("--mount=type=cache,id=health-debug-key,target=/keys"), "the debug key lives in a named build cache");
  assert.ok(dockerfile.includes("cp /keys/debug.keystore /root/.android/debug.keystore"), "Gradle signs with that key");
  // compileSdk and targetSdk 36 (Capacitor 8's android/variables.gradle) and the build-tools in the native setup.
  for (const pkg of ['"platforms;android-36"', '"build-tools;35.0.0"', '"build-tools;36.0.0"']) assert.ok(dockerfile.includes(pkg), pkg);
});

test("stages and npm scripts: test runs the health checks (format, lint, types, duplicates, tests), apk exports only the APK", () => {
  for (const stage of ["deps", "test", "android", "apk"]) assert.match(dockerfile, new RegExp(`^FROM .+ AS ${stage}$`, "m"), `stage ${stage}`);
  assert.match(dockerfile, /RUN npm run health && npx vite build/);
  const health = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).scripts.health as string;
  for (const step of ["format:check", "lint", "typecheck", "dupes", "test"])
    assert.ok(health.includes(`npm run ${step}`) || health.includes(`npm ${step}`), step);
  assert.match(dockerfile, /FROM scratch AS apk\nCOPY --from=android \S+app-debug\.apk/);
  const scripts = JSON.parse(read("package.json")).scripts as Record<string, string>;
  assert.equal(scripts["docker:test"], "docker build --target test .");
  assert.equal(scripts["docker:apk"], "docker build --target apk --output out .");
  assert.ok(
    read(".gitignore")
      .split("\n")
      .some((l) => l.trim() === "out/" || l.trim() === "out"),
    "out/ (the exported APK) is git-ignored",
  );
});
