/**
 * Runs the built app in the iOS Simulator and checks it starts for real (macOS with Xcode only;
 * the iOS workflow runs it). `node scripts/ios-sim.mjs --app <App.app> [--out dir] [--device name]`
 *
 * Fresh install, light mode: the app starts natively, creates its encryption secret in the
 * Keychain, opens the encrypted database and gets as far as the sync check, with no error logged
 * and still running after the wait. Then a relaunch in Dark Mode: still no error, and the secret
 * is not created again (the Keychain kept it, so the database opened with the same key).
 * Screenshots and the app log go to --out.
 */
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { setTimeout as wait } from "node:timers/promises";
import { join, resolve } from "node:path";

export const BUNDLE_ID = "app.health.personal";

/** From `simctl list devices available -j`: the named iPhone, else an iPhone on the newest iOS runtime. */
export function pickDevice(list, name) {
  const runtimes = Object.entries(list.devices)
    .filter(([rt]) => /SimRuntime\.iOS-/.test(rt))
    .map(([rt, devices]) => ({ version: rt.split("iOS-")[1].split("-").map(Number), devices: devices.filter((d) => d.isAvailable !== false && /^iPhone/.test(d.name)) }))
    .filter((r) => r.devices.length)
    .sort((a, b) => b.version[0] - a.version[0] || (b.version[1] ?? 0) - (a.version[1] ?? 0));
  const all = runtimes.flatMap((r) => r.devices.map((d) => ({ ...d, ios: r.version.join(".") })));
  const found = name ? all.find((d) => d.name === name) : (all.find((d) => !/SE|mini/.test(d.name)) ?? all[0]);
  if (!found) throw new Error(name ? `No available simulator named "${name}"` : "No iPhone simulator available");
  return found;
}

/** The checks on one launch's log; returns failures (empty = pass). */
export function checkLog(text, { firstLaunch }) {
  const fail = [];
  if (!/app starting \{[^}]*"native":true/.test(text)) fail.push('no "app starting" with native:true: the web app did not run in the native shell');
  const created = text.includes("first launch: encryption secret created");
  if (firstLaunch && !created) fail.push("the encryption secret was not created on first launch");
  if (!firstLaunch && created) fail.push("the encryption secret was created again: the Keychain did not keep it");
  if (!text.includes("sync skipped: Garmin not configured")) fail.push("never reached the sync check (database not ready?)");
  const errors = text.split("\n").filter((l) => /\d\d:\d\d:\d\d\.\d{3} ERROR /.test(l));
  if (errors.length) fail.push(`errors logged:\n  ${errors.join("\n  ")}`);
  return fail;
}

/** The built app's signed entitlements and Info.plist: without both, iOS stops the app when it asks for Health data. */
export function checkBundle(entitlementsXml, healthUsage) {
  const fail = [];
  if (!/<key>com\.apple\.developer\.healthkit<\/key>\s*<true\/>/.test(entitlementsXml)) fail.push("the app is not signed with the HealthKit entitlement");
  if (!healthUsage.trim()) fail.push("Info.plist has no NSHealthShareUsageDescription");
  return fail;
}

async function main() {
  const arg = (k, d) => {
    const i = process.argv.indexOf(`--${k}`);
    return i > 0 ? process.argv[i + 1] : d;
  };
  const appPath = arg("app");
  if (!appPath) throw new Error("--app <path to App.app> is required");
  const out = resolve(arg("out", "ios-sim-out"));
  mkdirSync(out, { recursive: true });
  const sim = (...a) => execFileSync("xcrun", ["simctl", ...a], { encoding: "utf8" });

  const quiet = (cmd, args) => {
    try {
      return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      return "";
    }
  };
  // A signed device build has its entitlements in the signature (codesign shows them); a simulator
  // build embeds them as a plist in the executable instead (__TEXT,__entitlements).
  const executable = join(resolve(appPath), quiet("plutil", ["-extract", "CFBundleExecutable", "raw", join(resolve(appPath), "Info.plist")]).trim() || "App");
  const bundle = checkBundle(
    quiet("codesign", ["-d", "--entitlements", "-", "--xml", resolve(appPath)]) + readFileSync(executable).toString("latin1"),
    quiet("plutil", ["-extract", "NSHealthShareUsageDescription", "raw", join(resolve(appPath), "Info.plist")]),
  );
  console.log(`${bundle.length ? "FAIL" : "PASS"} HealthKit entitlement and request text in the built app`);

  const device = pickDevice(JSON.parse(sim("list", "devices", "available", "-j")), arg("device"));
  console.log(`simulator: ${device.name} (iOS ${device.ios}) ${device.udid}`);
  if (device.state !== "Booted") sim("boot", device.udid);
  sim("bootstatus", device.udid, "-b");
  try {
    sim("uninstall", device.udid, BUNDLE_ID);
  } catch {
    // not installed yet
  }
  sim("install", device.udid, resolve(appPath));

  const failures = [...bundle];
  for (const [i, mode] of ["light", "dark"].entries()) {
    sim("ui", device.udid, "appearance", mode);
    const since = new Date(Date.now() - 1000).toISOString().replace("T", " ").slice(0, 19);
    // --console-pty: the app's stdout through a terminal, so it is line-buffered and nothing is
    // lost when the app is stopped (to a file it is block-buffered). Capacitor prints the WebView
    // console there.
    let text = "";
    const app = spawn("xcrun", ["simctl", "launch", "--console-pty", "--terminate-running-process", device.udid, BUNDLE_ID]);
    app.stdout.on("data", (d) => (text += d));
    app.stderr.on("data", (d) => (text += d));
    await wait(20_000);
    const running = sim("spawn", device.udid, "launchctl", "list").includes(`UIKitApplication:${BUNDLE_ID}`);
    sim("io", device.udid, "screenshot", join(out, `${i + 1}-${mode}.png`));
    try {
      sim("terminate", device.udid, BUNDLE_ID);
    } catch {
      // already gone (reported below)
    }
    await Promise.race([new Promise((r) => app.once("close", r)), wait(5000)]);
    app.kill();
    writeFileSync(join(out, `app-${mode}.log`), text);
    try {
      // The system's view of the same launch, for debugging only.
      writeFileSync(join(out, `system-${mode}.log`), sim("spawn", device.udid, "log", "show", "--style", "compact", "--start", since, "--predicate", 'process == "App"'));
    } catch {
      // best effort
    }
    const f = checkLog(text, { firstLaunch: i === 0 });
    if (!running) f.push("the app is not running after 20 s (crashed?)");
    for (const x of f) failures.push(`${mode}: ${x}`);
    console.log(`${f.length ? "FAIL" : "PASS"} ${i === 0 ? "fresh install" : "relaunch"} in ${mode} mode`);
  }
  sim("ui", device.udid, "appearance", "light");
  if (failures.length) {
    console.error(failures.join("\n"));
    process.exit(1);
  }
  console.log(`iOS simulator check passed; screenshots and logs in ${out}`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) await main();
