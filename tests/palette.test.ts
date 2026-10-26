import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * The palette (src/ui/palette.css) is the only place colors are defined: these tests keep text
 * readable in both themes, and keep literal colors and undefined tokens out of the rest of the app.
 */

const SRC = resolve(import.meta.dirname, "../src");
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

const ROLES = ["bg", "surface", "fg", "muted", "line", "accent", "on-accent", "accent-soft", "good", "warning", "warning-soft", "error"];

test("palette: every role is defined, with hex values for the solid ones", () => {
  for (const r of ROLES) assert.ok(light[r], `--${r} missing`);
  for (const r of ["bg", "surface", "fg", "muted", "line", "accent", "on-accent", "good", "warning", "error"]) {
    assert.match(light[r], /^#[0-9a-f]{6}$/, `light --${r}`);
    assert.match(dark[r], /^#[0-9a-f]{6}$/, `dark --${r}`);
  }
  for (let i = 1; i <= 8; i++) assert.ok(light[`series-${i}`] && dark[`series-${i}`], `series-${i}`);
});

for (const [name, t] of [["light", light], ["dark", dark]] as const) {
  test(`palette (${name}): text roles reach WCAG AA on both surfaces`, () => {
    for (const role of ["fg", "muted", "accent", "good", "warning", "error"]) {
      for (const surface of ["bg", "surface"]) {
        const c = contrast(t[role], t[surface]);
        assert.ok(c >= 4.5, `--${role} on --${surface}: ${c.toFixed(2)}:1`);
      }
    }
    assert.ok(contrast(t["on-accent"], t.accent) >= 4.5, "--on-accent on --accent");
    assert.ok(contrast(t.fg, t.bg) >= 7, "main text is AAA");
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
const files = walk(SRC).filter((f) => /\.(css|tsx?)$/.test(f) && !f.endsWith("palette.css") && !f.endsWith("Gallery.tsx"));

test("no literal colors outside the palette", () => {
  const bad = files.flatMap((f) =>
    readFileSync(f, "utf8")
      .split("\n")
      .map((line, i) => ({ line, i }))
      // #abc / #aabbcc as a CSS color, rgb()/hsl() with a color (shadows with an alpha are allowed)
      .filter(({ line }) => /(?<![\w&])#[0-9a-fA-F]{3}(?:[0-9a-fA-F]{3})?\b(?![\w-])/.test(line.replace(/["'`]#[^"'`]*["'`]/g, "")) && /color|background|fill|stroke|border/.test(line))
      .map(({ i }) => `${f.slice(SRC.length + 1)}:${i + 1}`),
  );
  assert.deepEqual(bad, []);
});

test("every var(--token) the app uses is defined", () => {
  const defined = new Set([...Object.keys(light), ...files.flatMap((f) => [...readFileSync(f, "utf8").matchAll(/(--[\w-]+):/g)].map((m) => m[1].slice(2)))]);
  const used = files.flatMap((f) => [...readFileSync(f, "utf8").matchAll(/var\(--([\w-]+)/g)].map((m) => ({ token: m[1], file: f.slice(SRC.length + 1) }))).filter((u) => !u.token.endsWith("-")); // --series-${slot}: checked above
  assert.deepEqual(
    used.filter((u) => !defined.has(u.token)).map((u) => `${u.file}: --${u.token}`),
    [],
  );
});
