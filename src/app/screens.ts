import { lazy } from "react";

/**
 * Every screen but the Dashboard, loaded on first use: the app starts with a third of its code
 * (the Claude SDK alone was half the bundle), and preloadScreens() fetches the rest in the
 * background once the Dashboard is up, so a first tap does not wait either.
 */
const load = {
  chat: () => import("../features/chat/ui/ChatScreen"),
  mealPrep: () => import("../features/mealprep/ui/MealPrepScreen"),
  alcohol: () => import("../features/alcohol/ui/AlcoholScreen"),
  settings: () => import("../features/settings/SettingsScreen"),
  me: () => import("../features/me/MeScreen"),
  journal: () => import("../features/journal/ui/JournalScreen"),
  logs: () => import("../features/logs/LogsScreen"),
};

export const ChatScreen = lazy(() => load.chat().then((m) => ({ default: m.ChatScreen })));
export const MealPrepScreen = lazy(() => load.mealPrep().then((m) => ({ default: m.MealPrepScreen })));
export const AlcoholScreen = lazy(() => load.alcohol().then((m) => ({ default: m.AlcoholScreen })));
export const SettingsScreen = lazy(() => load.settings().then((m) => ({ default: m.SettingsScreen })));
export const MeScreen = lazy(() => load.me().then((m) => ({ default: m.MeScreen })));
export const JournalScreen = lazy(() => load.journal().then((m) => ({ default: m.JournalScreen })));
export const LogsScreen = lazy(() => load.logs().then((m) => ({ default: m.LogsScreen })));

/**
 * Fetch the other screens once the Dashboard shows its first numbers (mark even:dashboard-ready),
 * then when the phone is idle: parsing them earlier would compete with the Dashboard's own start.
 */
export function preloadScreens(): void {
  const run = () => Object.values(load).forEach((l) => void l());
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
