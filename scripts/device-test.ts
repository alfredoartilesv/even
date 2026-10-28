/**
 * Integration test on a real Android device or emulator: the installed debug build, driven through
 * the WebView's DevTools protocol (debug builds expose it), checked end to end.
 *
 *   npm run test:device                                   # the device adb sees, app already installed
 *   npm run test:device -- --install android/app/build/outputs/apk/debug/app-debug.apk --fresh
 *   npm run test:device -- --serial emulator-5554 --out shots/ --skip-sync
 *
 * Checks: the app opens, the encrypted database opens and is migrated to the latest schema, the file
 * on disk is not plain SQLite (SQLCipher), the Garmin key from GARMIN_API_KEY (.env) saves, a real
 * Garmin sync succeeds and stores readings, the dashboard shows them, and everything is still there
 * after the app is killed and reopened. --fresh clears the app's data first (a first launch).
 *
 * Prints check names, counts and PASS/FAIL only: never the key or health values. Screenshots of each
 * step go to --out (default: a temp folder), which is the only place health values can appear.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const APP = "app.health.personal";
const args = process.argv.slice(2);
const arg = (name: string) => {
  const i = args.indexOf(name);
  return i > -1 ? args[i + 1] : undefined;
};
const flag = (name: string) => args.includes(name);
const serial = arg("--serial");
const outDir = arg("--out") ?? join(tmpdir(), `health-device-test-${Date.now()}`);
const port = Number(arg("--port") ?? 9333);
mkdirSync(outDir, { recursive: true });

const adbArgs = (a: string[]) => (serial ? ["-s", serial, ...a] : a);
const adb = (...a: string[]) => execFileSync("adb", adbArgs(a), { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).replace(/\r/g, "");
const adbRaw = (...a: string[]) => execFileSync("adb", adbArgs(a), { stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until<T>(
  what: string,
  fn: () => Promise<T | null | undefined | false> | T | null | undefined | false,
  timeoutMs = 30_000,
  everyMs = 500,
): Promise<T> {
  const end = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < end) {
    try {
      const v = await fn();
      if (v) return v as T;
    } catch (e) {
      last = e;
    }
    await sleep(everyMs);
  }
  throw new Error(`timed out waiting for ${what}${last ? ` (${(last as Error).message})` : ""}`);
}

// ---- DevTools protocol over the forwarded WebView socket ----

class Page {
  private id = 0;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private constructor(private ws: WebSocket) {
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(String(ev.data)) as { id?: number; result?: unknown; error?: { message: string } };
      const p = msg.id !== undefined ? this.pending.get(msg.id) : undefined;
      if (!p) return;
      this.pending.delete(msg.id!);
      if (msg.error) p.reject(new Error(msg.error.message));
      else p.resolve(msg.result);
    });
  }

  static async connect(wsUrl: string): Promise<Page> {
    const ws = new WebSocket(wsUrl);
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => resolve(), { once: true });
      ws.addEventListener("error", () => reject(new Error("DevTools connection failed")), { once: true });
    });
    return new Page(ws);
  }

  send(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  /** Run an expression in the page and return its value (promises awaited). */
  async eval<T>(expression: string): Promise<T> {
    const r = (await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })) as {
      result: { value?: T };
      exceptionDetails?: { exception?: { description?: string }; text: string };
    };
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value as T;
  }

  close() {
    this.ws.close();
  }
}

/** Helpers installed in the page: find by visible text, click, fill a React input. */
const HELPERS = `
window.__t = {
  text: () => document.body.innerText,
  byText(sel, text) {
    return [...document.querySelectorAll(sel)].find((el) => el.offsetParent !== null && el.innerText.trim().includes(text)) ?? null;
  },
  click(sel, text) {
    const el = text === undefined ? document.querySelector(sel) : this.byText(sel, text);
    if (!el) return false;
    el.click();
    return true;
  },
  fill(sel, value) {
    const el = document.querySelector(sel);
    if (!el) return false;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  },
};
true`;

// ---- Checks ----

type Result = { name: string; ok: boolean; detail: string };
const results: Result[] = [];
let shot = 0;

function screenshot(name: string) {
  const file = join(outDir, `${String(++shot).padStart(2, "0")}-${name}.png`);
  writeFileSync(file, adbRaw("exec-out", "screencap", "-p"));
}

async function check(name: string, fn: () => Promise<string>) {
  try {
    const detail = await fn();
    results.push({ name, ok: true, detail });
    console.log(`PASS ${name}${detail ? `: ${detail}` : ""}`);
  } catch (e) {
    results.push({ name, ok: false, detail: (e as Error).message });
    console.log(`FAIL ${name}: ${(e as Error).message}`);
    try {
      screenshot(`fail-${name.replace(/\W+/g, "-").toLowerCase()}`);
    } catch {
      // the device may be gone
    }
  }
}

/** The activity in front, e.g. "app.health.personal/.MainActivity" or a Settings screen. */
function foreground(): string {
  const line =
    adb("shell", "dumpsys", "activity", "activities")
      .split("\n")
      .find((l) => /topResumedActivity|mResumedActivity/.test(l)) ?? "";
  return /\{[^ ]+ [^ ]+ ([^ }]+)/.exec(line)?.[1] ?? line.trim();
}

async function launch(): Promise<Page> {
  adb("shell", "am", "start", "-W", "-n", `${APP}/.MainActivity`);
  const pid = await until("the app process", () => adb("shell", "pidof", "-s", APP).trim() || null, 20_000);
  const socket = await until(
    "the WebView DevTools socket",
    () =>
      adb("shell", "cat", "/proc/net/unix")
        .split("\n")
        .map((l) => l.trim().split(/\s+/).pop() ?? "")
        .find((s) => s === `@webview_devtools_remote_${pid}`)
        ?.slice(1),
    20_000,
  );
  adb("forward", `tcp:${port}`, `localabstract:${socket}`);
  const target = await until("a page target", async () => {
    const list = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as { type: string; webSocketDebuggerUrl?: string }[];
    return list.find((t) => t.type === "page" && t.webSocketDebuggerUrl) ?? null;
  });
  const page = await Page.connect(target.webSocketDebuggerUrl!);
  await until("the page to load", () => page.eval<boolean>("document.readyState === 'complete'"));
  await page.eval(HELPERS);
  return page;
}

const latestSchema = Math.max(...readdirSync(join(import.meta.dirname, "../src/db/migrations")).map((f) => Number(/^(\d+)_/.exec(f)?.[1] ?? 0)));

async function openSettingsPage(page: Page, label: string) {
  // Tapping Settings while a page is open goes back to the menu.
  await page.eval(`__t.click("nav.sidenav button", "Settings")`);
  await sleep(300);
  if (!(await page.eval<boolean>(`!!__t.byText("button", ${JSON.stringify(label)})`))) await page.eval(`__t.click("nav.sidenav button", "Settings")`);
  await until(`the ${label} row`, () => page.eval<boolean>(`__t.click("button", ${JSON.stringify(label)})`), 10_000);
  await sleep(500);
}

/** The "Health readings" count on Privacy & data, as a number. */
async function storedReadings(page: Page): Promise<number> {
  await openSettingsPage(page, "Privacy & data");
  return until(
    "the stored data table",
    () =>
      page.eval<number | null>(`(() => {
        const row = [...document.querySelectorAll("table.values tr")].find((tr) => tr.innerText.includes("Health readings"));
        if (!row) return null;
        const n = Number(row.querySelector("td.num").innerText.replace(/[^0-9]/g, ""));
        return Number.isFinite(n) ? n + 1 : null; // +1 so 0 is truthy for until()
      })()`),
    15_000,
  ).then((n) => n - 1);
}

async function main() {
  const devices = execFileSync("adb", ["devices"], { encoding: "utf8" })
    .split("\n")
    .slice(1)
    .filter((l) => /\tdevice\b/.test(l));
  if (devices.length === 0) throw new Error("No device or emulator connected (adb devices is empty)");
  if (!serial && devices.length > 1) throw new Error("Several devices connected: pass --serial");
  const model = adb("shell", "getprop", "ro.product.model").trim();
  const release = adb("shell", "getprop", "ro.build.version.release").trim();
  console.log(`device: ${model} (Android ${release}), ${adb("shell", "wm", "size").trim().replace("Physical size: ", "")}; screenshots: ${outDir}`);

  const apk = arg("--install");
  if (apk && flag("--fresh")) {
    // Data goes anyway, so uninstall: an APK signed with another debug key (another PC, Docker) cannot update the installed one.
    try {
      adb("uninstall", APP);
    } catch {
      // not installed
    }
    adb("install", apk);
    console.log("installed the APK (clean install, first launch)");
  } else {
    if (apk) {
      adb("install", "-r", apk);
      console.log("installed the APK");
    }
    if (flag("--fresh")) {
      adb("shell", "pm", "clear", APP);
      console.log("cleared the app's data (first launch)");
    }
  }
  // The sync reminder asks for notifications (Android 13+); grant it so the system prompt does not cover the app.
  try {
    adb("shell", "pm", "grant", APP, "android.permission.POST_NOTIFICATIONS");
  } catch {
    // older Android: no runtime permission
  }
  adb("shell", "am", "force-stop", APP);

  let page = await launch();

  await check("app opens and the database is ready", async () => {
    await until("the side menu", () => page.eval<boolean>(`!!document.querySelector("nav.sidenav")`), 60_000);
    const text = await page.eval<string>("__t.text()");
    if (text.includes("Database unavailable")) throw new Error("the app says the database is unavailable");
    screenshot("dashboard-open");
    return "side menu shown";
  });

  await check("the header clears the status bar (edge to edge)", async () => {
    // Phones with WebView 140+ draw the page under the status bar and report its height; the emulator
    // image's older WebView pads natively instead. Report a 48 px bar the way Capacitor does and measure.
    const r = await page.eval<{ title: number; bar: number; strip: string; before: string }>(`(async () => {
      const root = document.documentElement;
      const before = root.style.getPropertyValue("--safe-area-inset-top");
      root.style.setProperty("--safe-area-inset-top", "48px");
      window.scrollTo(0, 0);
      await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));
      const title = document.querySelector(".topbar h1")?.getBoundingClientRect().top ?? -1;
      const bar = document.querySelector(".topbar")?.getBoundingClientRect().top ?? -1;
      const strip = getComputedStyle(document.body, "::before").height;
      root.style.setProperty("--safe-area-inset-top", before);
      return { title, bar, strip, before };
    })()`);
    if (r.title < 48) throw new Error(`the title starts at ${r.title}px, under a 48px status bar`);
    if (r.bar < 48) throw new Error(`the top bar starts at ${r.bar}px`);
    if (r.strip !== "48px") throw new Error(`the status bar strip is ${r.strip}`);
    return `title at ${Math.round(r.title)}px below a 48px bar`;
  });

  if (flag("--fresh")) {
    await check("without a key, the sync button says so and opens Connections", async () => {
      // The button shows the sync symbol only; what it means is its label.
      const label = await page.eval<string>(`document.querySelector("button.sync-button")?.getAttribute("aria-label") ?? ""`);
      if (!label.startsWith("Set up Garmin sync")) throw new Error(`the sync button is labelled "${label}"`);
      await page.eval(`__t.click("button.sync-button")`);
      await until("the Connections page", () => page.eval<boolean>(`__t.text().includes("Personal API key")`), 10_000);
      screenshot("setup-sync-connections");
      await page.eval(`__t.click("nav.sidenav button", "Dashboard")`);
      return `"${label.split(".")[0]}" opens Settings > Connections`;
    });
  }

  await check(`database migrated to schema v${latestSchema}`, async () => {
    await openSettingsPage(page, "About");
    const v = await until(
      "the schema row",
      () => page.eval<string | null>(`(() => { const m = /Database schema\\s*v(\\d+)/.exec(__t.text()); return m ? m[1] : null; })()`),
      15_000,
    );
    screenshot("about");
    if (Number(v) !== latestSchema) throw new Error(`schema is v${v}, the app ships v${latestSchema}`);
    return `v${v}`;
  });

  await check("database file is encrypted (not plain SQLite)", async () => {
    const files = adb("shell", "run-as", APP, "ls", "databases")
      .split("\n")
      .map((f) => f.trim())
      .filter((f) => f.endsWith(".db"));
    if (files.length === 0) throw new Error("no database file found");
    const head = adbRaw("exec-out", "run-as", APP, "head", "-c", "16", `databases/${files[0]}`).toString("latin1");
    if (head.startsWith("SQLite format 3")) throw new Error(`${files[0]} is a plain SQLite file`);
    return `${files[0]} has no SQLite header`;
  });

  const key = process.env.GARMIN_API_KEY?.trim();
  if (flag("--skip-sync") || !key) {
    console.log(`SKIP Garmin sync: ${key ? "--skip-sync" : "GARMIN_API_KEY is empty (run with --env-file=.env)"}`);
  } else {
    await check("Garmin key saves in Settings > Connections", async () => {
      await openSettingsPage(page, "Connections");
      await until("the key field", () => page.eval<boolean>(`__t.fill('input[type="password"]', ${JSON.stringify(key)})`), 10_000);
      await sleep(200);
      await page.eval(`__t.click("button[type=submit]", "Save")`);
      await until("the saved message", () => page.eval<boolean>(`__t.text().includes("Saved. Use the sync button")`), 10_000);
      screenshot("connections-saved");
      return "saved";
    });

    let before = 0;
    await check("a real Garmin sync succeeds", async () => {
      before = await storedReadings(page);
      await page.eval(`__t.click("nav.sidenav button", "Dashboard")`);
      await until("the sync button", () => page.eval<boolean>(`__t.click("button.sync-button")`), 10_000);
      const label = await until(
        "the sync to finish",
        () =>
          page.eval<string | null>(`(() => {
            const b = document.querySelector("button.sync-button");
            const l = b ? b.getAttribute("aria-label") : "";
            if (!l || l.startsWith("Syncing")) return null;
            if (__t.text().includes("The last sync failed")) return "FAILED: " + (document.querySelector(".banner .small")?.innerText ?? "");
            return l.startsWith("Synced") ? l.split(".")[0] : null;
          })()`),
        180_000,
        1000,
      );
      screenshot("dashboard-synced");
      if (label.startsWith("FAILED")) throw new Error(label);
      return label;
    });

    await check("the app stays in front after a sync (no system screen opened)", async () => {
      // Scheduling the sync reminder once opened Android's "Alarms & reminders" screen; DOM checks cannot see that.
      await sleep(3000);
      const top = foreground();
      if (!top.includes(APP)) {
        screenshot("not-in-front");
        throw new Error(`in front: ${top || "unknown"}`);
      }
      return "app in front";
    });

    await check("the sync stored Garmin readings", async () => {
      const after = await storedReadings(page);
      screenshot("privacy-inventory");
      if (after <= 0) throw new Error("no health readings stored");
      return `${after.toLocaleString("en")} readings (${(after - before).toLocaleString("en")} new)`;
    });

    await check("the dashboard shows synced steps", async () => {
      await page.eval(`__t.click("nav.sidenav button", "Dashboard")`);
      // Today may have no steps yet: step back a day until a day has them (up to a week).
      for (let i = 0; i < 7; i++) {
        await sleep(800);
        // The steps ring is a meter: its value is in aria-valuenow (absent when the day has no data).
        const steps = await page.eval<number | null>(
          `(() => { const m = document.querySelector('[role="meter"][aria-label^="Steps"]'); const v = m && m.getAttribute("aria-valuenow"); return v ? Number(v) : null; })()`,
        );
        if (steps !== null && steps > 0) {
          screenshot("dashboard-steps");
          return `steps ring has a value (${i === 0 ? "today" : `${i} day(s) back`})`;
        }
        if (!(await page.eval<boolean>(`__t.click("button[aria-label^='Previous']") || __t.click("button", "‹")`))) break;
      }
      throw new Error("no day in the last week shows steps");
    });
  }

  await check("data survives the app being killed and reopened", async () => {
    const before = await storedReadings(page);
    page.close();
    adb("shell", "am", "force-stop", APP);
    page = await launch();
    await until("the side menu", () => page.eval<boolean>(`!!document.querySelector("nav.sidenav")`), 60_000);
    const after = await storedReadings(page);
    if (after !== before) throw new Error(`${before} readings before, ${after} after`);
    return `${after.toLocaleString("en")} readings after a restart`;
  });

  page.close();
  adb("forward", "--remove", `tcp:${port}`);
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed; screenshots in ${outDir}`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error(`FAILED: ${(e as Error).message}`);
  process.exit(1);
});
