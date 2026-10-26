import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TabBar, TABS } from "../src/app/TabBar";
import { MEAL_PREP_VIEWS } from "../src/features/mealprep/ui/MealPrepScreen";
import { ChipGroup, RangePicker } from "../src/ui/controls";
import { Icon, ICON_NAMES } from "../src/ui/icons";
import { PageHeader, Segmented, SubTabs } from "../src/ui/layout";

const noop = () => {};

test("PageHeader: one h1, optional back button named for where it goes, leading and actions around the title", () => {
  const plain = renderToStaticMarkup(h(PageHeader, { title: "Alcohol" }));
  assert.equal((plain.match(/<h1/g) ?? []).length, 1);
  assert.match(plain, /<h1 class="grow">Alcohol<\/h1>/);
  assert.doesNotMatch(plain, /<button/);

  const back = renderToStaticMarkup(h(PageHeader, { title: "Profile", onBack: noop, backLabel: "Dashboard" }));
  assert.match(back, /aria-label="Back to Dashboard"/);
  assert.match(back, />‹ Dashboard<\/button>/);

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

test("meal prep tab: logging food comes first, then the meal prep views", () => {
  assert.deepEqual(
    MEAL_PREP_VIEWS.map((v) => v.id),
    ["log", "history", "saved", "stock", "recipes", "shopping"],
  );
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
