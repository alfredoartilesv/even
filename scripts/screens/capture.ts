/**
 * npm run docs:screens
 *
 * Captures every screen of the app at phone size, in light and dark, and writes the HTML docs:
 *   docs/screens/index.html    every tab and view, with what it shows
 *   docs/screens/palette.html  the color palette (src/ui/palette.css) with contrast ratios
 *   docs/screens/img/*.webp    the captures
 *
 * How: Vite serves the real app with the native database swapped for an in-memory demo one
 * (vite.config.ts, demoDatabase.ts), and a headless Chrome (CHROME_PATH, or the usual install
 * paths) is driven over the DevTools protocol. Nothing leaves the PC; no message is sent to Claude.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "vite";

const ROOT = resolve(import.meta.dirname, "../..");
const OUT = join(ROOT, "docs/screens");
const IMG = join(OUT, "img");
const WIDTH = 390;
const HEIGHT = 844;
const MAX_HEIGHT = 2600;

// ---- Chrome over the DevTools protocol ----

const CHROMES = [
  process.env.CHROME_PATH,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
].filter((p): p is string => Boolean(p));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function launchChrome() {
  const bin = CHROMES.find((p) => existsSync(p));
  if (!bin) throw new Error("No Chrome or Edge found. Set CHROME_PATH.");
  const port = 9400 + Math.floor(Math.random() * 400);
  const profile = mkdtempSync(join(tmpdir(), "health-screens-"));
  const proc = spawn(bin, ["--headless=new", `--remote-debugging-port=${port}`, "--no-first-run", "--disable-gpu", "--hide-scrollbars", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
  let wsUrl: string | null = null;
  for (let i = 0; i < 100 && !wsUrl; i++) {
    try {
      const list = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()) as { type: string; webSocketDebuggerUrl: string }[];
      wsUrl = list.find((t) => t.type === "page")?.webSocketDebuggerUrl ?? null;
    } catch {
      await sleep(100);
    }
  }
  if (!wsUrl) throw new Error("Chrome did not start");
  const ws = new WebSocket(wsUrl);
  await new Promise((r) => ws.addEventListener("open", r, { once: true }));
  let id = 0;
  const pending = new Map<number, (m: { result?: Record<string, unknown>; error?: unknown }) => void>();
  const errors: string[] = [];
  ws.addEventListener("message", (e) => {
    const m = JSON.parse(String(e.data));
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)!(m);
      pending.delete(m.id);
    }
    if (m.method === "Runtime.exceptionThrown") errors.push(m.params.exceptionDetails.exception?.description ?? "exception");
    if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") errors.push(m.params.args.map((a: { value?: string }) => a.value).join(" "));
  });
  const send = (method: string, params: Record<string, unknown> = {}) =>
    new Promise<Record<string, unknown>>((res, rej) => {
      const i = ++id;
      pending.set(i, (m) => (m.error ? rej(new Error(`${method}: ${JSON.stringify(m.error)}`)) : res(m.result ?? {})));
      ws.send(JSON.stringify({ id: i, method, params }));
    });
  const close = () => {
    ws.close();
    proc.kill();
    try {
      rmSync(profile, { recursive: true, force: true });
    } catch {
      // Chrome may still hold the profile for a moment; it is in the temp folder anyway.
    }
  };
  return { send, errors, close };
}

type Chrome = Awaited<ReturnType<typeof launchChrome>>;

function page(c: Chrome) {
  const evaluate = async <T>(expr: string): Promise<T> => {
    const r = (await c.send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true })) as { result: { value: T }; exceptionDetails?: unknown };
    if (r.exceptionDetails) throw new Error(`evaluate failed: ${expr}`);
    return r.result.value;
  };
  const waitFor = async (expr: string, what: string) => {
    for (let i = 0; i < 60; i++) {
      if (await evaluate<boolean>(expr)) return;
      await sleep(100);
    }
    throw new Error(`Timed out waiting for ${what}`);
  };
  /** Click the first element matching selector whose text contains text (or the first match when text is empty). */
  const click = async (selector: string, text = "") => {
    const ok = await evaluate<boolean>(
      `(() => { const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find(e => e.textContent.includes(${JSON.stringify(text)})); if (!el) return false; el.click(); return true; })()`,
    );
    if (!ok) throw new Error(`Nothing to click: ${selector} "${text}"`);
    await sleep(450);
  };
  const shot = async (file: string) => {
    await evaluate("window.scrollTo(0, 0)");
    const full = Math.min(MAX_HEIGHT, Math.max(HEIGHT, await evaluate<number>("document.documentElement.scrollHeight")));
    await c.send("Emulation.setDeviceMetricsOverride", { width: WIDTH, height: full, deviceScaleFactor: 2, mobile: true });
    await sleep(300);
    const r = (await c.send("Page.captureScreenshot", { format: "webp", quality: 85 })) as { data: string };
    writeFileSync(join(IMG, file), Buffer.from(r.data, "base64"));
    await c.send("Emulation.setDeviceMetricsOverride", { width: WIDTH, height: HEIGHT, deviceScaleFactor: 2, mobile: true });
    await sleep(150);
  };
  return { evaluate, waitFor, click, shot };
}

type Page = ReturnType<typeof page>;

// ---- What to capture ----

interface Screen {
  id: string;
  tab: string;
  title: string;
  about: string;
  go: (p: Page) => Promise<void>;
}

const tab = (p: Page, label: string) => p.click(".tabbar button", label);
const sub = (p: Page, label: string) => p.click(".tabs.sub button", label);

const SCREENS: Screen[] = [
  { id: "dashboard-day", tab: "Dashboard", title: "Day", about: "The profile picture (opens the profile) and sync at the top. Steps, calories burned and eaten, the balance, active calories and protein for the day; meal prep portions and stock; workouts; every synced number of the day.", go: (p) => tab(p, "Dashboard") },
  {
    id: "dashboard-week",
    tab: "Dashboard",
    title: "Week",
    about: "Last full week: each tile is the daily average, with the total and the days with data under it. Steps per day (tap a day to open it) and calories in and out against the calorie target.",
    go: async (p) => {
      await p.click(".segmented button", "Week");
      await p.click('[aria-label="Previous week"]');
    },
  },
  { id: "dashboard-month", tab: "Dashboard", title: "Month", about: "The same figures for a calendar month: daily averages and totals, and the charts per day.", go: (p) => p.click(".segmented button", "Month") },
  {
    id: "profile",
    tab: "Dashboard",
    title: "Profile",
    about: "Opened from the picture on the Dashboard: name and body numbers, sports, goals with progress, and the past activity imported from the Garmin export or synced: totals per sport, longest sessions, recent workouts.",
    go: async (p) => {
      await p.click(".segmented button", "Day");
      await p.click(".profile-button");
    },
  },
  {
    id: "chat",
    tab: "Chat",
    title: "Conversation",
    about: "A conversation with Claude. History lists past chats; New starts one. Permissions and changes Claude wants to save are asked in line, with undo afterwards.",
    go: async (p) => {
      await p.click('[aria-label="Back to Dashboard"]');
      await tab(p, "Chat");
      await p.waitFor("!!document.querySelector('.composer')", "the chat");
      await p.click(".topbar button", "History");
      await p.click(".chat-list .link");
    },
  },
  {
    id: "chat-photo",
    tab: "Chat",
    title: "New chat, adding a photo",
    about: "Quick prompts to start from. The camera button offers Take a photo (the camera) or Attach an image (the gallery, several at once).",
    go: async (p) => {
      await p.click(".topbar button", "New");
      await p.click('[aria-label="Add a photo"]');
    },
  },
  { id: "mealprep-log", tab: "Meal prep", title: "Log food", about: "Today's calories against the target, macros, Eat again suggestions, Log a meal (with a photo), and today's entries by meal.", go: (p) => tab(p, "Meal prep") },
  { id: "mealprep-history", tab: "Meal prep", title: "History", about: "Calories per day for the week with the target, the weekly average, and any day's entries.", go: (p) => sub(p, "History") },
  { id: "mealprep-saved", tab: "Meal prep", title: "Saved meals", about: "Favourite meals to log again in one tap, with servings.", go: (p) => sub(p, "Saved meals") },
  { id: "mealprep-stock", tab: "Meal prep", title: "Stock", about: "Meal prep portions in the fridge and freezer, the defrost plan, and Eat / Freeze / Defrost per batch.", go: (p) => sub(p, "Stock") },
  { id: "mealprep-recipes", tab: "Meal prep", title: "Recipes", about: "Meal prep recipes with portions, shelf life, macros, tags and ingredients; add them to the shopping list.", go: (p) => sub(p, "Recipes") },
  { id: "alcohol", tab: "Alcohol", title: "Alcohol", about: "Drinks per period with standard drinks, kcal and money; weight without alcohol; one-tap logging from drink types.", go: (p) => tab(p, "Alcohol") },
  { id: "settings-profile", tab: "Settings", title: "Profile", about: "Google account, the owner's profile and the estimates it allows (BMI, BMR, daily energy, calorie and protein targets).", go: (p) => tab(p, "Settings") },
  { id: "settings-connections", tab: "Settings", title: "Connections", about: "The Garmin personal API key (sync), the Claude API key, and the Garmin history import.", go: (p) => sub(p, "Connections") },
  { id: "settings-privacy", tab: "Settings", title: "Privacy & data", about: "What Claude may see, what was sent, what is stored on the phone, and the encrypted backup.", go: (p) => sub(p, "Privacy & data") },
  { id: "settings-logs", tab: "Settings", title: "Debug logs", about: "This run's log records, the level, and an export as a Markdown report to hand to Claude.", go: (p) => sub(p, "Debug logs") },
  { id: "settings-about", tab: "Settings", title: "About", about: "App version, build, platform, database schema and chat model.", go: (p) => sub(p, "About") },
];

const THEMES = ["light", "dark"] as const;

async function capture(url: string) {
  rmSync(IMG, { recursive: true, force: true });
  mkdirSync(IMG, { recursive: true });
  const chrome = await launchChrome();
  try {
    await chrome.send("Runtime.enable");
    await chrome.send("Page.enable");
    for (const theme of THEMES) {
      await chrome.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: theme }] });
      await chrome.send("Emulation.setDeviceMetricsOverride", { width: WIDTH, height: HEIGHT, deviceScaleFactor: 2, mobile: true });
      await chrome.send("Page.navigate", { url });
      const p = page(chrome);
      await p.waitFor("!!document.querySelector('.tabbar') && document.body.innerText.includes('Steps')", "the app");
      await sleep(800);
      for (const s of SCREENS) {
        await s.go(p);
        await p.shot(`${theme}-${s.id}.webp`);
        console.log(`  ${theme} ${s.id}`);
      }
    }
    if (chrome.errors.length) throw new Error(`The app logged errors:\n${chrome.errors.join("\n")}`);
  } finally {
    chrome.close();
  }
}

// ---- The documents ----

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const PALETTE = readFileSync(join(ROOT, "src/ui/palette.css"), "utf8");

/** Page chrome shared by both documents: the app's own palette, so the docs look like the app. */
const docHead = (title: string) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
${PALETTE}
body { margin: 0; background: var(--bg); color: var(--fg); font: 15px/1.5 system-ui, sans-serif; }
main { max-width: 72rem; margin: 0 auto; padding: 2rem 16px 4rem; }
h1 { margin: 0 0 0.25rem; } h2 { margin: 2.5rem 0 0.75rem; padding-top: 1rem; border-top: 1px solid var(--line); }
.muted { color: var(--muted); } a { color: var(--accent); }
nav.toc { display: flex; flex-wrap: wrap; gap: 0.4rem; margin: 1rem 0; }
nav.toc a, .themes button { border: 1px solid var(--line); border-radius: var(--radius-pill); padding: 0.3rem 0.8rem; text-decoration: none; background: var(--surface); color: var(--fg); font: inherit; cursor: pointer; }
.themes { display: flex; gap: 0.4rem; margin: 0.5rem 0 1rem; } .themes button[aria-pressed="true"] { border-color: var(--accent); color: var(--accent); }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(17rem, 1fr)); gap: 1.5rem; align-items: start; }
figure { margin: 0; } figcaption { margin-top: 0.5rem; font-size: 0.9rem; } figcaption strong { display: block; }
.shot { display: flex; gap: 0.5rem; } .shot img { width: 100%; height: auto; border: 1px solid var(--line); border-radius: var(--radius); background: var(--surface); }
body[data-show="light"] .shot img.dark, body[data-show="dark"] .shot img.light { display: none; }
body[data-show="both"] .grid { grid-template-columns: repeat(auto-fill, minmax(30rem, 1fr)); }
table { border-collapse: collapse; width: 100%; } th, td { text-align: left; padding: 0.45rem 0.5rem; border-bottom: 1px solid var(--line); vertical-align: top; } th { color: var(--muted); font-weight: normal; }
code { font-size: 0.9em; }
</style>
</head>`;

function indexHtml(): string {
  const tabs = [...new Set(SCREENS.map((s) => s.tab))];
  const slug = (t: string) => t.toLowerCase().replace(/\W+/g, "-");
  const components = [
    ["PageHeader", "src/ui/layout.tsx", "The title row of every tab: back button or profile picture, title, actions (sync, History, New)."],
    ["SubTabs", "src/ui/layout.tsx", "The views of a tab: Meal prep (Log food … Shopping) and Settings (Profile … About)."],
    ["Segmented", "src/ui/layout.tsx", "Day / Week / Month on the Dashboard."],
    ["ChipGroup, RangePicker", "src/ui/controls.tsx", "Periods and filters: Alcohol periods, profile activity ranges, chart ranges."],
    ["Icon", "src/ui/icons.tsx", "Tab bar icons, the chat's camera and send buttons."],
    ["TabBar", "src/app/TabBar.tsx", "The five tabs at the bottom."],
    ["StatTile, Meter, BarChart, LineChart, CalendarHeatmap", "src/ui/charts/", "Numbers and charts: Dashboard tiles and charts, goals, food history."],
    ["StatusBadge, Stepper", "src/ui/controls.tsx", "States as icon and words; portion counts."],
    ["CalorieMeter, MacroSplit", "src/ui/nutrition.tsx", "Calories against the target, macro shares (Log food)."],
    ["StockSummary, DefrostTimeline, StockAlerts, BatchBar", "src/ui/mealprep/", "Meal prep stock and the defrost plan."],
  ];
  return `${docHead("Health app screens")}
<body data-show="light">
<main>
<h1>Health app screens</h1>
<p class="muted">Every tab and view at phone size (390 × 844 pt), captured from the app with invented demo data by <code>npm run docs:screens</code>. Colors: <a href="palette.html">the palette</a>.</p>
<div class="themes" role="group" aria-label="Theme">
  <button type="button" data-show="light" aria-pressed="true">Light</button>
  <button type="button" data-show="dark" aria-pressed="false">Dark</button>
  <button type="button" data-show="both" aria-pressed="false">Side by side</button>
</div>
<nav class="toc">${tabs.map((t) => `<a href="#${slug(t)}">${esc(t)}</a>`).join("")}<a href="#components">Components</a></nav>
<p>Five tabs in a bar at the bottom: <strong>Dashboard</strong>, <strong>Chat</strong>, <strong>Meal prep</strong>, <strong>Alcohol</strong>, <strong>Settings</strong>. Sync and the profile sit at the top of the Dashboard.</p>
${tabs
  .map(
    (t) => `<h2 id="${slug(t)}">${esc(t)}</h2>
<div class="grid">
${SCREENS.filter((s) => s.tab === t)
  .map(
    (s) => `<figure>
  <div class="shot">${THEMES.map((th) => `<img class="${th}" src="img/${th}-${s.id}.webp" alt="${esc(`${t}: ${s.title} (${th})`)}" loading="lazy">`).join("")}</div>
  <figcaption><strong>${esc(s.title)}</strong><span class="muted">${esc(s.about)}</span></figcaption>
</figure>`,
  )
  .join("\n")}
</div>`,
  )
  .join("\n")}
<h2 id="components">Components</h2>
<p class="muted">Screens are built from the shared UI kit in <code>src/ui/</code>. Tests (<code>tests/uiLayout.test.ts</code>) keep screens from drawing their own titles, tab rows or icons.</p>
<table><thead><tr><th>Component</th><th>File</th><th>Used for</th></tr></thead><tbody>
${components.map(([n, f, u]) => `<tr><td><code>${esc(n)}</code></td><td><code>${esc(f)}</code></td><td>${esc(u)}</td></tr>`).join("\n")}
</tbody></table>
</main>
<script>
for (const b of document.querySelectorAll(".themes button")) b.addEventListener("click", () => {
  document.body.dataset.show = b.dataset.show;
  for (const x of document.querySelectorAll(".themes button")) x.setAttribute("aria-pressed", String(x === b));
});
</script>
</body>
</html>
`;
}

function paletteHtml(): string {
  const parse = (block: string) => Object.fromEntries([...block.matchAll(/--([\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
  const split = PALETTE.indexOf("@media (prefers-color-scheme: dark)");
  const light = parse(PALETTE.slice(0, split));
  const dark = { ...light, ...parse(PALETTE.slice(split)) };
  const lum = (hex: string) => {
    const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  };
  const ratio = (a: string, b: string) => {
    if (!/^#/.test(a) || !/^#/.test(b)) return "";
    const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
    return `${((x + 0.05) / (y + 0.05)).toFixed(1)}:1`;
  };
  const roles = PALETTE.slice(PALETTE.indexOf(" * Roles"), PALETTE.indexOf(" *\n * Series"))
    .split("\n")
    .slice(1)
    .map((l) => /\*\s+--([\w-]+)\s+(.*)/.exec(l))
    .filter((m): m is RegExpExecArray => Boolean(m))
    .map((m) => ({ name: m[1], use: m[2] }));
  const text = new Set(["fg", "muted", "accent", "good", "warning", "error"]);
  const swatch = (theme: Record<string, string>, role: string) => {
    const v = theme[role];
    const fill = v.startsWith("color-mix") ? `color-mix(${v.slice(10, -1).replace(/var\(--(\w[\w-]*)\)/g, (_, n) => theme[n])})` : v;
    return `<td><span style="display:inline-block;width:2.5rem;height:1.6rem;border-radius:6px;border:1px solid ${theme.line};background:${fill};vertical-align:middle"></span> <code>${esc(v.startsWith("color-mix") ? "mix" : v)}</code>${
      text.has(role) ? `<div class="muted" style="font-size:0.8rem">${ratio(v, theme.bg)} on bg · ${ratio(v, theme.surface)} on surface</div>` : role === "on-accent" ? `<div class="muted" style="font-size:0.8rem">${ratio(v, theme.accent)} on accent</div>` : ""
    }</td>`;
  };
  const series = Array.from({ length: 8 }, (_, i) => `series-${i + 1}`);
  return `${docHead("Health app palette")}
<body>
<main>
<h1>Color palette</h1>
<p class="muted">Every color the app uses, by role, from <code>src/ui/palette.css</code>. Screens and the UI kit use these tokens only; <code>tests/palette.test.ts</code> fails the build on a literal color elsewhere and checks that every text role reaches 4.5:1 (WCAG AA) on both surfaces in both themes. <a href="index.html">Screens</a>.</p>
<h2>Roles</h2>
<table><thead><tr><th>Token</th><th>Used for</th><th>Light</th><th>Dark</th></tr></thead><tbody>
${roles.map((r) => `<tr><td><code>--${esc(r.name)}</code></td><td>${esc(r.use)}</td>${swatch(light, r.name)}${swatch(dark, r.name)}</tr>`).join("\n")}
</tbody></table>
<h2>Chart series</h2>
<p class="muted">The validated categorical palette for charts with several series, in this order. One-series charts use the accent.</p>
<table><thead><tr><th>Token</th><th>Light</th><th>Dark</th></tr></thead><tbody>
${series.map((s) => `<tr><td><code>--${s}</code></td>${swatch(light, s)}${swatch(dark, s)}</tr>`).join("\n")}
</tbody></table>
<h2>Shape</h2>
<table><tbody>
${["radius-sm", "radius", "radius-pill"].map((r) => `<tr><td><code>--${r}</code></td><td><code>${esc(light[r])}</code></td><td><span style="display:inline-block;width:4rem;height:2rem;border:1px solid var(--line);background:var(--surface);border-radius:var(--${r})"></span></td></tr>`).join("\n")}
</tbody></table>
</main>
</body>
</html>
`;
}

// ---- Run ----

const server = await createServer({ configFile: join(ROOT, "scripts/screens/vite.config.ts"), logLevel: "warn", server: { port: 5190 } });
await server.listen();
const url = server.resolvedUrls?.local[0];
try {
  if (!url) throw new Error("Vite did not start");
  console.log(`Capturing ${SCREENS.length} screens × ${THEMES.length} themes from ${url}`);
  await capture(url);
  writeFileSync(join(OUT, "index.html"), indexHtml());
  writeFileSync(join(OUT, "palette.html"), paletteHtml());
  console.log(`Wrote docs/screens/index.html, docs/screens/palette.html and ${SCREENS.length * THEMES.length} captures.`);
} finally {
  await server.close();
}
