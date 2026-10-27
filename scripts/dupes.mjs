/**
 * Copy-paste finder: runs of at least MIN_LINES identical lines (trimmed; blank lines, comments
 * and imports skipped) that appear in more than one place under src/ and scripts/.
 *
 *   node scripts/dupes.mjs            report, exit 0
 *   node scripts/dupes.mjs --max 1.5  also fail when duplicated lines exceed 1.5% (npm run health)
 *   node scripts/dupes.mjs --json     machine-readable totals
 *
 * Tests are left out on purpose: similar arrange/act/assert blocks keep each test readable.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const DIRS = ["src", "scripts"];
const EXT = /\.(ts|tsx|mjs)$/;
const MIN_LINES = 8;

const args = process.argv.slice(2);
const max = args.includes("--max") ? Number(args[args.indexOf("--max") + 1]) : null;

function files(dir) {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : EXT.test(f) ? [p] : [];
  });
}

/** Code lines only, each with its line number. */
function codeLines(text) {
  const out = [];
  let inBlock = false;
  text.split(/\r?\n/).forEach((raw, i) => {
    let l = raw.trim();
    if (inBlock) {
      if (l.includes("*/")) inBlock = false;
      return;
    }
    if (l.startsWith("/*")) {
      if (!l.includes("*/")) inBlock = true;
      return;
    }
    if (!l || l.startsWith("//") || l.startsWith("import ") || /^[)}\]];?,?$/.test(l) || l === "});" || l === "})") return;
    out.push({ l, n: i + 1 });
  });
  return out;
}

const all = DIRS.flatMap((d) => files(join(ROOT, d))).map((f) => ({
  file: relative(ROOT, f).split("\\").join("/"),
  lines: codeLines(readFileSync(f, "utf8")),
}));
const windows = new Map();
for (const f of all) {
  for (let i = 0; i + MIN_LINES <= f.lines.length; i++) {
    const key = f.lines
      .slice(i, i + MIN_LINES)
      .map((x) => x.l)
      .join("\n");
    if (!windows.has(key)) windows.set(key, []);
    windows.get(key).push({ file: f.file, i });
  }
}

// Mark every line that belongs to a repeated window, per file; then group into runs.
const dup = new Map(all.map((f) => [f.file, new Set()]));
const groups = new Map();
for (const [key, hits] of windows) {
  if (hits.length < 2) continue;
  for (const h of hits) for (let k = 0; k < MIN_LINES; k++) dup.get(h.file).add(h.i + k);
  const sig = hits
    .map((h) => h.file)
    .sort()
    .join(" + ");
  groups.set(sig, (groups.get(sig) ?? 0) + 1);
  void key;
}
const total = all.reduce((n, f) => n + f.lines.length, 0);
const duplicated = [...dup.values()].reduce((n, s) => n + s.size, 0);
const pct = (duplicated / total) * 100;

if (args.includes("--json")) {
  console.log(JSON.stringify({ files: all.length, codeLines: total, duplicatedLines: duplicated, percent: Number(pct.toFixed(2)) }));
} else {
  console.log(`${all.length} files, ${total} code lines, ${duplicated} in repeated blocks of ${MIN_LINES}+ lines (${pct.toFixed(2)}%)`);
  const runs = [];
  for (const f of all) {
    const set = dup.get(f.file);
    let start = null;
    for (let i = 0; i <= f.lines.length; i++) {
      if (set.has(i) && start === null) start = i;
      if (!set.has(i) && start !== null) {
        runs.push({ file: f.file, from: f.lines[start].n, to: f.lines[i - 1].n, n: i - start });
        start = null;
      }
    }
  }
  for (const r of runs.sort((a, b) => b.n - a.n)) console.log(`  ${String(r.n).padStart(4)} lines  ${r.file}:${r.from}-${r.to}`);
}
if (max !== null && pct > max) {
  console.error(`Duplicated code ${pct.toFixed(2)}% is over the ${max}% limit`);
  process.exit(1);
}
