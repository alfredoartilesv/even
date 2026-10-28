/**
 * Timing builds (scripts/perf-device.mjs) seed about 42,000 invented readings on first launch
 * (src/app/perfSeed.ts). They must never land in a real install: an emulator can hold the owner's
 * app under app.health.personal, signed with the same debug key, so `adb install -r` would succeed
 * and mix the invented readings into real data and its backups. Timing builds carry an
 * applicationIdSuffix (".perf", ".perf2"); anything else is refused.
 */
export const PERF_PACKAGE = /^app\.health\.personal\.perf\d*$/;

/** Throws unless `name` is a timing build's package. */
export function assertPerfPackage(name, where = "package") {
  if (!PERF_PACKAGE.test(name ?? "")) {
    throw new Error(
      `${where} is "${name}", not a timing build (app.health.personal.perf…). Add applicationIdSuffix ".perf" to the debug build type first (docs/dev-setup.md, start-up timings).`,
    );
  }
  return name;
}

/** The package name from `aapt2 dump badging` output. */
export function badgingPackage(badging) {
  return /package: name='([^']+)'/.exec(badging)?.[1] ?? null;
}
