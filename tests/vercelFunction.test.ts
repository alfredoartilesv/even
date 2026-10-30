import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

// Vercel compiles each file of the function to .js on its own and Node loads them as ESM, which
// resolves no extensions: an import of "./pg" crashed every request with ERR_MODULE_NOT_FOUND.
// Vite and tsx forgive that, so this test loads the function the way Vercel does.
const root = join(import.meta.dirname, "..");
const entry = "api/[[...route]].ts";
const RELATIVE_IMPORT = /(?:from|import)\s*\(?\s*"(\.{1,2}\/[^"]+)"/g;

/** The function's own files: the entry and everything it reaches by relative imports. */
function functionFiles(): string[] {
  const seen = new Set<string>();
  const visit = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    for (const [, spec] of readFileSync(join(root, file), "utf8").matchAll(RELATIVE_IMPORT)) {
      visit(relative(root, resolve(root, dirname(file), spec.replace(/\.js$/, ".ts"))).replace(/\\/g, "/"));
    }
  };
  visit(entry);
  return [...seen];
}

test("the function's relative imports name a .js file, so Node finds them once compiled", () => {
  for (const file of functionFiles()) {
    for (const [, spec] of readFileSync(join(root, file), "utf8").matchAll(RELATIVE_IMPORT)) {
      assert.match(spec, /\.js$/, `${file} imports "${spec}"`);
    }
  }
});

test("the Vercel function loads under plain Node once each file is compiled to .js", () => {
  // Inside node_modules so packages resolve and the root package.json makes the files ESM.
  const out = join(root, "node_modules", ".cache", "vercel-function-test");
  rmSync(out, { recursive: true, force: true });
  for (const file of functionFiles()) {
    const target = join(out, file.replace(/\.ts$/, ".js"));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, stripTypeScriptTypes(readFileSync(join(root, file), "utf8")));
  }
  // A plain child process: this one runs under tsx, which would forgive a missing extension.
  const url = pathToFileURL(join(out, entry.replace(/\.ts$/, ".js"))).href;
  const run = spawnSync(process.execPath, ["--input-type=module", "-e", `await import(${JSON.stringify(url)})`], {
    env: { PATH: process.env.PATH, DATABASE_URL: "postgres://user:pass@127.0.0.1:1/none", SERVER_SECRET: "test", VERCEL: "1" },
    encoding: "utf8",
  });
  rmSync(out, { recursive: true, force: true });
  assert.equal(run.status, 0, run.stderr);
});
