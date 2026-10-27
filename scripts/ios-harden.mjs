/**
 * Makes the generated ios/ project (`npx cap add ios --packagemanager SPM`, git-ignored like
 * android/) into Even. Idempotent: run it after every add/sync (`npm run ios:sync` does).
 *
 * - Version and build number from package.json, home-screen name from capacitor.config.json
 *   (scripts/ios-project.mjs).
 * - Apple Health: the HealthKit entitlement and the request text (scripts/ios-project.mjs).
 * - The app icon and launch logo rendered from resources/logo.svg (resources/ios/, made by
 *   `npm run ios:icons`), replacing Capacitor's.
 * - The launch screen on the palette's --bg, light and dark (src/ui/palette.css).
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readPalette } from "./palette.mjs";
import { APP_ICON_CONTENTS, ENTITLEMENTS, ENTITLEMENTS_PATH, LAUNCH_STORYBOARD, SPLASH_CONTENTS, launchBackgroundColorset, patchInfoPlist, patchPbxproj } from "./ios-project.mjs";

const ROOT = join(import.meta.dirname, "..");
const app = join(ROOT, "ios/App");
const pbxPath = join(app, "App.xcodeproj/project.pbxproj");
if (!existsSync(pbxPath)) {
  console.error("ios/ not found. Run `npx cap add ios --packagemanager SPM` first.");
  process.exit(1);
}

const { version } = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const { appName } = JSON.parse(readFileSync(join(ROOT, "capacitor.config.json"), "utf8"));
writeFileSync(pbxPath, patchPbxproj(readFileSync(pbxPath, "utf8"), version));
const plistPath = join(app, "App/Info.plist");
writeFileSync(plistPath, patchInfoPlist(readFileSync(plistPath, "utf8"), appName));
writeFileSync(join(app, ENTITLEMENTS_PATH), ENTITLEMENTS);
console.log(`iOS version ${version}, name ${appName}, HealthKit entitlement and request text.`);

/** An asset catalog folder holding only the given files and Contents.json. */
function assetSet(name, contents, files = {}) {
  const dir = join(app, "App/Assets.xcassets", name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "Contents.json"), contents);
  for (const [to, from] of Object.entries(files)) copyFileSync(join(ROOT, "resources/ios", from), join(dir, to));
  return readdirSync(dir);
}
assetSet("AppIcon.appiconset", APP_ICON_CONTENTS, { "AppIcon-1024.png": "AppIcon-1024.png" });
assetSet("Splash.imageset", SPLASH_CONTENTS, { "Splash.png": "Splash.png" });
const { light, dark } = readPalette();
assetSet("LaunchBackground.colorset", launchBackgroundColorset(light, dark));
writeFileSync(join(app, "App/Base.lproj/LaunchScreen.storyboard"), LAUNCH_STORYBOARD);
console.log(`iOS icon and launch screen: the Even logo on ${light.bg} / ${dark.bg} (dark).`);
