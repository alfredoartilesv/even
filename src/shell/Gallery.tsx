import { useState } from "react";
import { addDays } from "../core/tz";
import { BarChart, CalendarHeatmap, LineChart, Ring, StatTile } from "../ui/charts";
import { fmtDay, today } from "../ui/common";
import { ChipGroup, RangePicker, StatusBadge, Stepper } from "../ui/controls";
import { Icon, ICON_NAMES } from "../ui/icons";
import { MenuList, PageHeader, QuickActions, SectionHeader, Segmented, SubTabs } from "../ui/layout";
import { BatchBar, DefrostTimeline, StockAlerts, StockSummary } from "../ui/mealprep/components";
import { CalorieMeter, MacroSplit } from "../ui/nutrition";
import { SyncBanner } from "../screens/sync/SyncStatus";
import type { LastSync } from "../domain/sync/runSync";
import "../ui/palette.css";
import "../screens/styles.css";
import "../ui/ui.css";

/**
 * Every UI kit component with invented data, to look at them side by side in both themes.
 * Dev builds only: open the app with ?gallery (main.tsx).
 */

/** Deterministic noise, so the gallery looks the same on every load. */
function noise(seed: number) {
  let s = seed;
  return () => (s = (s * 16807) % 2147483647) / 2147483647;
}

const end = today();
const daysBack = (n: number) => Array.from({ length: n }, (_, i) => addDays(end, i - n + 1));
const r = noise(7);
const d30 = daysBack(30);
const rhr = d30.map((_, i) => (i === 11 || i === 12 ? null : Math.round(50 + Math.sin(i / 4) * 3 + r() * 3)));
const d14 = daysBack(14);
const deep = d14.map(() => +(1 + r() * 1.2).toFixed(1));
const rem = d14.map(() => +(1.2 + r() * 1).toFixed(1));
const light = d14.map((_, i) => (i === 5 ? null : +(3.5 + r() * 1.5).toFixed(1)));
const d7 = daysBack(7);
const steps = d7.map((_, i) => (i === 2 ? null : Math.round(4000 + r() * 12000)));
const year = Object.fromEntries(daysBack(365).flatMap((d) => (r() < 0.06 ? [] : [[d, Math.round(3000 + r() * 14000)]])));
const nowMs = Date.now();
const lastSync = (status: LastSync["status"], daysAgo: number, error: string | null = null): LastSync => {
  const at = nowMs - daysAgo * 86_400_000;
  return { status, startedMs: at, finishedMs: at, samplesWritten: null, warnings: [], error, lastOkMs: status === "ok" ? at : nowMs - 3_600_000 };
};
const banner = { configured: true, syncing: false, nowMs, onSync: () => {} };
const short = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString(undefined, { day: "numeric", month: "short", timeZone: "UTC" });
const letter = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString(undefined, { weekday: "narrow", timeZone: "UTC" });

const plan = {
  thaw: [
    { day: end, forDay: end, name: "Chili", portions: 1, late: true },
    { day: addDays(end, 2), forDay: addDays(end, 3), name: "Lentil curry", portions: 2, late: false },
  ],
  short: [{ day: addDays(end, 5), missing: 1 }],
  coveredThrough: addDays(end, 4),
  waste: [{ name: "Rice bowls", portions: 1, eatBy: addDays(end, 1) }],
};

export default function Gallery() {
  const [range, setRange] = useState(30);
  const [sel, setSel] = useState(end);
  const [perDay, setPerDay] = useState(2);
  const [view, setView] = useState("stock");
  const [span, setSpan] = useState("week");
  const [chip, setChip] = useState("week");
  return (
    <main className="shell">
      <h1>UI kit</h1>
      <p className="muted small">Invented data. Dev builds only.</p>

      <h2>Figures</h2>
      <div className="viz-tiles">
        <StatTile label="Resting HR" value="49" unit="bpm" delta={{ value: -2, period: "vs last week", good: "down" }} trend={rhr} />
        <StatTile
          label="Steps"
          value="7,492"
          delta={{ value: 1240, period: "vs last week", good: "up" }}
          formatDelta={(v) => v.toLocaleString()}
          trend={steps}
        />
        <StatTile label="Weight" value="86.5" unit="kg" delta={{ value: 0.4, period: "vs 30 days ago", good: "none" }} />
      </div>
      <div className="meter-card">
        <CalorieMeter eaten={1640} target={2200} fromDrinks={140} />
        <MacroSplit proteinG={112} carbsG={160} fatG={58} />
      </div>
      <div className="meter-card">
        <CalorieMeter eaten={2510} target={2200} />
      </div>

      <h2>Charts</h2>
      <RangePicker value={range} onChange={setRange} />
      <LineChart
        title="Resting heart rate"
        subtitle="Garmin, daily value"
        x={d30}
        series={[{ id: "rhr", label: "Resting HR", values: rhr }]}
        unit="bpm"
        formatX={short}
        formatXLong={(d) => fmtDay(d)}
      />
      <LineChart
        title="Sleep stages"
        subtitle="Hours per night"
        x={d14}
        series={[
          { id: "light", label: "Light", values: light },
          { id: "rem", label: "REM", values: rem },
          { id: "deep", label: "Deep", values: deep },
        ]}
        unit="h"
        zero
        formatX={short}
        formatXLong={(d) => fmtDay(d)}
      />
      <BarChart
        title="Steps"
        subtitle="Tap a day"
        x={d7}
        values={steps}
        target={10000}
        selected={sel}
        onSelect={setSel}
        formatX={letter}
        formatXLong={(d) => fmtDay(d)}
        formatValue={(v) => Math.round(v).toLocaleString()}
      />
      <CalendarHeatmap
        title="Steps, last year"
        values={year}
        from={addDays(end, -364)}
        to={end}
        formatDay={(d) => fmtDay(d)}
        formatValue={(v) => Math.round(v).toLocaleString()}
      />
      <LineChart title="Empty range" x={d7} series={[{ id: "x", label: "Nothing", values: d7.map(() => null) }]} />

      <h2>Meal prep</h2>
      <StockSummary plan={plan} fridgeNow={3} freezerNow={8} perDay={perDay} today={end} />
      <label className="inline">
        Portions a day <Stepper value={perDay} onChange={setPerDay} min={0} max={6} label="Portions a day" />
      </label>
      <StockAlerts
        alerts={[
          { id: "1", kind: "expired", text: "1 portion of Rice bowls passed eat-by yesterday. Check it or throw it out." },
          { id: "2", kind: "eat_soon", text: "Eat 2 portions of Chili by tomorrow." },
          { id: "3", kind: "thawing", text: "1 portion of Lentil curry defrosting, ready Tue 18:00." },
        ]}
      />
      <DefrostTimeline plan={plan} today={end} />
      <div className="card">
        <h3>Chili, cooked Sunday</h3>
        <BatchBar cooked={8} eaten={3} fridge={2} freezer={2} discarded={1} />
      </div>

      <h2>Status</h2>
      <div className="row" style={{ justifyContent: "flex-start" }}>
        <StatusBadge status="good">covered</StatusBadge>
        <StatusBadge status="info">defrosting</StatusBadge>
        <StatusBadge status="warning">eat soon</StatusBadge>
        <StatusBadge status="critical">past eat-by</StatusBadge>
      </div>
      <SyncBanner status={lastSync("error", 1, "Could not reach Garmin (the sync server could not pass it on, HTTP 500)")} {...banner} />
      <SyncBanner status={lastSync("ok", 5)} {...banner} />
      <SyncBanner status={lastSync("error", 1, "Garmin refused the key")} {...banner} syncing />

      <h2>Layout</h2>
      <PageHeader title="Page title" onBack={() => {}} backLabel="Dashboard" actions={<button className="secondary small-button">Action</button>} />
      <SubTabs
        items={[
          { id: "log", label: "Log food" },
          { id: "stock", label: "Stock" },
          { id: "recipes", label: "Recipes" },
          { id: "shopping", label: "Shopping" },
        ]}
        value={view}
        onChange={setView}
        label="Views"
      />
      <Segmented
        items={[
          { id: "day", label: "Day" },
          { id: "week", label: "Week" },
          { id: "month", label: "Month" },
        ]}
        value={span}
        onChange={setSpan}
        label="Period"
      />
      <ChipGroup
        options={[
          { id: "today", label: "Today" },
          { id: "week", label: "7 days" },
          { id: "month", label: "30 days" },
        ]}
        value={chip}
        onChange={setChip}
        label="Period"
      />

      <SectionHeader title="Section header" action="Open" onAction={() => {}} />
      <QuickActions
        actions={[
          { id: "food", label: "Log food", icon: "food", onClick: () => {} },
          { id: "drink", label: "Log a drink", icon: "alcohol", onClick: () => {} },
          { id: "chat", label: "Ask Claude", icon: "sparkle", onClick: () => {} },
          { id: "prep", label: "Meal prep", icon: "box", onClick: () => {} },
        ]}
      />
      <div className="card rings">
        <Ring label="Eaten" value={2420} target={2300} kind="limit" unit="kcal" format={(v) => Math.round(v).toLocaleString()} />
        <Ring label="Steps" value={7480} target={10000} format={(v) => Math.round(v).toLocaleString()} />
      </div>
      <MenuList
        groups={[
          {
            title: "Group",
            items: [
              { id: "a", label: "A page", description: "What is inside it", icon: "user" },
              { id: "b", label: "Another", description: "And this one", icon: "info" },
            ],
          },
        ]}
        onOpen={() => {}}
      />

      <h2>Icons</h2>
      <div className="row" style={{ justifyContent: "flex-start" }}>
        {ICON_NAMES.map((n) => (
          <span key={n} className="muted small" style={{ display: "inline-flex", flexDirection: "column", alignItems: "center", gap: 4 }}>
            <Icon name={n} />
            {n}
          </span>
        ))}
      </div>
    </main>
  );
}
