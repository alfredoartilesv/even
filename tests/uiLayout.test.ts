import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TabBar } from "../src/apps/android/TabBar";
import { SideNav, type SideNavState } from "../src/apps/web/SideNav";
import { TABS } from "../src/shell/tabs";
import { connectGate } from "../src/apps/web/connectGate";
import type { SyncSession } from "../src/domain/cloudsync/session";
import { greeting } from "../src/domain/dashboard/greeting";
import { MEAL_PREP_GROUPS, MEAL_PREP_VIEWS } from "../src/screens/mealprep/MealPrepScreen";
import { SETTINGS_MENU } from "../src/screens/settings/SettingsScreen";
import { Ring } from "../src/ui/charts";
import { ChipGroup, RangePicker, ScaleRating, Switch } from "../src/ui/controls";
import { Icon, ICON_NAMES } from "../src/ui/icons";
import { MenuList, NavMenu, PageHeader, QuickActions, SectionHeader, Segmented, SubTabs } from "../src/ui/layout";

const noop = () => {};

test("PageHeader: one h1, optional subtitle, optional back button named for where it goes, leading and actions around the title", () => {
  const plain = renderToStaticMarkup(h(PageHeader, { title: "Alcohol" }));
  assert.equal((plain.match(/<h1/g) ?? []).length, 1);
  assert.match(plain, /<h1>Alcohol<\/h1>/);
  assert.doesNotMatch(plain, /<button/);
  assert.match(
    renderToStaticMarkup(h(PageHeader, { title: "Hi", subtitle: "Monday 26 October" })),
    /<h1>Hi<\/h1><div class="muted small">Monday 26 October<\/div>/,
  );

  const back = renderToStaticMarkup(h(PageHeader, { title: "Profile", onBack: noop, backLabel: "Dashboard" }));
  assert.match(back, /class="back-button" aria-label="Back to Dashboard"><svg[^]*?<span>Dashboard<\/span><\/button>/);

  const full = renderToStaticMarkup(h(PageHeader, { title: "Dashboard", leading: h("img", { alt: "me" }), actions: h("button", null, "Sync") }));
  assert.ok(full.indexOf("<img") < full.indexOf("<h1") && full.indexOf("<h1") < full.indexOf("Sync"), "leading, title, actions in that order");
});

test("SubTabs: a labelled nav, the open view marked aria-current", () => {
  const html = renderToStaticMarkup(
    h(SubTabs<"a" | "b">, {
      items: [
        { id: "a", label: "Stock" },
        { id: "b", label: "Recipes" },
      ],
      value: "b",
      onChange: noop,
      label: "Views",
    }),
  );
  assert.match(html, /^<nav class="tabs sub" aria-label="Views">/);
  assert.match(html, /<button type="button" class="">Stock<\/button>/);
  assert.match(html, /class="active" aria-current="page">Recipes/);
  assert.equal((html.match(/aria-current/g) ?? []).length, 1);
});

test("Segmented and ChipGroup: radio groups with exactly one checked option", () => {
  const seg = renderToStaticMarkup(
    h(Segmented<"day" | "week">, {
      items: [
        { id: "day", label: "Day" },
        { id: "week", label: "Week" },
      ],
      value: "week",
      onChange: noop,
      label: "Period",
    }),
  );
  assert.match(seg, /role="radiogroup" aria-label="Period"/);
  assert.equal((seg.match(/aria-checked="true"/g) ?? []).length, 1);
  assert.match(seg, /aria-checked="true" class="active">Week/);

  const chips = renderToStaticMarkup(
    h(ChipGroup<string>, {
      options: [
        { id: "today", label: "Today" },
        { id: "week", label: "7 days" },
      ],
      value: "today",
      onChange: noop,
      label: "Period",
    }),
  );
  assert.match(chips, /class="chip active">Today/);
  assert.match(chips, /aria-checked="false" class="chip">7 days/);

  // RangePicker is a ChipGroup keyed by days.
  const range = renderToStaticMarkup(h(RangePicker, { value: 30, onChange: noop }));
  assert.match(range, /aria-checked="true" class="chip active">30 days/);
});

test("icons: every one is a hidden 24 px line drawing in the current color", () => {
  assert.ok(ICON_NAMES.length >= 8);
  for (const name of ICON_NAMES) {
    const svg = renderToStaticMarkup(h(Icon, { name }));
    assert.match(svg, /^<svg class="icon" width="24" height="24" viewBox="0 0 24 24"/, name);
    assert.match(svg, /stroke="currentColor"/, name);
    assert.match(svg, /aria-hidden="true"/, name);
    assert.match(svg, /<(path|rect|circle)/, name);
  }
  assert.match(renderToStaticMarkup(h(Icon, { name: "camera", size: 22 })), /width="22" height="22"/);
});

const navState = (over: Partial<SideNavState>): SideNavState => ({ docked: false, open: false, rail: false, setOpen: noop, toggleRail: noop, ...over });

test("Android tab bar: the five tabs in order, each with an icon and a label, the open one aria-current", () => {
  assert.deepEqual(
    TABS.map((t) => t.label),
    ["Dashboard", "Chat", "Meal prep", "Alcohol", "Settings"],
  );
  const html = renderToStaticMarkup(h(TabBar, { tab: "alcohol", onTab: noop }));
  assert.equal((html.match(/<button/g) ?? []).length, 5);
  assert.equal((html.match(/<svg/g) ?? []).length, 5);
  assert.match(html, /class="active" aria-current="page"><svg[^]*?<span>Alcohol<\/span>/);
});

test("web side menu: the same five sections, each with an icon and a label, the open one aria-current", () => {
  const html = renderToStaticMarkup(h(SideNav, { tab: "alcohol", onTab: noop, nav: navState({ open: true }), account: null }));
  assert.equal((html.match(/class="sidenav-item/g) ?? []).length, 5);
  assert.match(html, /class="sidenav-item active" aria-current="page"><svg[^]*?<span class="sidenav-label">Alcohol<\/span>/);
  assert.match(html, /aria-label="Close menu"/);
  assert.match(html, /class="nav-scrim"/);
});

test("web side menu: a closed drawer is inert and has no scrim; docked it never is, and as icons it offers to expand", () => {
  const closed = renderToStaticMarkup(h(SideNav, { tab: "chat", onTab: noop, nav: navState({}), account: null }));
  assert.match(closed, /<nav[^>]*inert=""/);
  assert.doesNotMatch(closed, /nav-scrim/);
  const docked = renderToStaticMarkup(h(SideNav, { tab: "chat", onTab: noop, nav: navState({ docked: true }), account: null }));
  assert.doesNotMatch(docked, /inert/);
  assert.match(docked, /aria-label="Collapse menu" aria-expanded="true"/);
  const rail = renderToStaticMarkup(h(SideNav, { tab: "chat", onTab: noop, nav: navState({ docked: true, rail: true }), account: null }));
  assert.match(rail, /class="sidenav rail"/);
  assert.match(rail, /aria-label="Expand menu" aria-expanded="false"/);
  // Icons only: the label stays in the button for screen readers, the title shows it on hover.
  assert.match(rail, /title="Settings"[^>]*>[^]*?<span class="sidenav-label">Settings<\/span>/);
});

test("web side menu: a connected account shows at the foot with Sign out, named on hover when the menu is icons only; none without one", () => {
  const account = { email: "alex@example.com", signOut: async () => {} };
  const html = renderToStaticMarkup(h(SideNav, { tab: "chat", onTab: noop, nav: navState({ docked: true }), account }));
  assert.match(html, /class="sidenav-foot"[^]*alex@example\.com[^]*<span class="sidenav-label">Sign out<\/span>/);
  const rail = renderToStaticMarkup(h(SideNav, { tab: "chat", onTab: noop, nav: navState({ docked: true, rail: true }), account }));
  assert.match(rail, /title="alex@example\.com"/);
  assert.match(rail, /title="Sign out"/);
  assert.doesNotMatch(renderToStaticMarkup(h(SideNav, { tab: "chat", onTab: noop, nav: navState({}), account: null })), /sidenav-foot/);
});

test("PageHeader: a frame's menu button opens the side menu at the top of a tab, not on a page with a way back; without one there is none", () => {
  const menu = (props: Parameters<typeof PageHeader>[0], open = false) =>
    renderToStaticMarkup(h(NavMenu, { value: { open, onOpen: noop } }, h(PageHeader, props)));
  assert.match(
    menu({ title: "Chat" }),
    /^<header class="topbar"><button type="button" class="menu-button" aria-label="Menu" aria-controls="sidenav" aria-expanded="false">/,
  );
  assert.match(menu({ title: "Chat" }, true), /aria-expanded="true"/);
  assert.doesNotMatch(menu({ title: "Profile", onBack: noop }), /menu-button/);
  assert.doesNotMatch(renderToStaticMarkup(h(PageHeader, { title: "Chat" })), /menu-button/);
});

test("meal prep tab: two groups of three, the food log first; shopping holds the list and the spending", () => {
  assert.deepEqual(
    MEAL_PREP_GROUPS.map((g) => [g.label, g.views.map((v) => v.id)]),
    [
      ["Food log", ["log", "history", "saved"]],
      ["Meal prep", ["stock", "recipes", "shopping"]],
    ],
  );
  assert.deepEqual(
    MEAL_PREP_VIEWS.map((v) => v.id),
    ["log", "history", "saved", "stock", "recipes", "shopping"],
  );
});

test("settings menu: every page once, each with an icon and a description", () => {
  const items = SETTINGS_MENU.flatMap((g) => g.items);
  assert.deepEqual(items.map((i) => i.id).sort(), ["about", "connections", "friends", "logs", "privacy", "profile", "sync"]);
  for (const i of items) assert.ok(i.description && ICON_NAMES.includes(i.icon), i.id);
  const html = renderToStaticMarkup(h(MenuList<string>, { groups: SETTINGS_MENU, onOpen: noop }));
  assert.equal((html.match(/class="menu-row"/g) ?? []).length, 7);
  assert.match(html, /<h2 class="menu-title">You<\/h2>/);
  assert.match(html, /<span class="menu-label">Debug logs<\/span><span class="menu-desc muted small">/);
});

test("SectionHeader and QuickActions: headings with an optional link, actions as labelled icon buttons", () => {
  assert.equal(renderToStaticMarkup(h(SectionHeader, { title: "Energy" })), '<div class="section-head"><h2>Energy</h2></div>');
  assert.match(
    renderToStaticMarkup(h(SectionHeader, { title: "Workouts", action: "Your activity", onAction: noop })),
    /<button type="button" class="link accent small">Your activity ›<\/button>/,
  );
  const qa = renderToStaticMarkup(
    h(QuickActions, {
      actions: [
        { id: "a", label: "Log food", icon: "food", onClick: noop },
        { id: "b", label: "Ask Claude", icon: "sparkle", onClick: noop },
      ],
    }),
  );
  assert.match(qa, /role="group" aria-label="Quick actions"/);
  assert.equal((qa.match(/<svg/g) ?? []).length, 2);
  assert.match(qa, /<span>Ask Claude<\/span>/);
});

test("Ring: progress against a goal or a limit, in words as well as the arc", () => {
  const steps = renderToStaticMarkup(h(Ring, { label: "Steps", value: 7500, target: 10000 }));
  assert.match(steps, /role="meter" aria-label="Steps"/);
  assert.match(steps, /aria-valuetext="7,500 of 10,000, 2,500 to go"/);
  assert.match(steps, /class="ring-fill"/);
  assert.match(renderToStaticMarkup(h(Ring, { label: "Steps", value: 12000, target: 10000 })), /goal met/);

  const eaten = renderToStaticMarkup(h(Ring, { label: "Eaten", value: 2400, target: 2300, kind: "limit", unit: "kcal" }));
  assert.match(eaten, /class="ring-fill over"/);
  assert.match(eaten, /100 over/);
  assert.match(renderToStaticMarkup(h(Ring, { label: "Eaten", value: 1800, target: 2300, kind: "limit" })), /500 left/);

  const none = renderToStaticMarkup(h(Ring, { label: "Steps", value: null, target: 10000 }));
  assert.match(none, /no data/);
  assert.doesNotMatch(none, /ring-fill/, "no arc without a value");
  assert.doesNotMatch(renderToStaticMarkup(h(Ring, { label: "Steps", value: 5000, target: null })), /ring-fill/, "no arc without a target");
});

test("greeting: Hi with the first name when there is one", () => {
  assert.equal(greeting("Alex Rivera"), "Hi, Alex");
  assert.equal(greeting("Sam"), "Hi, Sam");
  assert.equal(greeting(null), "Hi");
  assert.equal(greeting("  "), "Hi");
});

// Consistency rules: screens use the shared frame, not their own copies of it.
const SRC = resolve(import.meta.dirname, "../src");
function walk(dir: string, out: string[] = []): string[] {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (f.endsWith(".tsx")) out.push(p);
  }
  return out;
}
const screens = walk(SRC).filter((f) => !f.endsWith("Gallery.tsx") && !f.includes(join("src", "ui")));
const rel = (f: string) =>
  f
    .slice(SRC.length + 1)
    .split("\\")
    .join("/");

test("screens title themselves with PageHeader, never their own <h1>", () => {
  assert.deepEqual(screens.filter((f) => /<h1[\s>]/.test(readFileSync(f, "utf8"))).map(rel), []);
});

test("screens switch views with SubTabs and Segmented, not hand-made tab rows", () => {
  assert.deepEqual(screens.filter((f) => /className="(tabs sub|segmented)"/.test(readFileSync(f, "utf8"))).map(rel), []);
});

test("screens draw icons with <Icon>, not inline SVG", () => {
  assert.deepEqual(screens.filter((f) => /<svg[\s>]/.test(readFileSync(f, "utf8"))).map(rel), []);
});

test("ScaleRating: five named steps, the chosen word shown, steps up to the choice lit", () => {
  const words = ["Very low", "Low", "OK", "Good", "Very good"];
  const html = renderToStaticMarkup(h(ScaleRating, { label: "Mood", value: 4, onChange: noop, words }));
  assert.match(html, /role="radiogroup" aria-label="Mood"/);
  assert.match(html, /<span class="muted small">Good<\/span>/);
  assert.equal((html.match(/aria-checked="true"/g) ?? []).length, 1);
  assert.match(html, /aria-checked="true" aria-label="4: Good" class="on"/);
  assert.equal((html.match(/class="on"/g) ?? []).length, 4);
  assert.match(renderToStaticMarkup(h(ScaleRating, { label: "Energy", value: null, onChange: noop, words })), /not set/);
});

test("Switch: a labelled checkbox with role switch, the whole row the tap target", () => {
  const on = renderToStaticMarkup(
    h(Switch, { checked: true, onChange: noop, label: "Photos", description: "Send the photos you attach", note: "needed for any chat" }),
  );
  assert.match(on, /^<label class="switch-row">/);
  assert.match(on, /<span class="switch-label">Photos<span class="muted small"> needed for any chat<\/span><\/span>/);
  assert.match(on, /Send the photos you attach/);
  assert.match(on, /<input type="checkbox" role="switch" class="switch" checked=""/);
  assert.doesNotMatch(renderToStaticMarkup(h(Switch, { checked: false, onChange: noop, label: "Photos" })), /checked=""/);
});

test("menu rows show a picture in place of the icon when given one", () => {
  const items = [{ id: "profile", label: "Profile", icon: "user" as const, picture: h("img", { alt: "me" }) }];
  const html = renderToStaticMarkup(h(MenuList, { groups: [{ items }], onOpen: noop }));
  assert.match(html, /<img alt="me"\/>/);
  assert.doesNotMatch(html, /menu-icon/);
});

test("profile pictures come from the phone's picker: no input forces the camera", () => {
  for (const f of ["src/screens/me/MeScreen.tsx", "src/screens/me/avatar.tsx"]) {
    const src = readFileSync(resolve(import.meta.dirname, "..", f), "utf8");
    assert.match(src, /type="file" accept="image\/\*"/, f);
    assert.doesNotMatch(src, /capture=/, `${f}: with capture Android opens only the camera`);
  }
});

test("web app: waits for the sync session, asks to connect without one, and lets the app through with one", () => {
  const opening = renderToStaticMarkup(h(() => connectGate({ session: undefined, connect: noop })));
  assert.match(opening, /Opening…/);
  const connect = renderToStaticMarkup(h(() => connectGate({ session: null, connect: noop })));
  assert.match(connect, /<h2>Connect<\/h2>/);
  assert.match(connect, /opened only here, in this browser/);
  assert.match(connect, /Loading…/, "the lazy panel has a fallback, so the card is never empty");
  assert.equal(connectGate({ session: {} as SyncSession, connect: noop }), null);
});

test("each target brings its navigation: Android the tab bar without a gate, the web app the side menu behind its gate", () => {
  const entry = (t: string) => readFileSync(resolve(import.meta.dirname, "../src/apps", t, "main.tsx"), "utf8");
  assert.match(entry("web"), /startApp\(\{ gate: \(state\) => connectGate\(state, notice\), Frame: SideNavFrame \}\)/);
  assert.match(entry("android"), /startApp\(\{ Frame: TabBarFrame \}\);/);
  // The other target's navigation (and its styles) never reach a build.
  assert.doesNotMatch(entry("android"), /SideNav|web\.css/);
  assert.doesNotMatch(entry("web"), /TabBar|android\.css/);
});
