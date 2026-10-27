import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

/**
 * The layer rules from docs/architecture.md section 3, checked on the import graph:
 *   app -> features, ui, platform, db, core
 *   features (screens) -> other features, ui, platform, db, core
 *   features (logic, *.ts) -> other features' logic, db, core: never Capacitor, even indirectly
 *   ui -> core.   db -> core.   core -> nothing.   platform -> db, core (and the native plugins)
 */

const SRC = resolve(import.meta.dirname, "../src");
const NATIVE = /^@capacitor|^@aparajita/;

function walk(dir: string, out: string[] = []): string[] {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(f)) out.push(p);
  }
  return out;
}

const files = walk(SRC);
const rel = (p: string) => relative(SRC, p).split("\\").join("/");
const layer = (p: string) =>
  rel(p)
    .split("/")[0]
    .replace(/\.tsx?$/, "");

interface Imp {
  spec: string;
  typeOnly: boolean;
  target: string | null;
}

function imports(file: string): Imp[] {
  const src = readFileSync(file, "utf8");
  const out: Imp[] = [];
  for (const m of src.matchAll(/^\s*(import|export)\s+(type\s+)?[^"';]*?from\s+["']([^"']+)["']/gm)) {
    const spec = m[3];
    let target: string | null = null;
    if (spec.startsWith(".")) {
      for (const ext of [".ts", ".tsx", "/index.ts", ""]) {
        const cand = resolve(dirname(file), spec + ext);
        if (existsSync(cand) && statSync(cand).isFile()) {
          target = cand;
          break;
        }
      }
    }
    out.push({ spec, typeOnly: Boolean(m[2]), target });
  }
  for (const m of src.matchAll(/^\s*import\s+["']([^"']+)["']/gm)) out.push({ spec: m[1], typeOnly: false, target: null });
  return out;
}

/** Feature logic: .ts files outside a ui/ folder. Screens are .tsx or live under ui/. */
const isLogic = (p: string) => p.endsWith(".ts") && !rel(p).includes("/ui/");

const graph = new Map(files.map((f) => [f, imports(f)]));

/** Path of runtime imports from file to a native package, or null. */
function nativePath(file: string, seen = new Set<string>()): string[] | null {
  if (seen.has(file)) return null;
  seen.add(file);
  for (const i of graph.get(file) ?? []) {
    if (i.typeOnly) continue;
    if (NATIVE.test(i.spec)) return [rel(file), i.spec];
    if (i.target) {
      const p = nativePath(i.target, seen);
      if (p) return [rel(file), ...p];
    }
  }
  return null;
}

test("every relative import resolves", () => {
  const broken = [...graph].flatMap(([f, imps]) =>
    imps.filter((i) => i.spec.startsWith(".") && !i.target && !i.spec.endsWith(".css") && !i.spec.includes("?")).map((i) => `${rel(f)} -> ${i.spec}`),
  );
  assert.deepEqual(broken, []);
});

test("logic outside platform and app never reaches a native plugin at runtime", () => {
  const bad = files
    .filter((f) => ["core", "db", "features"].includes(layer(f)) && isLogic(f))
    .map((f) => nativePath(f))
    .filter((p): p is string[] => p !== null)
    .map((p) => p.join(" -> "));
  assert.deepEqual(bad, []);
});

test("native plugins are imported only in platform/", () => {
  const bad = [...graph].flatMap(([f, imps]) =>
    layer(f) === "platform" ? [] : imps.filter((i) => !i.typeOnly && NATIVE.test(i.spec)).map((i) => `${rel(f)} -> ${i.spec}`),
  );
  assert.deepEqual(bad, []);
});

test("layers only depend downwards", () => {
  const allowed: Record<string, string[]> = {
    core: ["core"],
    db: ["db", "core"],
    platform: ["platform", "db", "core"],
    ui: ["ui", "core"],
    features: ["features", "ui", "platform", "db", "core"],
    app: ["app", "features", "ui", "platform", "db", "core"],
    main: ["app"],
  };
  const bad: string[] = [];
  for (const [f, imps] of graph) {
    for (const i of imps) {
      if (!i.target) continue;
      const from = layer(f);
      const to = layer(i.target);
      if (!allowed[from]?.includes(to)) bad.push(`${rel(f)} -> ${rel(i.target)}`);
      // Feature logic must not depend on any screen.
      if (from === "features" && isLogic(f) && !isLogic(i.target)) bad.push(`${rel(f)} -> ${rel(i.target)} (logic imports UI)`);
    }
  }
  assert.deepEqual(bad, []);
});
