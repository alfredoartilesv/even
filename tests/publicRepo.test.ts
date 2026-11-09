import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { LICENSE_ID, forbiddenReason, isPublicEmail } from "../scripts/lib/publicRepo.mjs";

// The repo is public: the licence is stated the same way everywhere, and no private file is tracked.
// History (emails, secrets) is checked by `npm run public:check`, which needs gitleaks.
const root = join(import.meta.dirname, "..");
const read = (f: string) => readFileSync(join(root, f), "utf8");

test("the licence is AGPL-3.0-or-later in LICENSE, package.json and the README", () => {
  assert.equal(LICENSE_ID, "AGPL-3.0-or-later");
  assert.match(read("LICENSE"), /GNU AFFERO GENERAL PUBLIC LICENSE\s+Version 3, 19 November 2007/);
  assert.equal(JSON.parse(read("package.json")).license, LICENSE_ID);
  assert.match(read("README.md"), /## Licence[\s\S]*AGPL-3\.0-or-later/);
});

// The Docker images build from a context without .git (.dockerignore) and with no git installed, so
// there is nothing tracked to list there; the leak check (secrets.yml, public:check) covers it on
// every PR and push with the real repository.
const inGit = existsSync(join(root, ".git"));

test("no tracked file is private (env, keys, databases, data exports, built apps)", { skip: inGit ? false : "no git checkout (Docker build)" }, () => {
  const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" }).split("\0").filter(Boolean);
  assert.deepEqual(
    tracked.filter((f) => forbiddenReason(f)),
    [],
  );
});

test("private paths are refused and the committed templates are allowed", () => {
  for (const f of [
    ".env",
    ".env.local",
    "server/.env.production",
    "release.jks",
    "a/b.keystore",
    "health.sqlite",
    "x.db-wal",
    "imports/garmin.zip",
    "out/app-release.apk",
    "run.fit",
    ".claude/settings.local.json",
  ])
    assert.ok(forbiddenReason(f), f);
  for (const f of [".env.example", "imports/README.md", "src/db/migrations/001_init.ts", "release/cert-sha256.txt", "docs/screens/img/dark-add.webp"])
    assert.equal(forbiddenReason(f), null, f);
});

test("only GitHub noreply commit emails may be published", () => {
  for (const e of ["78017015+someone@users.noreply.github.com", "noreply@github.com", "vercel[bot]@users.noreply.github.com", "noreply@anthropic.com"])
    assert.ok(isPublicEmail(e), e);
  for (const e of ["someone@gmail.com", "someone@work.example", "noreply@github.com.evil.test"]) assert.equal(isPublicEmail(e), false, e);
});
