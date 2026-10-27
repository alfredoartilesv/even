import { lazy, type ComponentType } from "react";

/**
 * Every screen but the Dashboard, loaded on first use: the app starts with a third of its code
 * (the Claude SDK alone was half the bundle). preloadScreens() fetches the rest once the
 * Dashboard is up. A screen whose code is already here renders straight away: React.lazy would
 * suspend on its first render anyway, and React keeps a suspended screen's fallback up for at
 * least 300 ms, which made every first tap that much slower.
 */
function screen<P extends object>(loader: () => Promise<ComponentType<P>>) {
  let loaded: ComponentType<P> | null = null;
  const load = () => loader().then((c) => (loaded = c));
  const Lazy = lazy(() => load().then((c) => ({ default: c })));
  function Screen(props: P) {
    const Component = loaded ?? Lazy;
    return <Component {...props} />;
  }
  return Object.assign(Screen, { load });
}

export const ChatScreen = screen(() => import("../features/chat/ui/ChatScreen").then((m) => m.ChatScreen));
export const MealPrepScreen = screen(() => import("../features/mealprep/ui/MealPrepScreen").then((m) => m.MealPrepScreen));
export const AlcoholScreen = screen(() => import("../features/alcohol/ui/AlcoholScreen").then((m) => m.AlcoholScreen));
export const SettingsScreen = screen(() => import("../features/settings/SettingsScreen").then((m) => m.SettingsScreen));
export const MeScreen = screen(() => import("../features/me/MeScreen").then((m) => m.MeScreen));
export const JournalScreen = screen(() => import("../features/journal/ui/JournalScreen").then((m) => m.JournalScreen));
export const LogsScreen = screen(() => import("../features/logs/LogsScreen").then((m) => m.LogsScreen));

const ALL = [ChatScreen, MealPrepScreen, AlcoholScreen, SettingsScreen, MeScreen, JournalScreen, LogsScreen];

/**
 * Fetch the other screens once the Dashboard shows its first numbers (mark even:dashboard-ready),
 * then when the phone is idle: parsing them earlier would compete with the Dashboard's own start.
 */
export function preloadScreens(): void {
  const run = () => ALL.forEach((s) => void s.load());
  const idle = () => ("requestIdleCallback" in window ? requestIdleCallback(run, { timeout: 2000 }) : setTimeout(run, 500));
  if (performance.getEntriesByName("even:dashboard-ready").length) return void idle();
  const seen = new PerformanceObserver((list) => {
    if (!list.getEntries().some((e) => e.name === "even:dashboard-ready")) return;
    seen.disconnect();
    idle();
  });
  seen.observe({ type: "mark" });
  // Started on another tab (the Dashboard never shown): still fetch them, a little later.
  setTimeout(() => {
    seen.disconnect();
    idle();
  }, 5000);
}
