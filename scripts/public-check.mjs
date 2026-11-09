/**
 * Checks that nothing private reaches the public repo. Plain Node, no dependencies, so it runs the
 * same on Windows, in the pre-push hook and in CI (.github/workflows/secrets.yml).
 *
 *   npm run public:check                   # all history, every branch and tag
 *   node scripts/public-check.mjs --range origin/develop..HEAD   # only these commits (hook, CI on a PR)
 *
 * 1. Licence: LICENSE is the AGPL-3.0 text and package.json says AGPL-3.0-or-later.
 * 2. Tracked files: no env file, key, database, data export or built app (scripts/lib/publicRepo.mjs).
 * 3. Commit emails: only GitHub noreply addresses, so no work or personal address is published.
 * 4. gitleaks over the commits (rules and allowlist in .gitleaks.toml). The binary comes from
 *    $GITLEAKS, the PATH, or %USERPROFILE%/tools/gitleaks (docs/dev-setup.md, "Public repo").
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { LICENSE_ID, forbiddenReason, isPublicEmail } from "./lib/publicRepo.mjs";

const root = join(import.meta.dirname, "..");
const args = process.argv.slice(2);
const range = args.includes("--range") ? args[args.indexOf("--range") + 1] : undefined;
const git = (...a) => execFileSync("git", a, { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
// A range is git log arguments ("a..b", or "<sha> --not --remotes" for a new branch in the hook).
const logRange = range ? range.trim().split(/\s+/) : ["--all"];

let failed = 0;
function check(name, fn) {
  const problems = fn();
  if (problems.length === 0) return console.log(`PASS ${name}`);
  failed++;
  console.log(`FAIL ${name}`);
  for (const p of problems.slice(0, 20)) console.log(`     ${p}`);
  if (problems.length > 20) console.log(`     … and ${problems.length - 20} more`);
}

check(`licence is ${LICENSE_ID}`, () => {
  const out = [];
  const license = existsSync(join(root, "LICENSE")) ? readFileSync(join(root, "LICENSE"), "utf8") : "";
  if (!license.includes("GNU AFFERO GENERAL PUBLIC LICENSE") || !license.includes("Version 3, 19 November 2007")) out.push("LICENSE is not the AGPL-3.0 text");
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  if (pkg.license !== LICENSE_ID) out.push(`package.json "license" is ${JSON.stringify(pkg.license)}, not "${LICENSE_ID}"`);
  return out;
});

check("no private files tracked", () =>
  git("ls-files", "-z")
    .split("\0")
    .filter(Boolean)
    .map((f) => [f, forbiddenReason(f)])
    .filter(([, why]) => why)
    .map(([f, why]) => `${f}: ${why}`),
);

check(`commit emails are GitHub noreply (${range ?? "all history"})`, () => {
  const seen = new Map();
  for (const line of git("log", ...logRange, "--format=%h%x09%ae%x09%ce")
    .split("\n")
    .filter(Boolean)) {
    const [hash, ...emails] = line.split("\t");
    for (const e of emails) if (!isPublicEmail(e) && !seen.has(e)) seen.set(e, hash);
  }
  return [...seen].map(([e, hash]) => `${e} (first in ${hash}): set git config user.email to your GitHub noreply address`);
});

function gitleaksBinary() {
  const exe = process.platform === "win32" ? "gitleaks.exe" : "gitleaks";
  const candidates = [process.env.GITLEAKS, exe, join(homedir(), "tools", "gitleaks", exe)].filter(Boolean);
  return candidates.find((c) => spawnSync(c, ["version"], { stdio: "ignore" }).status === 0);
}

check(`gitleaks finds no secrets (${range ?? "all history"})`, () => {
  const bin = gitleaksBinary();
  if (!bin) return ["gitleaks not found: install it (docs/dev-setup.md, Public repo) or set GITLEAKS to its path"];
  const r = spawnSync(bin, ["git", ".", "--config", ".gitleaks.toml", "--log-opts", logRange.join(" "), "--redact", "--no-banner", "--exit-code", "1"], {
    cwd: root,
    encoding: "utf8",
  });
  if (r.status === 0) return [];
  return (r.stdout + r.stderr)
    .split("\n")
    .filter((l) => /Finding|Secret|RuleID|File|Commit|leaks found|error/i.test(l))
    .map((l) => l.trim());
});

if (failed) {
  console.log(`\n${failed} check(s) failed: fix them before this reaches the public repo.`);
  process.exit(1);
}
console.log("\nThe repo is fit to be public.");
