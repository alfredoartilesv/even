/**
 * Renders the iOS images from resources/logo.svg into resources/ios/ (committed, because the Mac
 * that builds the app has no reliable SVG rasterizer). Run it again after changing the logo:
 * `npm run ios:icons` (needs Chrome or Edge; CHROME_PATH to choose).
 *
 * - AppIcon-1024.png: the logo full bleed and opaque. iOS rounds the corners itself and refuses
 *   an icon with transparency.
 * - Splash.png: the logo as drawn (rounded tile, transparent around it) at 120 pt @3x, shown in
 *   the middle of the launch screen.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const OUT = join(ROOT, "resources/ios");
const logo = readFileSync(join(ROOT, "resources/logo.svg"), "utf8");

const bin = [process.env.CHROME_PATH, "C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome"].find(
  (p) => p && existsSync(p),
);
if (!bin) throw new Error("No Chrome or Edge found. Set CHROME_PATH.");

function render(svg, size, file, transparent) {
  const dir = mkdtempSync(join(tmpdir(), "ios-icon-"));
  const page = join(dir, "icon.html");
  writeFileSync(page, `<!doctype html><html><body style="margin:0;background:transparent">${svg.replace("<svg ", `<svg width="${size}" height="${size}" style="display:block" `)}</body></html>`);
  execFileSync(bin, [
    "--headless=new",
    "--disable-gpu",
    "--hide-scrollbars",
    "--force-device-scale-factor=1",
    `--window-size=${size},${size}`,
    ...(transparent ? ["--default-background-color=00000000"] : []),
    `--screenshot=${join(OUT, file)}`,
    `file:///${page.replace(/\\/g, "/")}`,
  ], { stdio: "ignore" });
  rmSync(dir, { recursive: true, force: true });
  console.log(`resources/ios/${file} (${size}x${size})`);
}

mkdirSync(OUT, { recursive: true });
render(logo.replace(/ rx="[\d.]+"/, ""), 1024, "AppIcon-1024.png", false);
render(logo, 360, "Splash.png", true);
