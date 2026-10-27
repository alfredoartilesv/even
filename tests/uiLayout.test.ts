import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TabBar, TABS } from "../src/app/TabBar";
import { greeting } from "../src/features/dashboard/greeting";
import { MEAL_PREP_GROUPS, MEAL_PREP_VIEWS } from "../src/features/mealprep/ui/MealPrepScreen";
import { SETTINGS_MENU } from "../src/features/settings/SettingsScreen";
import { Ring } from "../src/ui/charts";
import { ChipGroup, RangePicker, ScaleRating } from "../src/ui/controls";
import { Icon, ICON_NAMES } from "../src/ui/icons";
import { MenuList, PageHeader, QuickActions, SectionHeader, Segmented, SubTabs } from "../src/ui/layout";

const noop = () => {};

test("PageHeader: one h1, optional subtitle, optional back button named for where it goes, leading and actions around the title", () => {
  const plain = renderToStaticMarkup(h(PageHeader, { title: "Alcohol" }));
  assert.equal((plain.match(/<h1/g) ?? []).length, 1);
  assert.match(plain, /<h1>Alcohol<\/h1>/);
  assert.doesNotMatch(plain, /<button/);
  assert.match(renderToStaticMarkup(h(PageHeader, { title: "Hi", subtitle: "Monday 26 October" })), /<h1>Hi<\/h1><div class="muted small">Monday 26 October<\/div>/);

  const back = renderToStaticMarkup(h(PageHeader, { title: "Profile", onBack: noop, backLabel: "Dashboard" }));
  assert.match(back, /class="back-button" aria-label="Back to Dashboard"><svg[^]*?<span>Dashboard<\/span><\/button>/);

  const full = renderToStaticMarkup(h(PageHeader, { title: "Dashboard", leading: h("img", { alt: "me" }), actions: h("button", null, "Sync") }));
  assert.ok(full.indexOf("<img") < full.indexOf("<h1") && full.indexOf("<h1") < full.indexOf("Sync"), "leading, title, actions in that order");
});

test("SubTabs: a labelled nav, the open view marked aria-current", () => {
  const html = renderToStaticMarkup(h(SubTabs<"a" | "b">, { items: [{ id: "a", label: "Stock" }, { id: "b", label: "Recipes" }], value: "b", onChange: noop, label: "Views" }));
  assert.match(html, /^<nav class="tabs sub" aria-label="Views">/);
  assert.match(html, /<button type="button" class="">Stock<\/button>/);
  assert.match(html, /class="active" aria-current="page">Recipes/);
  assert.equal((html.match(/aria-current/g) ?? []).length, 1);
});

test("Segmented and ChipGroup: radio groups with exactly one checked option", () => {
  const seg = renderToStaticMarkup(h(Segmented<"day" | "week">, { items: [{ id: "day", label: "Day" }, { id: "week", label: "Week" }], value: "week", onChange: noop, label: "Period" }));
  assert.match(seg, /role="radiogroup" aria-label="Period"/);
  assert.equal((seg.match(/aria-checked="true"/g) ?? []).length, 1);
  assert.match(seg, /aria-checked="true" class="active">Week/);

  const chips = renderToStaticMarkup(h(ChipGroup<string>, { options: [{ id: "today", label: "Today" }, { id: "week", label: "7 days" }], value: "today", onChange: noop, label: "Period" }));
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

test("tab bar: the five tabs in order, each with an icon and a label, the open one aria-current", () => {
  assert.deepEqual(
    TABS.map((t) => t.label),
    ["Dashboard", "Chat", "Meal prep", "Alcohol", "Settings"],
  );
  const html = renderToStaticMarkup(h(TabBar, { tab: "alcohol", onTab: noop }));
  assert.equal((html.match(/<button/g) ?? []).length, 5);
  assert.equal((html.match(/<svg/g) ?? []).length, 5);
  assert.match(html, /class="active" aria-current="page"><svg[^]*?<span>Alcohol<\/span>/);
});

test("meal prep tab: two groups of three, the food log first", () => {
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
  assert.deepEqual(items.map((i) => i.id).sort(), ["about", "connections", "logs", "privacy", "profile"]);
  for (const i of items) assert.ok(i.description && ICON_NAMES.includes(i.icon), i.id);
  const html = renderToStaticMarkup(h(MenuList<string>, { groups: SETTINGS_MENU, onOpen: noop }));
  assert.equal((html.match(/class="menu-row"/g) ?? []).length, 5);
  assert.match(html, /<h2 class="menu-title">You<\/h2>/);
  assert.match(html, /<span class="menu-label">Debug logs<\/span><span class="menu-desc muted small">/);
});

test("SectionHeader and QuickActions: headings with an optional link, actions as labelled icon buttons", () => {
  assert.equal(renderToStaticMarkup(h(SectionHeader, { title: "Energy" })), '<div class="section-head"><h2>Energy</h2></div>');
  assert.match(renderToStaticMarkup(h(SectionHeader, { title: "Workouts", action: "Your activity", onAction: noop })), /<button type="button" class="link accent small">Your activity ›<\/button>/);
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

test("greeting: by the hour, with the first name when there is one", () => {
  assert.equal(greeting(8, "Alex Rivera"), "Good morning, Alex");
  assert.equal(greeting(14, null), "Good afternoon");
  assert.equal(greeting(20, "  "), "Good evening");
  assert.equal(greeting(2, "Sam"), "Good night, Sam");
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
const rel = (f: string) => f.slice(SRC.length + 1).split("\\").join("/");

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
