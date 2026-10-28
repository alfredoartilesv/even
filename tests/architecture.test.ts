import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

/**
 * The layer rules from docs/architecture.md section 3, checked on the import graph:
 *   apps/<target> -> screens, domain, ui, platform, db, core; never another target
 *   screens -> other screens, domain, ui, platform, db, core
 *   domain -> other domain, db, core: never a screen, ui or platform, so never Capacitor
 *   ui -> core.   db -> core.   core -> nothing.   platform -> db, core (and the native plugins)
 * Everything below apps/ is shared by every target; a target diverges by its own shell and,
 * when it needs one, its own screen inside apps/<target>/.
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
/** "core", "domain", ... or "apps/<target>". */
const layer = (p: string) => {
  const [top, sub] = rel(p).split("/");
  return top === "apps" ? `apps/${sub}` : top;
};

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

test("code outside platform, screens and apps never reaches a native plugin at runtime", () => {
  const bad = files
    .filter((f) => ["core", "db", "domain", "ui"].includes(layer(f)))
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
  const shared = ["screens", "domain", "ui", "platform", "db", "core"];
  const allowed: Record<string, string[]> = {
    core: ["core"],
    db: ["db", "core"],
    platform: ["platform", "db", "core"],
    ui: ["ui", "core"],
    domain: ["domain", "db", "core"],
    screens: shared,
  };
  const bad: string[] = [];
  for (const [f, imps] of graph) {
    for (const i of imps) {
      if (!i.target) continue;
      const from = layer(f);
      const to = layer(i.target);
      const ok = from.startsWith("apps/") ? to === from || shared.includes(to) : allowed[from]?.includes(to);
      if (!ok) bad.push(`${rel(f)} -> ${rel(i.target)}`);
    }
  }
  assert.deepEqual(bad, []);
});

test("source lives only in the known layers, and every target has its entry", () => {
  const layers = new Set(["core", "db", "domain", "platform", "ui", "screens"]);
  const stray = files.map(layer).filter((l) => !layers.has(l) && !l.startsWith("apps/"));
  assert.deepEqual([...new Set(stray)], []);
  for (const t of readdirSync(join(SRC, "apps"))) assert.ok(existsSync(join(SRC, "apps", t, "main.tsx")), `apps/${t}/main.tsx`);
});
