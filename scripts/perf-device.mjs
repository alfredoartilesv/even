/**
 * Start-up and navigation timings on an Android device or emulator, for comparing two builds.
 *
 *   node scripts/perf-device.mjs --apk <debug apk> --package app.health.personal.perf --label before --runs 7 --out perf-before.json
 *   node scripts/perf-device.mjs --packages app.health.personal.perf,app.health.personal.perf2 --labels before,after --outs b.json,a.json --runs 15
 *   node scripts/perf-device.mjs --compare perf-before.json perf-after.json
 *
 * Each run is a cold start (force-stop, then am start -W). The WebView's DevTools socket (debug
 * builds only) gives the browser's own timings and the app's performance marks:
 * - launch: Android's TotalTime, until the first native frame;
 * - fcp: first contentful paint in the WebView;
 * - dbOpen: the encrypted database open and migrated (mark even:db-open);
 * - dashboard: the Dashboard's first numbers on screen (mark even:dashboard-ready);
 * - heap: JS heap in use once the Dashboard is up;
 * - tabs: a second after the Dashboard, tapping each tab until its title is on screen and painted,
 *   first visit and second.
 * Medians over the runs. Build with VITE_PERF_SEED=1 so the database holds about a real phone's
 * data (src/app/perfSeed.ts); the first launch after install seeds it and is not counted.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .reduce((acc, a, i, all) => (a.startsWith("--") ? [...acc, [a.slice(2), all[i + 1]?.startsWith("--") ? true : (all[i + 1] ?? true)]] : acc), []),
);
const ACTIVITY = "app.health.personal.MainActivity";
const TABS = [
  { label: "Chat", title: /^Chat$/ },
  { label: "Meal prep", title: /^Meal prep$/ },
  { label: "Alcohol", title: /^Alcohol$/ },
  { label: "Settings", title: /^Settings$/ },
  { label: "Dashboard", title: /^Hi\b/ },
];
const PORT = 9333;

// A frozen emulator makes adb hang: fail after a minute instead of waiting forever.
const adb = (...a) => execFileSync("adb", a, { encoding: "utf8", timeout: 60_000 }).trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const median = (xs) => {
  const s = xs.filter((x) => typeof x === "number").sort((a, b) => a - b);
  return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : null;
};

/** One DevTools session on the app's WebView; evaluate() runs an expression and awaits it. */
async function devtools(pkg) {
  const pid = adb("shell", "pidof", pkg).split(/\s+/)[0];
  let socket = null;
  for (let i = 0; i < 100 && !socket; i++) {
    socket = adb("shell", "cat", "/proc/net/unix").match(new RegExp(`@(webview_devtools_remote_${pid})\\b`))?.[1] ?? null;
    if (!socket) await sleep(100);
  }
  if (!socket) throw new Error(`no WebView DevTools socket for ${pkg} (pid ${pid}); is it a debug build?`);
  adb("forward", `tcp:${PORT}`, `localabstract:${socket}`);
  let target;
  for (let i = 0; i < 100 && !target; i++) {
    try {
      target = (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()).find((t) => t.type === "page");
    } catch {}
    if (!target) await sleep(100);
  }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r, j) => ((ws.onopen = r), (ws.onerror = j)));
  let id = 0;
  const pending = new Map();
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  };
  const evaluate = async (expression) => {
    const msg = await new Promise((r) => {
      pending.set(++id, r);
      ws.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression, awaitPromise: true, returnByValue: true } }));
    });
    if (msg.result?.exceptionDetails) throw new Error(msg.result.exceptionDetails.exception?.description ?? "evaluate failed");
    return msg.result?.result?.value;
  };
  return { evaluate, close: () => (ws.close(), adb("forward", "--remove", `tcp:${PORT}`)) };
}

/** Waits for the Dashboard mark, then reads the timings the WebView kept since navigation. */
const START_TIMINGS = `(async () => {
  for (let i = 0; i < 1200 && performance.getEntriesByName("even:dashboard-ready").length === 0; i++) await new Promise((r) => setTimeout(r, 50));
  const mark = (n) => performance.getEntriesByName(n)[0]?.startTime ?? null;
  const fcp = performance.getEntriesByType("paint").find((p) => p.name === "first-contentful-paint")?.startTime ?? null;
  const marks = Object.fromEntries(performance.getEntriesByType("mark").filter((m) => m.name.startsWith("even:")).map((m) => [m.name.slice(5), Math.round(m.startTime)]));
  return { fcp, dbOpen: mark("even:db-open"), dashboard: mark("even:dashboard-ready"), heap: performance.memory?.usedJSHeapSize ?? null, marks };
})()`;

/** Taps each tab in turn and times it until its title is on screen and a frame has been painted. */
const TAB_TIMINGS = `(async (tabs) => {
  const frame = () => new Promise((r) => requestAnimationFrame(() => r()));
  const out = {};
  for (const round of [1, 2]) {
    for (const t of tabs) {
      const button = [...document.querySelectorAll("nav.tabbar button")].find((b) => b.textContent.trim() === t.label);
      const t0 = performance.now();
      button.click();
      const re = new RegExp(t.title);
      for (let i = 0; i < 400; i++) {
        const h1 = [...document.querySelectorAll("h1")].map((h) => h.textContent.trim());
        if (h1.some((x) => re.test(x))) break;
        await frame();
      }
      await frame();
      out[t.label + (round === 1 ? " (first)" : " (again)")] = performance.now() - t0;
    }
  }
  return out;
})(${JSON.stringify(TABS.map((t) => ({ label: t.label, title: t.title.source })))})`;

async function coldStart(pkg) {
  adb("shell", "am", "force-stop", pkg);
  await sleep(1500);
  const launch = Number(adb("shell", "am", "start", "-W", "-n", `${pkg}/${ACTIVITY}`).match(/TotalTime:\s*(\d+)/)?.[1] ?? NaN);
  const dt = await devtools(pkg);
  try {
    const start = await dt.evaluate(START_TIMINGS);
    // A person taps a tab a moment after the Dashboard appears, not in the same frame.
    await sleep(1000);
    const tabs = await dt.evaluate(TAB_TIMINGS);
    return { launch, ...start, tabs };
  } finally {
    dt.close();
  }
}

const summary = (label, all) => {
  const tabNames = Object.keys(all[0].tabs);
  return {
    label,
    device: `${adb("shell", "getprop", "ro.product.model")}, Android ${adb("shell", "getprop", "ro.build.version.release")}`,
    runs: all.length,
    median: {
      launch: median(all.map((r) => r.launch)),
      fcp: median(all.map((r) => r.fcp)),
      dbOpen: median(all.map((r) => r.dbOpen)),
      dashboard: median(all.map((r) => r.dashboard)),
      heapMB: median(all.map((r) => r.heap && r.heap / 1048576)),
      tabs: Object.fromEntries(tabNames.map((n) => [n, median(all.map((r) => r.tabs[n]))])),
    },
    raw: all,
  };
};

/** First launch after install: migrations and the seed. Not counted. */
async function warmUp(pkg) {
  adb("shell", "am", "force-stop", pkg);
  adb("shell", "am", "start", "-W", "-n", `${pkg}/${ACTIVITY}`);
  const warm = await devtools(pkg);
  await warm.evaluate(START_TIMINGS);
  warm.close();
  adb("shell", "am", "force-stop", pkg);
}

/**
 * One build (--package, --apk) or two installed side by side (--packages a,b with --labels and
 * --outs): two builds alternate cold starts, so the emulator's drift over minutes falls on both.
 */
async function measure() {
  const pkgs = String(args.packages ?? args.package ?? "app.health.personal.perf").split(",");
  const labels = String(args.labels ?? args.label ?? pkgs.join(",")).split(",");
  const outs = args.outs ? String(args.outs).split(",") : args.out ? [String(args.out)] : [];
  const runs = Number(args.runs ?? 7);
  if (args.apk && args.apk !== true) {
    adb("install", "-r", args.apk);
    console.log(`installed ${args.apk}`);
  }
  for (const pkg of pkgs) await warmUp(pkg);
  const all = pkgs.map(() => []);
  for (let i = 0; i < runs; i++) {
    for (const [k, pkg] of pkgs.entries()) {
      const r = await coldStart(pkg);
      all[k].push(r);
      console.log(
        `run ${i + 1} ${labels[k]}: launch ${r.launch} ms, fcp ${r.fcp?.toFixed(0)} ms, db ${r.dbOpen?.toFixed(0)} ms, dashboard ${r.dashboard?.toFixed(0)} ms`,
      );
      adb("shell", "am", "force-stop", pkg);
    }
  }
  for (const [k] of pkgs.entries()) {
    const result = summary(labels[k], all[k]);
    if (outs[k]) writeFileSync(outs[k], JSON.stringify(result, null, 2));
    console.log(labels[k], JSON.stringify(result.median));
  }
}

function compare(a, b) {
  const [x, y] = [a, b].map((f) => JSON.parse(readFileSync(f, "utf8")));
  const rows = [];
  const row = (name, p, q, unit = "ms") => rows.push([name, p, q, unit]);
  for (const k of ["launch", "fcp", "dbOpen", "dashboard"]) row(k, x.median[k], y.median[k]);
  row("heap", x.median.heapMB, y.median.heapMB, "MB");
  for (const k of Object.keys(x.median.tabs)) row(`tab ${k}`, x.median.tabs[k], y.median.tabs[k]);
  console.log(`| | ${x.label} | ${y.label} | change |\n|---|---:|---:|---:|`);
  for (const [n, p, q, u] of rows) {
    const pct = p && q !== null ? `${(((q - p) / p) * 100).toFixed(0)}%` : "n/a";
    console.log(`| ${n} | ${p?.toFixed(u === "MB" ? 1 : 0)} ${u} | ${q?.toFixed(u === "MB" ? 1 : 0)} ${u} | ${pct} |`);
  }
}

if (args.compare) compare(args.compare, process.argv[process.argv.indexOf("--compare") + 2]);
else await measure();
