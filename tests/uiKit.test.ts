import test from "node:test";
import assert from "node:assert/strict";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BarChart, CalendarHeatmap, LineChart, StatTile } from "../src/ui/charts";
import { columnPath, compact, labelIndexes, linear, nearestIndex, niceTicks, present, segments } from "../src/ui/charts/scale";
import { batchColors, PlanDays, StockAlerts } from "../src/ui/mealprep/components";
import { daysCovered, timelineDays } from "../src/ui/mealprep/timeline";
import { MacroSplit } from "../src/ui/nutrition";
import { Logo } from "../src/ui/logo";

test("niceTicks: round steps that cover the data, flat and odd ranges included", () => {
  assert.deepEqual(niceTicks(0, 12_499), [0, 5000, 10000, 15000]);
  assert.deepEqual(niceTicks(47, 55), [46, 48, 50, 52, 54, 56]);
  assert.deepEqual(niceTicks(0.1, 0.3), [0.1, 0.15, 0.2, 0.25, 0.3], "no floating point noise");
  assert.deepEqual(niceTicks(50, 50), [30, 40, 50, 60, 70], "a flat series still gets an axis, centred on it");
  assert.deepEqual(niceTicks(0, 0), [-1, -0.5, 0, 0.5, 1]);
  const t = niceTicks(1.2, 2.9);
  assert.ok(t[0] <= 1.2 && t[t.length - 1] >= 2.9);
});

test("compact numbers for axes and tiles", () => {
  assert.deepEqual([0, 950, 1000, 1284, 12_900, 4_200_000, 2.5, -1500].map(compact), ["0", "950", "1K", "1.3K", "12.9K", "4.2M", "2.5", "-1.5K"]);
});

test("x labels never crowd: first and last always, the rest spaced", () => {
  assert.deepEqual(labelIndexes(7, 300, 28), [0, 1, 2, 3, 4, 5, 6]);
  const idx = labelIndexes(30, 300, 48);
  assert.equal(idx[0], 0);
  assert.equal(idx[idx.length - 1], 29);
  const px = 300 / 29;
  for (let i = 1; i < idx.length; i++) assert.ok((idx[i] - idx[i - 1]) * px >= 48, `gap before ${idx[i]}`);
  assert.deepEqual(labelIndexes(1, 300), [0]);
  assert.deepEqual(labelIndexes(0, 300), []);
});

test("lines break at missing values; hover snaps to the nearest x", () => {
  assert.deepEqual(segments([1, 2, null, null, 5, null, 7, 8]), [
    { start: 0, values: [1, 2] },
    { start: 4, values: [5] },
    { start: 6, values: [7, 8] },
  ]);
  assert.equal(nearestIndex(0, 40, 280, 30), 0);
  assert.equal(nearestIndex(320, 40, 280, 30), 29);
  assert.equal(nearestIndex(185, 40, 280, 30), 15);
  const y = linear([0, 100], [200, 0]);
  assert.equal(y(25), 150);
  assert.equal(linear([5, 5], [0, 10])(5), 5);
  assert.equal(columnPath(0, 20, 50, 50), "", "a zero-height column draws nothing");
  assert.match(columnPath(0, 20, 10, 100), /^M0 100 V14 Q0 10 4 10/, "square at the baseline, rounded top");
});

test("defrost timeline: one row per day, late defrosts and waste on the right day", () => {
  const plan = {
    thaw: [
      { day: "2026-10-25", forDay: "2026-10-26", name: "Chili", portions: 1, late: true },
      { day: "2026-10-28", forDay: "2026-10-29", name: "Curry", portions: 2, late: false },
    ],
    short: [{ day: "2026-10-31", missing: 1 }],
    coveredThrough: "2026-10-30",
    waste: [{ name: "Rice", portions: 1, eatBy: "2026-10-27" }],
  };
  const days = timelineDays(plan, "2026-10-26");
  assert.equal(days.length, 7);
  assert.deepEqual(
    days[0].takeOut.map((t) => t.name),
    ["Chili"],
    "late advice shows today",
  );
  assert.deepEqual(
    days[2].takeOut.map((t) => t.name),
    ["Curry"],
  );
  assert.deepEqual(days[1].expiring, [{ name: "Rice", portions: 1 }]);
  assert.deepEqual(
    days.map((d) => d.state),
    ["covered", "covered", "covered", "covered", "covered", "short", "covered"],
  );
  assert.equal(daysCovered(plan, "2026-10-26"), 5);
  assert.equal(daysCovered({ coveredThrough: null }, "2026-10-26"), 0);

  const html = renderToStaticMarkup(h(PlanDays, { plan, today: "2026-10-26", horizon: 7, colors: batchColors([]) }));
  assert.match(html, /Defrost now/);
  assert.match(html, /No tupper/);
});

const render = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(el);

test("charts: accessible name, table toggle, empty state, target in words", () => {
  const x = ["2026-10-20", "2026-10-21", "2026-10-22"];
  const line = render(h(LineChart, { title: "Resting HR", x, series: [{ id: "a", label: "Resting HR", values: [50, null, 52] }], unit: "bpm" }));
  assert.match(line, /role="img"/);
  assert.match(line, /aria-label="Resting HR\./);
  assert.match(line, />Table</, "every chart has its table view");
  assert.doesNotMatch(line, /viz-legend/, "one series: the title names it, no legend box");

  const multi = render(
    h(LineChart, {
      title: "Sleep",
      x,
      series: [
        { id: "a", label: "Deep", values: [1, 2, 3] },
        { id: "b", label: "REM", values: [2, 1, 2], slot: 4 },
      ],
    }),
  );
  assert.match(multi, /viz-legend/);
  assert.match(multi, /var\(--series-4\)/, "an explicit slot keeps its color");

  // Missing days break the line (two lone days, two dots), unless connectGaps joins them in one line.
  const gappy = { title: "Mood", x, series: [{ id: "a", label: "Mood", values: [3, null, 5] }] };
  assert.equal((render(h(LineChart, gappy)).match(/class="viz-line"/g) ?? []).length, 0);
  assert.equal((render(h(LineChart, { ...gappy, connectGaps: true })).match(/class="viz-line"/g) ?? []).length, 1);
  assert.deepEqual(present([null, 3, null, null, 5, Number.NaN]), [
    [1, 3],
    [4, 5],
  ]);

  const empty = render(h(LineChart, { title: "Nothing", x, series: [{ id: "a", label: "x", values: [null, null, null] }] }));
  assert.match(empty, /No data for this range/);
  assert.doesNotMatch(empty, />Table</);

  const bars = render(h(BarChart, { title: "Calories", x, values: [1800, null, 2600], target: 2200, selected: x[2], onSelect: () => {} }));
  assert.match(bars, /role="button"/);
  assert.match(bars, /aria-label="2026-10-22: 2,600, over target"/, "over target is said, not only colored");
  assert.match(bars, /aria-label="2026-10-21: nothing logged"/);
  assert.match(bars, /Over target/, "legend key for the warning color");

  const heat = render(h(CalendarHeatmap, { title: "Steps", values: { "2026-10-20": 4000, "2026-10-22": 12000 }, from: "2026-10-01", to: "2026-10-26" }));
  assert.match(heat, /viz-cell b4/);
  assert.match(heat, /viz-cell empty/, "missing days are empty, not zero");
});

test("figures: delta direction in arrows and words, macro shares as text", () => {
  const tile = render(h(StatTile, { label: "Resting HR", value: "49", unit: "bpm", delta: { value: -2, period: "vs last week", good: "down" } }));
  assert.match(tile, /viz-delta good/);
  assert.match(tile, /▼/);
  assert.match(tile, /−2/);
  const worse = render(h(StatTile, { label: "Steps", value: "3,000", delta: { value: -2000, period: "vs last week", good: "up" } }));
  assert.match(worse, /viz-delta bad/);
  assert.match(render(h(StatTile, { label: "Weight", value: null })), /–/);

  const macros = render(h(MacroSplit, { proteinG: 100, carbsG: 100, fatG: 0 }));
  assert.match(macros, /Protein 100 g/);
  assert.match(macros, /400 kcal · 50%/);
  assert.equal(render(h(MacroSplit, { proteinG: null, carbsG: null, fatG: null })), "");

  const alerts = render(h(StockAlerts, { alerts: [{ id: "1", kind: "expired", text: "Rice passed eat-by." }] }));
  assert.match(alerts, /status critical/);
  assert.match(alerts, /Past eat-by/);
});

test("logo: named Even, or hidden next to the name; colors from the palette only", () => {
  const named = renderToStaticMarkup(h(Logo, { size: 32 }));
  assert.match(named, /^<svg class="logo" width="32" height="32" viewBox="0 0 64 64" role="img" aria-label="Even"/);
  assert.match(renderToStaticMarkup(h(Logo, { decorative: true })), /aria-hidden="true"/);
  assert.doesNotMatch(renderToStaticMarkup(h(Logo, { decorative: true })), /role="img"/);
  for (const c of named.match(/(?:fill|stroke)="[^"]*"/g) ?? []) assert.match(c, /="(none|var\(--(brand|brand-ring|on-brand)\))"/, c);
});
