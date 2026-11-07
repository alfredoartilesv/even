import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * The palette (src/ui/palette.css) is the only place colors are defined: these tests keep text
 * readable in both themes, keep literal colors and undefined tokens out of the rest of the app,
 * and keep the logo, the Android icon, the Android window and splash, and the browser theme-color
 * on the palette's values.
 */

const SRC = resolve(import.meta.dirname, "../src");
const ROOT = resolve(SRC, "..");
const palette = readFileSync(join(SRC, "ui/palette.css"), "utf8");

function vars(block: string): Record<string, string> {
  return Object.fromEntries([...block.matchAll(/--([\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
}

const darkStart = palette.indexOf("@media (prefers-color-scheme: dark)");
const light = vars(palette.slice(0, darkStart));
const dark = { ...light, ...vars(palette.slice(darkStart)) };

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

const ROLES = [
  "bg",
  "surface",
  "fg",
  "muted",
  "line",
  "accent",
  "on-accent",
  "accent-soft",
  "good",
  "warning",
  "warning-soft",
  "error",
  "shadow",
  "shadow-pop",
  "brand",
  "brand-ring",
  "on-brand",
];
const SOLID = ["bg", "surface", "fg", "muted", "line", "accent", "on-accent", "good", "warning", "error", "brand", "brand-ring", "on-brand"];

test("palette: every role is defined, with hex values for the solid ones", () => {
  for (const r of ROLES) assert.ok(light[r], `--${r} missing`);
  for (const r of SOLID) {
    assert.match(light[r], /^#[0-9a-f]{6}$/, `light --${r}`);
    assert.match(dark[r], /^#[0-9a-f]{6}$/, `dark --${r}`);
  }
  for (let i = 1; i <= 8; i++) assert.ok(light[`series-${i}`] && dark[`series-${i}`], `series-${i}`);
});

for (const [name, t] of [
  ["light", light],
  ["dark", dark],
] as const) {
  test(`palette (${name}): text roles reach WCAG AA on both surfaces`, () => {
    for (const role of ["fg", "muted", "accent", "good", "warning", "error"]) {
      for (const surface of ["bg", "surface"]) {
        const c = contrast(t[role], t[surface]);
        assert.ok(c >= 4.5, `--${role} on --${surface}: ${c.toFixed(2)}:1`);
      }
    }
    assert.ok(contrast(t["on-accent"], t.accent) >= 4.5, "--on-accent on --accent");
    assert.ok(contrast(t["on-brand"], t.brand) >= 4.5, "--on-brand on --brand");
    assert.ok(contrast(t.fg, t.bg) >= 7, "main text is AAA");
  });
}

const AREAS = ["today", "food", "prep", "activity", "journal", "coach", "you"];

for (const [name, t] of [
  ["light", light],
  ["dark", dark],
] as const) {
  test(`palette (${name}): every section's accent reads as text and carries its button label`, () => {
    for (const a of AREAS) {
      const c = t[`area-${a}`];
      assert.match(c, /^#[0-9a-f]{6}$/, `--area-${a}`);
      for (const surface of ["bg", "surface"])
        assert.ok(contrast(c, t[surface]) >= 4.5, `--area-${a} on --${surface}: ${contrast(c, t[surface]).toFixed(2)}:1`);
      assert.ok(contrast(t["on-accent"], c) >= 4.5, `--on-accent on --area-${a}`);
    }
    assert.ok(contrast(t["on-nav"], t["nav-ink"]) >= 7, "menu text on --nav-ink");
    assert.ok(contrast(t["on-nav-muted"], t["nav-ink"]) >= 4.5, "muted menu text on --nav-ink");
  });
}

test("contrast maths matches the WCAG reference values", () => {
  assert.equal(contrast("#000000", "#ffffff").toFixed(0), "21");
  assert.equal(contrast("#777777", "#ffffff").toFixed(2), "4.48");
});

function walk(dir: string, out: string[] = []): string[] {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}
const files = walk(SRC).filter((f) => /\.(css|tsx?)$/.test(f) && !f.endsWith("palette.css"));
// Read once: two tests scan every file.
const source = new Map(files.map((f) => [f, readFileSync(f, "utf8")]));

/** The code without its comments, line numbers kept. */
function code(text: string): string[] {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .split("\n")
    .map((l) => l.replace(/(^|[^:"'`])\/\/.*$/, "$1"));
}

// A hex color (#abc, #aabbcc, with or without alpha), an rgb()/hsl()/… color, or a CSS color name
// given as a color. Shadows go through --shadow and --shadow-pop.
const LITERAL = /(?<![\w&/])#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\b(?![\w-])|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\(/;
const NAMED =
  /(?:color|background|fill|stroke|border|outline|shadow|stopColor)[\w-]*\s*[:=]\s*\{?\s*["'`]?\s*(?:[^;"'`]*\s)?(?:white|black|red|green|blue|orange|gray|grey|yellow|purple|pink|brown|navy|teal|silver)\b/i;
const isLiteral = (line: string) => LITERAL.test(line) || NAMED.test(line);

test("no literal colors outside the palette", () => {
  const bad = files.flatMap((f) =>
    code(source.get(f)!)
      .map((line, i) => ({ line, i }))
      .filter(({ line }) => isLiteral(line))
      .map(({ i }) => `${f.slice(SRC.length + 1)}:${i + 1}`),
  );
  assert.deepEqual(bad, []);
});

test("the literal-color check catches what it should and nothing else", () => {
  for (const l of [
    'fill="#fff"',
    "color: #0f766e;",
    'style={{ color: "#123456" }}',
    "box-shadow: 0 1px 2px rgb(0 0 0 / 0.1);",
    "background: white;",
    'stroke="black"',
    "const c = '#aabbccdd';",
    "border: 1px solid gray;",
  ]) {
    assert.ok(isLiteral(l), l);
  }
  for (const l of [
    "color: var(--fg);",
    'fill="currentColor"',
    "white-space: nowrap;",
    'href="#top"',
    "const id = `#${n}`;",
    "border-collapse: collapse;",
    "rgb is not used here",
    "background: transparent;",
  ]) {
    assert.ok(!isLiteral(l), l);
  }
  assert.deepEqual(code("a /* #fff */ b\n// color: red\nc"), [`a${" ".repeat(12)}b`, "", "c"]);
});

/** Every color in a file as lowercase #rrggbb: Android's #aarrggbb loses its alpha, fully transparent ones are dropped. */
function colorsIn(text: string): string[] {
  return [...text.matchAll(/#([0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b/g)]
    .map((m) => m[1].toLowerCase())
    .filter((h) => !(h.length === 8 && h.startsWith("00")))
    .map((h) => (h.length === 8 ? h.slice(2) : h.length === 3 ? [...h].map((x) => x + x).join("") : h))
    .map((h) => `#${h}`);
}
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");

test("the logo, favicon and Android icon use only the brand colors", () => {
  const brand = new Set([light.brand, light["brand-ring"], light["on-brand"]]);
  const icons = walk(join(ROOT, "resources/android/res"))
    .filter((f) => f.endsWith(".xml"))
    .map((f) => f.slice(ROOT.length + 1));
  for (const asset of ["resources/logo.svg", "public/favicon.svg", ...icons]) {
    assert.deepEqual(
      colorsIn(read(asset)).filter((h) => !brand.has(h)),
      [],
      `${asset}: colors that are not --brand, --brand-ring or --on-brand`,
    );
  }
  assert.equal(read("public/favicon.svg"), read("resources/logo.svg"), "favicon.svg is the logo");
  assert.match(read("resources/logo.svg"), new RegExp(`<rect[^>]*fill="${light.brand}"`), "the logo tile is --brand");
  assert.match(read("resources/android/res/values/ic_launcher_background.xml"), new RegExp(light.brand, "i"), "the launcher background is --brand");
});

test("index.html: the theme-color is --bg in each theme", () => {
  const html = read("index.html");
  const meta = (scheme: string) => new RegExp(`<meta name="theme-color" media="\\(prefers-color-scheme: ${scheme}\\)" content="([^"]+)"`).exec(html)?.[1];
  assert.equal(meta("light"), light.bg);
  assert.equal(meta("dark"), dark.bg);
});

test("Android: colors.xml and the splash theme come from the palette", async () => {
  const { ANDROID_STYLES_XML, androidColorsXml, parsePalette } = await import("../scripts/palette.mjs");
  assert.deepEqual(parsePalette(palette), { light, dark });
  const day = androidColorsXml(light);
  const night = androidColorsXml(dark);
  assert.match(day, new RegExp(`<color name="palette_bg">${light.bg.toUpperCase()}</color>`));
  assert.match(night, new RegExp(`<color name="palette_bg">${dark.bg.toUpperCase()}</color>`));
  assert.match(night, new RegExp(`<color name="colorAccent">${dark.accent.toUpperCase()}</color>`));
  assert.match(day, new RegExp(`<color name="brand">${light.brand.toUpperCase()}</color>`));
  assert.throws(() => androidColorsXml({ ...light, bg: "color-mix(in srgb, red, blue)" }), /must be a #rrggbb/);
  // The styles name colors only through @color/, and never Capacitor's white splash.png.
  assert.deepEqual(colorsIn(ANDROID_STYLES_XML), []);
  for (const item of [
    '"windowSplashScreenBackground">@color/palette_bg',
    '"windowSplashScreenIconBackgroundColor">@color/brand',
    '"android:windowBackground">@color/palette_bg',
  ]) {
    assert.ok(ANDROID_STYLES_XML.includes(item), item);
  }
  assert.ok(!ANDROID_STYLES_XML.includes("@drawable/splash"), "no splash.png");
});

test("every var(--token) the app uses is defined", () => {
  // Defined in CSS ("--x: …") or set inline from a component (style={{ ["--x"]: … }}).
  const defined = new Set([
    ...Object.keys(light),
    ...files.flatMap((f) => [...source.get(f)!.matchAll(/(--[\w-]+):|["'](--[\w-]+)["']/g)].map((m) => (m[1] ?? m[2]).slice(2))),
  ]);
  const used = files
    .flatMap((f) => [...source.get(f)!.matchAll(/var\(--([\w-]+)/g)].map((m) => ({ token: m[1], file: f.slice(SRC.length + 1) })))
    .filter((u) => !u.token.endsWith("-")); // --series-${slot}: checked above
  assert.deepEqual(
    used.filter((u) => !defined.has(u.token)).map((u) => `${u.file}: --${u.token}`),
    [],
  );
});
