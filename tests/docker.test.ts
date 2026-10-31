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

const compose = read("docker-compose.yml");

test("the sync environment: db, sync and web, images pinned, ports on this PC only, no real secrets", () => {
  for (const svc of ["db", "sync", "web"]) assert.match(compose, new RegExp(`^  ${svc}:$`, "m"), `service ${svc}`);
  assert.match(compose, /image: postgres:17\.\d+-alpine@sha256:[0-9a-f]{64}$/m, "Postgres 17 (as on Neon) pinned by digest");
  for (const target of ["sync", "web"]) {
    assert.match(compose, new RegExp(`build: \\{ context: \\., target: ${target} \\}`), `${target} is built from the Dockerfile`);
    assert.match(dockerfile, new RegExp(`^FROM deps AS ${target}$`, "m"), `stage ${target}`);
  }
  const ports = [...compose.matchAll(/ports: \[(.+)\]/g)].map((m) => m[1]);
  assert.equal(ports.length, 5, "db, sync, web and the two simulated phones");
  for (const p of ports) assert.match(p, /^"127\.0\.0\.1:\d+:\d+"$/, "listens on 127.0.0.1 only");
  assert.doesNotMatch(compose, /GARMIN_API_KEY|ANTHROPIC_API_KEY|SYNC_SECRET|SYNC_TOKEN/, "no keys or sync secrets in compose");
  assert.match(compose, /POSTGRES_PASSWORD: \$\{POSTGRES_PASSWORD:-[\w-]+\}/, "the local database password can be overridden from .env");
  assert.match(dockerfile, /FROM deps AS sync\n[\s\S]*?USER node/, "the sync server does not run as root");
});

test("the simulated phones: their own stage and volumes, off unless asked for, and the check drives them over the compose network", () => {
  assert.match(dockerfile, /^FROM sync AS phone$/m, "a phone runs the sync stage's code");
  assert.match(dockerfile, /FROM sync AS phone\n[\s\S]*?USER node\nENV PORT=8790/, "and not as root");
  for (const svc of ["phone-a", "phone-b", "phones-check"]) assert.match(compose, new RegExp(`^  ${svc}:`, "m"), `service ${svc}`);
  assert.match(compose, /phone-a: &phone\n    build: \{ context: \., target: phone \}\n    profiles: \[phones\]/, "docker:up alone starts no phone");
  for (const v of ["phone-a-data", "phone-b-data"]) assert.match(compose, new RegExp(`^  ${v}:$`, "m"), `volume ${v}: a phone keeps its database`);
  assert.match(compose, /PHONE_URLS: http:\/\/phone-a:8790,http:\/\/phone-b:8790/);
  const scripts = JSON.parse(read("package.json")).scripts as Record<string, string>;
  assert.equal(scripts["docker:phones"], "docker compose --profile phones up -d --build --wait");
  assert.match(scripts["docker:down"], /--profile phones down/, "docker:down stops the phones too");
});

test("vercel.json serves the web build and sends the API, both MCP servers and their OAuth to the sync function", () => {
  const vercel = JSON.parse(read("vercel.json")) as {
    buildCommand: string;
    outputDirectory: string;
    git: { deploymentEnabled: Record<string, boolean> };
    rewrites: { source: string; destination: string }[];
    functions: Record<string, { includeFiles?: string }>;
  };
  // Each deployed branch gets its own Neon database branch, and the free plan has few: develop
  // (preview) and master (production) only, never a feature branch. Minimatch: `*` stops at a slash (feat/x), `**` does not.
  assert.deepEqual(vercel.git.deploymentEnabled, { "**": false, develop: true, master: true });
  assert.equal(vercel.buildCommand, "npm run vercel-build");
  assert.equal(vercel.outputDirectory, "dist");
  assert.deepEqual(
    vercel.rewrites.map((r) => r.source),
    [
      "/v1/:path*",
      "/health",
      "/mcp",
      "/mcp/health",
      "/oauth/:path*",
      "/.well-known/oauth-protected-resource",
      "/.well-known/oauth-protected-resource/mcp",
      "/.well-known/oauth-protected-resource/mcp/health",
      "/.well-known/oauth-authorization-server",
    ],
  );
  // The health connector migrates an in-memory copy of the app's database (server/sqlite.ts), from files nothing imports.
  assert.equal(vercel.functions["api/index.ts"]?.includeFiles, "src/db/migrations/**");
  // One function at /api: Vercel matched a catch-all file for one path segment only.
  for (const r of vercel.rewrites) assert.equal(r.destination, `/api?__path=${r.source}`, "the function gets the original path");
  const scripts = JSON.parse(read("package.json")).scripts as Record<string, string>;
  assert.match(scripts["vercel-build"], /server\/cli\.ts migrate && npm run build/, "migrations run in the build, never on a request");
});

test("the Vercel function exports every method the API routes use", () => {
  const fn = readFileSync(join(import.meta.dirname, "../api/index.ts"), "utf8");
  const app = readFileSync(join(import.meta.dirname, "../server/app.ts"), "utf8");
  const used = new Set([...app.matchAll(/app\.(get|post|put|delete)\(/g)].map((m) => m[1]!.toUpperCase()));
  for (const method of used) assert.match(fn, new RegExp(`export const ${method} = `), method);
});
