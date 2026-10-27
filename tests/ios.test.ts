import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { inflateSync } from "node:zlib";
import { APP_ICON_CONTENTS, LAUNCH_STORYBOARD, SPLASH_CONTENTS, launchBackgroundColorset, patchInfoPlist, patchPbxproj } from "../scripts/ios-project.mjs";
import { checkLog, pickDevice } from "../scripts/ios-sim.mjs";
import { readPalette } from "../scripts/palette.mjs";

// iOS: the patches to the generated Xcode project, the icon and launch images, the simulator
// check's own logic, and the workflow that builds and runs it on a Mac.
const root = join(import.meta.dirname, "..");
const read = (f: string) => readFileSync(join(root, f), "utf8").replace(/\r\n/g, "\n");

// The lines `npx cap add ios` generates (Capacitor 8), in both build configurations.
const PBXPROJ = `
				CURRENT_PROJECT_VERSION = 1;
				MARKETING_VERSION = 1.0;
				PRODUCT_BUNDLE_IDENTIFIER = app.health.personal;
				CURRENT_PROJECT_VERSION = 1;
				MARKETING_VERSION = 1.0;
`;
const PLIST = `<dict>
	<key>CFBundleDisplayName</key>
        <string>App</string>
	<key>CFBundleShortVersionString</key>
	<string>$(MARKETING_VERSION)</string>
</dict>`;

test("the Xcode project gets package.json's version, with Android's build number", () => {
  const out = patchPbxproj(PBXPROJ, "1.2.3");
  assert.equal(out.match(/MARKETING_VERSION = 1\.2\.3;/g)?.length, 2);
  assert.equal(out.match(/CURRENT_PROJECT_VERSION = 10203;/g)?.length, 2);
  assert.equal(patchPbxproj(out, "1.2.3"), out, "idempotent");
  assert.throws(() => patchPbxproj("nothing here", "1.0.0"), /MARKETING_VERSION/);
  assert.throws(() => patchPbxproj(PBXPROJ, "1.0"), /MAJOR\.MINOR\.PATCH/);
});

test("Info.plist gets the home-screen name, escaped", () => {
  assert.match(patchInfoPlist(PLIST, "Even"), /<key>CFBundleDisplayName<\/key>\s*<string>Even<\/string>/);
  assert.match(patchInfoPlist(PLIST, "A & B"), /<string>A &amp; B<\/string>/);
  assert.match(patchInfoPlist(PLIST, "Even"), /\$\(MARKETING_VERSION\)/, "the version stays a build setting");
  assert.throws(() => patchInfoPlist("<dict></dict>", "Even"), /CFBundleDisplayName/);
});

test("the launch screen is the logo on the palette's --bg, light and dark", () => {
  const { light, dark } = readPalette();
  const set = JSON.parse(launchBackgroundColorset(light, dark));
  const hex = (c: { components: Record<string, string> }) => `#${["red", "green", "blue"].map((k) => c.components[k].slice(2)).join("")}`.toLowerCase();
  assert.equal(hex(set.colors[0].color), light.bg);
  assert.deepEqual(set.colors[1].appearances, [{ appearance: "luminosity", value: "dark" }]);
  assert.equal(hex(set.colors[1].color), dark.bg);
  assert.throws(() => launchBackgroundColorset({ ...light, bg: "color-mix(in srgb, red, blue)" }, dark), /#rrggbb/);

  assert.match(LAUNCH_STORYBOARD, /launchScreen="YES"/);
  assert.match(LAUNCH_STORYBOARD, /<color key="backgroundColor" name="LaunchBackground"\/>/);
  assert.match(LAUNCH_STORYBOARD, /image="Splash"/);
  assert.match(LAUNCH_STORYBOARD, /firstAttribute="centerX"[\s\S]*firstAttribute="centerY"/);
  // Every element id is unique (Interface Builder refuses duplicates).
  const ids = [...LAUNCH_STORYBOARD.matchAll(/ id="([^"]+)"/g)].map((m) => m[1]);
  assert.equal(new Set(ids).size, ids.length);

  assert.equal(JSON.parse(SPLASH_CONTENTS).images.find((i: { filename?: string }) => i.filename).filename, "Splash.png");
  assert.deepEqual(JSON.parse(APP_ICON_CONTENTS).images, [{ filename: "AppIcon-1024.png", idiom: "universal", platform: "ios", size: "1024x1024" }]);
});

/** Size, PNG color type and the top-left pixel of a PNG (the first pixel is the same under every row filter). */
function png(file: string) {
  const b = readFileSync(join(root, file));
  assert.equal(b.subarray(1, 4).toString(), "PNG", file);
  const idat: Buffer[] = [];
  for (let at = 8; at < b.length; ) {
    const len = b.readUInt32BE(at);
    if (b.subarray(at + 4, at + 8).toString() === "IDAT") idat.push(b.subarray(at + 8, at + 8 + len));
    at += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const type = b[25];
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20), type, corner: [...raw.subarray(1, type === 6 ? 5 : 4)] };
}

test("the app icon is 1024 px, opaque and full bleed on --brand; the launch logo keeps its transparent corners", () => {
  const { light } = readPalette();
  const brand = [1, 3, 5].map((i) => parseInt(light.brand.slice(i, i + 2), 16));
  const icon = png("resources/ios/AppIcon-1024.png");
  assert.deepEqual([icon.width, icon.height], [1024, 1024]);
  assert.equal(icon.type, 2, "RGB without alpha: iOS rejects icons with transparency");
  for (const [i, v] of icon.corner.entries()) assert.ok(Math.abs(v - brand[i]) <= 2, `corner ${icon.corner} is --brand ${light.brand}`);

  const splash = png("resources/ios/Splash.png");
  assert.deepEqual([splash.width, splash.height], [360, 360], "120 pt @3x");
  assert.equal(splash.type, 6, "RGBA");
  assert.equal(splash.corner[3], 0, "transparent outside the rounded tile");
});

test("the simulator check picks an iPhone on the newest iOS", () => {
  const list = {
    devices: {
      "com.apple.CoreSimulator.SimRuntime.iOS-17-5": [{ name: "iPhone 15", udid: "a", state: "Shutdown", isAvailable: true }],
      "com.apple.CoreSimulator.SimRuntime.iOS-18-2": [
        { name: "iPhone SE (3rd generation)", udid: "b", state: "Shutdown", isAvailable: true },
        { name: "iPhone 16", udid: "c", state: "Shutdown", isAvailable: true },
        { name: "iPad Air", udid: "d", state: "Shutdown", isAvailable: true },
      ],
      "com.apple.CoreSimulator.SimRuntime.watchOS-11-2": [{ name: "Apple Watch", udid: "e", state: "Shutdown", isAvailable: true }],
    },
  };
  assert.equal(pickDevice(list).udid, "c");
  assert.equal(pickDevice(list).ios, "18.2");
  assert.equal(pickDevice(list, "iPhone 15").udid, "a");
  assert.throws(() => pickDevice(list, "iPhone 99"), /No available simulator named/);
  assert.throws(() => pickDevice({ devices: {} }), /No iPhone simulator/);
});

test("the simulator check reads the app's log", () => {
  const start = '⚡️  [info] - 10:00:00.001 INFO  app: app starting {"level":"info","native":true}';
  const secret = "⚡️  [info] - 10:00:00.200 INFO  db: first launch: encryption secret created";
  const sync = "⚡️  [info] - 10:00:01.000 INFO  sync: sync skipped: Garmin not configured";
  assert.deepEqual(checkLog([start, secret, sync].join("\n"), { firstLaunch: true }), []);
  assert.deepEqual(checkLog([start, sync].join("\n"), { firstLaunch: false }), []);

  assert.match(checkLog([start, sync].join("\n"), { firstLaunch: true }).join(), /not created on first launch/);
  assert.match(checkLog([start, secret, sync].join("\n"), { firstLaunch: false }).join(), /Keychain did not keep it/);
  assert.match(checkLog([start.replace("true", "false"), secret, sync].join("\n"), { firstLaunch: true }).join(), /native shell/);
  assert.match(checkLog([start, secret].join("\n"), { firstLaunch: true }).join(), /sync check/);
  const err = '⚡️  [error] - 10:00:00.300 ERROR db: database open failed {"err":"x"}';
  assert.match(checkLog([start, secret, err, sync].join("\n"), { firstLaunch: true }).join(), /database open failed/);
});

test("iOS workflow: on a Mac, on demand and on native-side PRs, compiles both ways and runs the simulator", () => {
  const wf = read(".github/workflows/ios.yml");
  assert.match(wf, /runs-on: macos-/);
  assert.match(wf, /workflow_dispatch:/);
  assert.match(wf, /pull_request:[\s\S]*paths:/, "only PRs that touch the native side");
  assert.doesNotMatch(wf, /^\s*push:/m, "macOS minutes are expensive: no run on every push");
  assert.match(wf, /cap add ios --packagemanager SPM/);
  assert.match(wf, /node scripts\/ios-harden\.mjs/);
  assert.match(wf, /generic\/platform=iOS Simulator/);
  assert.match(wf, /generic\/platform=iOS'/);
  assert.match(wf, /CODE_SIGNING_ALLOWED=NO/);
  assert.match(wf, /node scripts\/ios-sim\.mjs --app build\/ios\/Build\/Products\/Debug-iphonesimulator\/App\.app/);
  assert.match(wf, /upload-artifact/);
  assert.doesNotMatch(wf, /secrets\./, "no signing secrets: nothing here is signed");
});

test("package.json: the iOS platform and its scripts; ios/ stays generated", () => {
  const pkg = JSON.parse(read("package.json"));
  assert.equal(pkg.dependencies["@capacitor/ios"].replace(/^\^/, "").split(".")[0], pkg.dependencies["@capacitor/core"].replace(/^\^/, "").split(".")[0]);
  assert.match(pkg.scripts["ios:sync"], /cap sync ios && node scripts\/ios-harden\.mjs/);
  assert.match(read(".gitignore"), /^\/ios\/$/m);
});
