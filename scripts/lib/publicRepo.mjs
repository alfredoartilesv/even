/**
 * What may be in the repo now that it is public: the rules `scripts/public-check.mjs` and
 * `tests/publicRepo.test.ts` share. Plain Node, no dependencies.
 */

/** SPDX id of the licence in LICENSE and package.json. */
export const LICENSE_ID = "AGPL-3.0-or-later";

/**
 * Files that never belong in the repo: env files with real values, signing keys, databases and
 * data exports (health data), and built apps. Matched against `git ls-files` paths.
 */
const FORBIDDEN = [
  { re: /(^|\/)\.env(\..+)?$/, why: "env file (real secrets); only .env.example is committed" },
  { re: /\.(jks|keystore|p12|pfx|pem|key|der)$/i, why: "signing key or certificate key" },
  { re: /(^|\/)google-services\.json$|GoogleService-Info\.plist$/, why: "Firebase config" },
  { re: /\.(sqlite|sqlite3|db)(-journal|-wal|-shm)?$/i, why: "database (health data)" },
  { re: /^imports\//, why: "data export to import (health data)" },
  { re: /^\.data\//, why: "local dev database (health data)" },
  { re: /\.(apk|aab|ipa)$/i, why: "built app (published as a GitHub release, not committed)" },
  { re: /\.(fit|tcx|gpx)$/i, why: "activity file (health data)" },
  { re: /(^|\/)\.claude\/settings\.local\.json$/, why: "local Claude settings (paths, permissions)" },
];
const ALLOWED = new Set([".env.example", "imports/README.md"]);

/** Why a tracked path must not be in the public repo, or null when it may be. */
export function forbiddenReason(path) {
  if (ALLOWED.has(path)) return null;
  return FORBIDDEN.find((f) => f.re.test(path))?.why ?? null;
}

/**
 * Commit emails that may be public: GitHub's noreply addresses and bots. Anything else (a work or
 * personal address) would be published with the history.
 */
export function isPublicEmail(email) {
  const e = email.trim().toLowerCase();
  return /^(\d+\+)?[a-z0-9-]+(\[bot\])?@users\.noreply\.github\.com$/.test(e) || e === "noreply@github.com" || e === "noreply@anthropic.com";
}
