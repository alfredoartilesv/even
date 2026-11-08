/**
 * npm run docs:screens
 *
 * Captures every screen of the Android app at phone size, then the web app's side menu and wide
 * screens, in light and dark, and writes the HTML docs:
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

interface Viewport {
  width: number;
  height: number;
  mobile: boolean;
}
const PHONE: Viewport = { width: WIDTH, height: HEIGHT, mobile: true };

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
  const proc = spawn(
    bin,
    ["--headless=new", `--remote-debugging-port=${port}`, "--no-first-run", "--disable-gpu", "--hide-scrollbars", `--user-data-dir=${profile}`, "about:blank"],
    { stdio: "ignore" },
  );
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
    const r = (await c.send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true })) as {
      result: { value: T };
      exceptionDetails?: unknown;
    };
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
  /**
   * Click the first element matching selector whose text contains text (or the first match when text
   * is empty). Waits up to 3 s for it: a screen's data (the Dashboard's synced numbers) can arrive
   * after the tab is shown.
   */
  const click = async (selector: string, text = "") => {
    const expr = `(() => { const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find(e => e.textContent.includes(${JSON.stringify(text)})); if (!el) return false; el.click(); return true; })()`;
    for (let i = 0; !(await evaluate<boolean>(expr)); i++) {
      if (i === 30) throw new Error(`Nothing to click: ${selector} "${text}"`);
      await sleep(100);
    }
    await sleep(450);
  };
  let view: Viewport = PHONE;
  /** Set the window: the phone for most captures, a computer or a phone on its side for the wide ones. */
  const resize = async (v: Viewport) => {
    view = v;
    await c.send("Emulation.setDeviceMetricsOverride", { ...v, deviceScaleFactor: v.mobile ? 2 : 1 });
    await sleep(300);
  };
  const shot = async (file: string) => {
    await evaluate("window.scrollTo(0, 0)");
    // An open drawer holds the page still: the screen as the owner sees it, not the whole page.
    const drawer = await evaluate<boolean>("document.body.classList.contains('nav-open')");
    const full = drawer ? view.height : Math.min(MAX_HEIGHT, Math.max(view.height, await evaluate<number>("document.documentElement.scrollHeight")));
    await c.send("Emulation.setDeviceMetricsOverride", { ...view, height: full, deviceScaleFactor: view.mobile ? 2 : 1 });
    await sleep(300);
    const r = (await c.send("Page.captureScreenshot", { format: "webp", quality: 85 })) as { data: string };
    writeFileSync(join(IMG, file), Buffer.from(r.data, "base64"));
    await c.send("Emulation.setDeviceMetricsOverride", { ...view, deviceScaleFactor: view.mobile ? 2 : 1 });
    await sleep(150);
  };
  return { evaluate, waitFor, click, shot, resize };
}

type Page = ReturnType<typeof page>;

// ---- What to capture ----

interface Screen {
  id: string;
  tab: string;
  title: string;
  about: string;
  /** Captured at this size instead of the phone's. */
  viewport?: Viewport;
  /** Captured from the web app (its side menu) instead of Android (its tab bar). */
  web?: true;
  go: (p: Page) => Promise<void>;
}

/**
 * A section, from Android's tab bar or the web app's side menu (by its data-area). Activity,
 * Journal and You are not in the phone's tab bar: You opens from the picture on Today, the other
 * two from You's menu.
 */
const section = async (p: Page, id: string) => {
  const direct = `.tabbar [data-area="${id}"], .sidenav [data-area="${id}"]`;
  if (await p.evaluate<boolean>(`!!document.querySelector(${JSON.stringify(direct)})`)) return p.click(direct);
  await p.click('.tabbar [data-area="today"]');
  await p.click(".profile-button");
  if (id !== "you") await p.click(".menu-row", id === "activity" ? "Activity and sleep" : "Journal");
};
const sub = (p: Page, label: string) => p.click(".tabs.sub button", label);
/** A page of You from its menu (back to the menu first when a page is open). */
const settings = async (p: Page, label: string) => {
  if (await p.evaluate<boolean>(`!!document.querySelector('[aria-label="Back to You"]')`)) await p.click('[aria-label="Back to You"]');
  await p.click(".menu-row", label);
};

const SCREENS: Screen[] = [
  {
    id: "dashboard-day",
    tab: "Today",
    title: "Day",
    about:
      "A greeting with the date (‹ › to other days) and the period (Day, Week, Month). Quick add: type what you ate or drank and it is logged here, nothing leaves the device. The calorie balance ring with protein, carbs and fat left; what is next from the meal prep plan, eaten in one tap with undo; recovery from the watch (sleep, resting heart rate, Body Battery); so far today (meals, drinks, weight); steps for the week; what Coach noticed while Coach is on; the pinned charts.",
    go: (p) => section(p, "today"),
  },
  {
    id: "dashboard-week",
    tab: "Today",
    title: "Week",
    about:
      "Last full week: the rings show daily averages; each tile is the daily average with the total and the days with data under it, intensity minutes against 150 a week, recovery as daily averages with a line per day. Steps per day (tap a day to open it) and calories in and out against the calorie target.",
    go: async (p) => {
      await p.click(".segmented button", "Week");
      await p.click('[aria-label="Previous week"]');
    },
  },
  {
    id: "dashboard-month",
    tab: "Today",
    title: "Month",
    about: "The same figures for a calendar month: daily averages and totals, and the charts per day.",
    go: (p) => p.click(".segmented button", "Month"),
  },
  {
    id: "profile",
    tab: "Activity",
    title: "Activity",
    about:
      "Opened from the picture on the Dashboard (or Your activity): name and body numbers, then Activity or Goals. Activity: the last 30 days against the 30 before, your sports, and the workouts from the Garmin sync or export: a sport filter, training time per week for 12 weeks (tap a week for its sessions), totals per sport (tap one to filter), longest sessions, and every session by month, ten at a time. A session opens to what the watch measured beyond the basics: max heart rate, climb, training effect, VO2 max (one opened here).",
    go: async (p) => {
      await p.click(".segmented button", "Day");
      await section(p, "activity");
      await p.click("details.workout-more > summary");
    },
  },
  {
    id: "profile-goals",
    tab: "You",
    title: "Targets",
    about:
      "How many goals are met of those with data today; the daily nutrition targets (set in the food log) together in one card, each with today against its limit and the last days met; every other goal with its progress, last 7 days and streak, delete behind an icon; Add a goal folded away.",
    go: async (p) => {
      await section(p, "you");
      await settings(p, "Targets");
    },
  },
  {
    id: "journal-checkin",
    tab: "Journal",
    title: "Check-in",
    about:
      "How is today: mood and energy as word chips (Very low to Very good) beside a note for the day, saved with its button; mood and energy over 30 days; the last 30 days of notes, tap one to open it.",
    go: (p) => section(p, "journal"),
  },
  {
    id: "journal-measurements",
    tab: "Journal",
    title: "Measurements",
    about:
      "Add weight, body fat, waist, blood pressure, resting heart rate, glucose, a supplement or a symptom, with the day and time. One card per kind with the latest value and a trend; open it for the 90-day chart and every entry, with delete and undo.",
    go: async (p) => {
      await p.click(".segmented button", "Measurements");
      await p.click(".kind-head", "Weight");
    },
  },
  {
    id: "chat",
    tab: "Coach",
    title: "Conversation",
    about:
      "A conversation with Claude. History lists past chats; New starts one. Permissions and changes Claude wants to save are asked in line, with undo afterwards.",
    go: async (p) => {
      await section(p, "coach");
      await p.waitFor("!!document.querySelector('.composer')", "the chat");
      await p.click(".topbar button", "History");
      await p.click(".chat-list .link");
    },
  },
  {
    id: "chat-billing-error",
    tab: "Coach",
    title: "Error: out of API credits",
    about:
      "When the Anthropic account has no credit left, the chat shows a plain card instead of the API's JSON: Add credits (the Console billing page), Try again, Claude settings, Dismiss. The raw reply and request id stay under Technical details. Captured with a stubbed reply: no request leaves the PC.",
    go: async (p) => {
      await p.click(".topbar button", "New");
      await p.evaluate<boolean>(
        `(() => { const t = document.querySelector('textarea[aria-label="Message"]'); const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set; set.call(t, "How did I sleep this week?"); t.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`,
      );
      await p.click('[aria-label="Send"]');
      await p.waitFor("!!document.querySelector('.card.chat-error')", "the chat error card");
      await p.click(".card.chat-error summary", "Technical details");
    },
  },
  {
    id: "chat-photo",
    tab: "Coach",
    title: "New chat, adding a photo or a file",
    about:
      "Quick prompts to start from. The paperclip offers Take a photo (the camera), Attach an image (the gallery, several at once) or Attach a file (a PDF or a CSV, TXT or JSON file). The microphone dictates into the message box where the phone has a speech recognizer.",
    go: async (p) => {
      await p.click(".topbar button", "New");
      await p.click('[aria-label="Add a photo or a file"]');
    },
  },
  {
    id: "mealprep-log",
    tab: "Food and drinks",
    title: "Log",
    about:
      "One day's log, today by default (‹ › to any past day, which can be logged to). What is left of the day: calories across the top, protein (still to go), carbs and fat, each with a bar toward its target, and the calories split by macro; daily targets for all four (macros can be filled from the kcal). One tap to eat a meal prep portion from the fridge or a meal eaten often, Log a meal (time optional, with a photo), and the day's entries by meal; an entry's edit can move it to another time or day.",
    go: (p) => section(p, "food"),
  },
  {
    id: "mealprep-history",
    tab: "Food and drinks",
    title: "History",
    about:
      "Seven days at a time: calories per day against the target (tap a bar to open that day in the log), the daily averages against every target, then each day with its kcal and macros and what was left or over.",
    go: (p) => sub(p, "History"),
  },
  {
    id: "mealprep-saved",
    tab: "Food and drinks",
    title: "Saved meals",
    about: "Favourite meals to log again in one tap, with servings.",
    go: (p) => sub(p, "Saved meals"),
  },
  {
    id: "mealprep-plan",
    tab: "Meal prep",
    title: "Plan",
    about:
      "The second group opens on the tupper plan: days covered and tuppers in stock, tuppers a day (1 or 2), the next defrost, then the next 14 days with the tupper eaten each day (from the fridge or thawed) and the night to take each out of the freezer, the days with nothing folded into one row, and what to cook next with a button that puts it on the shopping list. On a wide screen the days are a two-week calendar beside the shopping list.",
    go: (p) => section(p, "prep"),
  },
  {
    id: "mealprep-stock",
    tab: "Meal prep",
    title: "Stock",
    about:
      "Fridge, freezer and days covered as tiles, what needs doing (eat soon, defrosting), the next 14 days as a strip colored by batch (Plan › opens them day by day), then each batch with a bar of where its portions are and Eat / Freeze / Defrost for a chosen number. Eating writes the food log.",
    go: (p) => sub(p, "Stock"),
  },
  {
    id: "mealprep-recipes",
    tab: "Meal prep",
    title: "Recipes",
    about:
      "Recipes with what a portion holds, shelf life, tags and ingredients, and Edit, Cook (records a batch into Stock) and Duplicate. Set batches with the steppers and add every ingredient to the shopping list in one go; the result links on to the list or to Stock.",
    go: (p) => sub(p, "Recipes"),
  },
  {
    id: "mealprep-shopping",
    tab: "Meal prep",
    title: "Shopping",
    about:
      "The supermarket in the order it happens: the shopping list (add, tick off, share, Add from recipes), what was paid (supermarket, amount, day; saving clears the ticked items), then the month's spending against the month before, per supermarket, the last six months, and each shop with delete and undo.",
    go: (p) => sub(p, "Shopping"),
  },
  {
    id: "alcohol",
    tab: "Food and drinks",
    title: "Drinks",
    about:
      "Log a drink first: favourites with how often each was had in 7 days and a +1, and a one-off drink for anything else (a phone opens its form, a wide screen keeps it beside). Then the period's drinks, kcal, money and weight without alcohol, and the drinks logged, each with a pencil to change it and a bin. On a wide screen the favourites sit beside the list; on a phone Favourites › opens them.",
    go: async (p) => {
      await section(p, "food");
      await sub(p, "Drinks");
    },
  },
  {
    id: "alcohol-favourites",
    tab: "Food and drinks",
    title: "Drinks: Favourites",
    about: "The favourites on a phone: each with Edit, New favourite and the currency. Drinks already logged keep their own values.",
    go: (p) => p.click("button", "Manage ›"),
  },
  {
    id: "add",
    tab: "Today",
    title: "Add",
    about:
      "The ink green button in the middle of the tab bar: a sheet with the places to log food, a drink, a check-in or a weight, and Tell Coach while Coach is on. Escape, the scrim or a choice closes it.",
    go: async (p) => {
      await section(p, "today");
      await p.click(".tabbar-add");
    },
  },
  {
    id: "settings-menu",
    tab: "You",
    title: "You: Menu",
    about: "Every page in three groups, each row saying what is inside; the Profile row shows the profile picture. Tapping Settings again comes back here.",
    go: async (p) => {
      await p.click(".sheet-scrim");
      await section(p, "you");
    },
  },
  {
    id: "settings-profile",
    tab: "You",
    title: "Profile",
    about:
      "Google account, the profile picture (chosen from the phone), the owner's profile and the estimates it allows (BMI, BMR, daily energy, calorie and protein targets).",
    go: (p) => settings(p, "Profile"),
  },
  {
    id: "settings-connections",
    tab: "You",
    title: "Connections",
    about:
      "One card per connection, the Garmin sync built like the Claude one: how to get a key, then Connect (checked with Garmin before it is saved), or once connected the key, last sync and Disconnect; the 3-day reminder switch, Garmin history (import the export ZIP on the phone, what was imported per kind), and Claude: API key (the Chat tab) or Claude connector (Claude's own apps on the Claude plan; the Chat tab is hidden), here on the API key. How-tos fold away.",
    go: (p) => settings(p, "Connections"),
  },
  {
    id: "settings-privacy",
    tab: "You",
    title: "Privacy & data",
    about:
      "What Claude may see as four switches, what was sent (the last 5), what is stored on the phone (empty kinds in one line), and the encrypted backup with its age, then restore. Password fields have Show and Clear buttons.",
    go: (p) => settings(p, "Privacy and data"),
  },
  {
    id: "settings-about",
    tab: "You",
    title: "About",
    about: "The Even logo and name, app version, build, platform, database schema and chat model.",
    go: (p) => settings(p, "About"),
  },
  {
    id: "menu",
    tab: "Web app",
    web: true,
    title: "Side menu (phone)",
    about:
      "The five sections in a side menu. On a phone held upright it is out of sight: the menu button at the top of each tab slides it in over the page, and a choice, a tap outside or Escape closes it.",
    go: async (p) => {
      await section(p, "today");
      await p.click(".menu-button");
    },
  },
  {
    id: "wide-dashboard-day",
    tab: "Web app",
    web: true,
    title: "Today on a computer",
    about:
      "From 48rem wide the menu stays docked on the left, with its labels from 75rem; the button at its top narrows it to icons and back, and the choice is kept. The Dashboard sets the period controls in one row and its sections in two columns.",
    viewport: { width: 1440, height: 900, mobile: false },
    go: async (p) => {
      await section(p, "today");
      await p.click(".segmented button", "Day");
    },
  },
  {
    id: "wide-dashboard-week",
    tab: "Web app",
    web: true,
    title: "Week on a computer",
    about: "The week's charts sit in the first column under the rings, recovery and the rest beside them.",
    viewport: { width: 1440, height: 900, mobile: false },
    go: async (p) => {
      await p.click(".segmented button", "Week");
    },
  },
  {
    id: "wide-chat",
    tab: "Web app",
    web: true,
    title: "Coach on a computer",
    about: "The conversations on the left, the chat in the middle, and on the right today's numbers, what Claude may see and the last send.",
    viewport: { width: 1440, height: 900, mobile: false },
    go: async (p) => {
      await section(p, "coach");
    },
  },
  {
    id: "wide-mealprep-plan",
    tab: "Web app",
    web: true,
    title: "Tupper plan on a computer",
    about:
      "The four tiles in a row, the next 14 days as a two-week calendar (the days with nothing spread over their columns), Cook next beside the shopping list.",
    viewport: { width: 1440, height: 900, mobile: false },
    go: async (p) => {
      await section(p, "prep");
      await sub(p, "Plan");
    },
  },
  {
    id: "wide-mealprep-shopping",
    tab: "Web app",
    web: true,
    title: "Shopping on a computer",
    about: "The list, what was paid and the month's spending side by side, the six months and the shops under them.",
    viewport: { width: 1440, height: 900, mobile: false },
    go: async (p) => {
      await sub(p, "Shopping");
    },
  },
  {
    id: "wide-mealprep-saved",
    tab: "Web app",
    web: true,
    title: "Saved meals on a computer",
    about: "Saved meals two to a row and the meals eaten most this month, with the form for a new saved meal beside them.",
    viewport: { width: 1440, height: 900, mobile: false },
    go: async (p) => {
      await section(p, "food");
      await sub(p, "Saved meals");
    },
  },
  {
    id: "wide-alcohol",
    tab: "Web app",
    web: true,
    title: "Drinks on a computer",
    about: "Log a drink with the drinks per day of the last week beside the one-off form, four tiles, then the drinks with the favourites beside them.",
    viewport: { width: 1440, height: 900, mobile: false },
    go: async (p) => {
      await section(p, "food");
      await sub(p, "Drinks");
    },
  },
  {
    id: "wide-settings",
    tab: "Web app",
    web: true,
    title: "You on a computer",
    about: "The menu stays on the left with where each page stands; beside it every page at a glance until one is picked.",
    viewport: { width: 1440, height: 900, mobile: false },
    go: async (p) => {
      await section(p, "you");
    },
  },
  {
    id: "wide-settings-about",
    tab: "Web app",
    web: true,
    title: "About on a computer",
    about: "A page opens beside the menu, which marks it.",
    viewport: { width: 1440, height: 900, mobile: false },
    go: async (p) => {
      await p.click(".menu-row", "About");
    },
  },
  {
    id: "tablet-dashboard",
    tab: "Web app",
    web: true,
    title: "Today on a tablet",
    about:
      "Between 48rem and 75rem the docked menu shows icons only (the labels stay for screen readers and show on hover); from 60rem the Dashboard has two columns.",
    viewport: { width: 1024, height: 768, mobile: true },
    go: async (p) => {
      await section(p, "today");
      await p.click(".segmented button", "Day");
    },
  },
  {
    id: "landscape-dashboard",
    tab: "Web app",
    web: true,
    title: "Phone on its side",
    about: "A phone turned on its side is wide enough for the docked menu as icons; the Dashboard stays in one column.",
    viewport: { width: 844, height: 390, mobile: true },
    go: async (p) => {
      await section(p, "today");
    },
  },
];

const THEMES = ["light", "dark"] as const;

const ANTHROPIC_STUB = `(() => {
  const real = window.fetch.bind(window);
  window.fetch = (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.includes("api.anthropic.com")) return real(input, init);
    const body = { type: "error", error: { type: "invalid_request_error", message: "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits." }, request_id: "req_demo_screens_0000000000" };
    return Promise.resolve(new Response(JSON.stringify(body), { status: 400, headers: { "content-type": "application/json", "request-id": "req_demo_screens_0000000000" } }));
  };
})();`;

/** The screens of one target, both themes, from the Vite server at url. */
async function capture(url: string, screens: Screen[]) {
  const chrome = await launchChrome();
  try {
    await chrome.send("Runtime.enable");
    await chrome.send("Page.enable");
    // Claude is never contacted: before the app loads, any request to the Anthropic API gets the
    // "credit balance is too low" 400 a real account returned, so the chat error card can be captured.
    await chrome.send("Page.addScriptToEvaluateOnNewDocument", { source: ANTHROPIC_STUB });
    for (const theme of THEMES) {
      await chrome.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: theme }] });
      const p = page(chrome);
      await p.resize(PHONE);
      await chrome.send("Page.navigate", { url });
      await p.waitFor("!!document.querySelector('.tabbar, .sidenav') && document.body.innerText.includes('Steps')", "the app");
      await sleep(800);
      for (const s of screens) {
        await p.resize(s.viewport ?? PHONE);
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
    ["PageHeader", "src/ui/layout.tsx", "The sticky title row of every tab: back button or profile picture, title and subtitle, actions (sync, History, New)."],
    ["SectionHeader", "src/ui/layout.tsx", "Section headings with a link (Workouts › Your activity, Meal prep › Open)."],
    ["QuickActions", "src/ui/layout.tsx", "Log food, Log a drink, Ask Claude, Check-in on the Dashboard."],
    ["ScaleRating", "src/ui/controls.tsx", "Mood and energy, 1 to 5 in words, on the check-in."],
    ["Switch", "src/ui/controls.tsx", "On/off settings as rows: what Claude may see, the sync reminder."],
    ["MenuList", "src/ui/layout.tsx", "The Settings menu."],
    ["SubTabs", "src/ui/layout.tsx", "The views inside a Meal prep group."],
    ["Segmented", "src/ui/layout.tsx", "Day / Week / Month on the Dashboard; Food log / Meal prep."],
    ["Ring", "src/ui/charts/figures.tsx", "Calories eaten against the target and steps against the goal."],
    ["ChipGroup, RangePicker", "src/ui/controls.tsx", "Periods and filters: Alcohol periods, profile activity ranges, chart ranges."],
    ["Icon", "src/ui/icons.tsx", "Tab bar and side menu icons, the chat's attach, microphone and send buttons."],
    ["TabBar", "src/apps/android/TabBar.tsx", "Android: the five tabs at the bottom."],
    [
      "SideNav",
      "src/apps/web/SideNav.tsx",
      "Web app: the five sections in a side menu, a drawer on a phone held upright, docked on the left on a wider screen.",
    ],
    [
      "StatTile, Meter, BarChart, LineChart, CalendarHeatmap",
      "src/ui/charts/",
      "Numbers and charts: Dashboard tiles and charts, goals, food history, supermarket spending.",
    ],
    ["StatusBadge, Stepper", "src/ui/controls.tsx", "States as icon and words; portion counts."],
    ["CalorieMeter, MacroSplit", "src/ui/nutrition.tsx", "Calories against the target, macro shares (Log food)."],
    ["StockSummary, PlanDays, PlanStrip, StockAlerts, BatchBar", "src/ui/mealprep/", "Meal prep stock and the tupper plan."],
  ];
  return `${docHead("Even screens")}
<body data-show="light">
<main>
<h1>Even screens</h1>
<p class="muted">Every tab and view of the Android app at phone size (390 × 844 pt), then the web app's menu and a few wide screens, captured from the app with invented demo data by <code>npm run docs:screens</code>. Colors: <a href="palette.html">the palette</a>.</p>
<div class="themes" role="group" aria-label="Theme">
  <button type="button" data-show="light" aria-pressed="true">Light</button>
  <button type="button" data-show="dark" aria-pressed="false">Dark</button>
  <button type="button" data-show="both" aria-pressed="false">Side by side</button>
</div>
<nav class="toc">${tabs.map((t) => `<a href="#${slug(t)}">${esc(t)}</a>`).join("")}<a href="#components">Components</a></nav>
<p>Five sections: <strong>Dashboard</strong>, <strong>Chat</strong>, <strong>Meal prep</strong>, <strong>Alcohol</strong>, <strong>Settings</strong>. On Android they are tabs in a bar at the bottom; the web app has a side menu instead, opened from the menu button on a phone held upright and docked on the left on a wider screen (last section). Sync and the profile sit at the top of the Dashboard.</p>
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
    if (!a.startsWith("#") || !b.startsWith("#")) return "";
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
      text.has(role)
        ? `<div class="muted" style="font-size:0.8rem">${ratio(v, theme.bg)} on bg · ${ratio(v, theme.surface)} on surface</div>`
        : role === "on-accent"
          ? `<div class="muted" style="font-size:0.8rem">${ratio(v, theme.accent)} on accent</div>`
          : ""
    }</td>`;
  };
  const series = Array.from({ length: 8 }, (_, i) => `series-${i + 1}`);
  return `${docHead("Even palette")}
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

/**
 * Android first (every tab at phone size, with its tab bar), then the web app (its side menu, and
 * the wide screens). One Vite server at a time: each builds its own target (vite.config.ts).
 */
async function serve(mode: "android" | "web", screens: Screen[]) {
  const server = await createServer({ configFile: join(ROOT, "scripts/screens/vite.config.ts"), mode, logLevel: "warn", server: { port: 5190 } });
  await server.listen();
  const url = server.resolvedUrls?.local[0];
  try {
    if (!url) throw new Error("Vite did not start");
    console.log(`Capturing ${screens.length} ${mode} screens × ${THEMES.length} themes from ${url}`);
    await capture(url, screens);
  } finally {
    await server.close();
  }
}

rmSync(IMG, { recursive: true, force: true });
mkdirSync(IMG, { recursive: true });
await serve(
  "android",
  SCREENS.filter((s) => !s.web),
);
await serve(
  "web",
  SCREENS.filter((s) => s.web),
);
writeFileSync(join(OUT, "index.html"), indexHtml());
writeFileSync(join(OUT, "palette.html"), paletteHtml());
console.log(`Wrote docs/screens/index.html, docs/screens/palette.html and ${SCREENS.length * THEMES.length} captures.`);
