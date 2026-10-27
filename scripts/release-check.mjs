/**
 * Checks a release APK before it is published. Plain Node, no dependencies, so it runs in the
 * Docker release build and on the CI emulator without `npm ci`.
 *
 *   node scripts/release-check.mjs --apk out/app-release.apk                 # the file
 *   node scripts/release-check.mjs --apk out/app-release.apk --device        # and install + launch it
 *   options: --build-tools <dir> (default $ANDROID_HOME/build-tools/36.0.0), --serial <id>, --out <dir>
 *
 * File: signed (v2+) with the release key in release/cert-sha256.txt, not a debug key; package,
 * versionName and versionCode as package.json says; not debuggable; min and target SDK; backups off;
 * the web app inside. Device: a clean install, it launches, stays alive and in front, no crash.
 * A release build has no WebView debugging, so the deeper checks are `npm run test:device` on a
 * debug build of the same commit.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { versionCode } from "./android-gradle.mjs";

const APP = "app.health.personal";
const MIN_SDK = 24;
const TARGET_SDK = 36;
const root = join(import.meta.dirname, "..");
const args = process.argv.slice(2);
const arg = (n) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);
const apk = arg("--apk");
if (!apk || !existsSync(apk)) {
  console.error("Pass --apk <path to the release APK>");
  process.exit(2);
}
const sdk = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT ?? "";
const buildTools = arg("--build-tools") ?? join(sdk, "build-tools", "36.0.0");
const win = process.platform === "win32";
const tool = (name) => join(buildTools, win ? (name === "aapt2" ? "aapt2.exe" : `${name}.bat`) : name);
const run = (cmd, a) => {
  // A .bat (apksigner on Windows) runs through cmd; the arguments here are paths and fixed words.
  const [file, list] = win && cmd.endsWith(".bat") ? ["cmd.exe", ["/d", "/c", cmd, ...a]] : [cmd, a];
  return execFileSync(file, list, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 32 * 1024 * 1024 }).replace(/\r/g, "");
};

const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const expectedCert = readFileSync(join(root, "release/cert-sha256.txt"), "utf8").trim().toLowerCase();

const results = [];
function check(name, fn) {
  try {
    const detail = fn();
    results.push(true);
    console.log(`PASS ${name}${detail ? `: ${detail}` : ""}`);
  } catch (e) {
    results.push(false);
    console.log(`FAIL ${name}: ${e.message}`);
  }
}
const expect = (ok, msg) => {
  if (!ok) throw new Error(msg);
};

console.log(`release check: ${apk} (package.json ${version}, versionCode ${versionCode(version)})`);

check("signed with the release key", () => {
  const out = run(tool("apksigner"), ["verify", "--verbose", "--print-certs", apk]);
  expect(/^Verifies$/m.test(out), "apksigner does not verify it");
  expect(
    /Verified using v2 scheme \(APK Signature Scheme v2\): true|Verified using v3 scheme \(APK Signature Scheme v3\): true/.test(out),
    "no v2/v3 signature",
  );
  const certs = [...out.matchAll(/certificate SHA-256 digest: ([0-9a-f]{64})/g)].map((m) => m[1]);
  expect(certs.length === 1, `expected one signer, found ${certs.length}`);
  expect(!/CN=Android Debug/.test(out), "signed with a debug key");
  expect(certs[0] === expectedCert, `signer ${certs[0].slice(0, 16)}… is not the release key in release/cert-sha256.txt`);
  return `${certs[0].slice(0, 16)}…`;
});

const badging = (() => {
  try {
    return run(tool("aapt2"), ["dump", "badging", apk]);
  } catch (e) {
    return `ERROR ${e.message}`;
  }
})();
check("package, version and SDK levels", () => {
  const pkg = /package: name='([^']+)' versionCode='(\d+)' versionName='([^']+)'/.exec(badging);
  expect(pkg, "aapt2 could not read the package line");
  expect(pkg[1] === APP, `package ${pkg[1]}`);
  expect(pkg[3] === version, `versionName ${pkg[3]}, package.json says ${version}`);
  expect(Number(pkg[2]) === versionCode(version), `versionCode ${pkg[2]}, expected ${versionCode(version)}`);
  const min = /minSdkVersion:'(\d+)'/.exec(badging)?.[1];
  const target = /targetSdkVersion:'(\d+)'/.exec(badging)?.[1];
  expect(Number(min) === MIN_SDK, `minSdk ${min}`);
  expect(Number(target) === TARGET_SDK, `targetSdk ${target}`);
  return `${pkg[1]} ${pkg[3]} (${pkg[2]}), sdk ${min}-${target}`;
});

check("not debuggable", () => {
  expect(!/application-debuggable/.test(badging), "the APK is debuggable");
  return "";
});

check("Android backups off", () => {
  const xml = run(tool("aapt2"), ["dump", "xmltree", "--file", "AndroidManifest.xml", apk]);
  // aapt2 prints "android:allowBackup(0x01010280)=false" (older builds: "=(type 0x12)0x0").
  expect(/android:allowBackup\(0x[0-9a-f]+\)=(false|\(type 0x12\)0x0)\b/.test(xml), "allowBackup is not false");
  expect(/android:fullBackupContent\(0x[0-9a-f]+\)=(false|\(type 0x12\)0x0)\b/.test(xml), "fullBackupContent is not false");
  expect(/android:dataExtractionRules/.test(xml), "no dataExtractionRules");
  return "allowBackup=false, data extraction rules set";
});

check("the web app is inside", () => {
  const zip = readFileSync(apk);
  for (const f of ["assets/public/index.html", "assets/capacitor.config.json"]) expect(zip.includes(Buffer.from(f)), `${f} missing`);
  return "assets/public/index.html";
});

if (args.includes("--device")) {
  const serial = arg("--serial");
  const outDir = arg("--out") ?? join(tmpdir(), `health-release-check-${Date.now()}`);
  mkdirSync(outDir, { recursive: true });
  const adb = (...a) => run("adb", serial ? ["-s", serial, ...a] : a);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // Clean install: a release key cannot update a debug install, and a first launch is what users get.
  try {
    adb("uninstall", APP);
  } catch {
    // not installed
  }
  check("installs on the device", () => {
    adb("install", apk);
    return `${adb("shell", "getprop", "ro.product.model").trim()}, Android ${adb("shell", "getprop", "ro.build.version.release").trim()}`;
  });
  try {
    adb("shell", "pm", "grant", APP, "android.permission.POST_NOTIFICATIONS");
  } catch {
    // older Android
  }
  adb("logcat", "-c");
  adb("shell", "am", "start", "-W", "-n", `${APP}/.MainActivity`);
  await sleep(15_000);
  const shot = execFileSync("adb", serial ? ["-s", serial, "exec-out", "screencap", "-p"] : ["exec-out", "screencap", "-p"], { maxBuffer: 64 * 1024 * 1024 });
  writeFileSync(join(outDir, "release-launch.png"), shot);
  check("launches and stays alive", () => {
    const pid = adb("shell", "pidof", "-s", APP).trim();
    expect(pid, "the app process is gone");
    return `pid ${pid}`;
  });
  check("in front after launch", () => {
    const line =
      adb("shell", "dumpsys", "activity", "activities")
        .split("\n")
        .find((l) => /topResumedActivity|mResumedActivity/.test(l)) ?? "";
    expect(line.includes(APP), `in front: ${line.trim()}`);
    return "MainActivity";
  });
  check("no crash in the log", () => {
    const log = adb("logcat", "-d", "-b", "crash");
    expect(!log.includes(APP), "crash buffer mentions the app");
    return "";
  });
  console.log(`screenshot: ${join(outDir, "release-launch.png")}`);
}

const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} release checks passed`);
process.exit(failed ? 1 : 0);
