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

/** Fetch the other screens when the phone is idle. Safe to call more than once. */
export function preloadScreens(): void {
  const run = () => Object.values(load).forEach((l) => void l());
  if ("requestIdleCallback" in window) requestIdleCallback(run, { timeout: 2000 });
  else setTimeout(run, 500);
}
