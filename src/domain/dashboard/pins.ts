import type { SqlDriver } from "../../db/driver";
import { getSetting, setSetting } from "../../db/settings";

/**
 * The charts Today keeps for a week or a month (handoff 0.7, "pinned charts"): the owner pins the
 * ones they want, "Show all charts" shows the rest. A layout choice of this device, so it stays
 * in app_settings, which syncs only the profile.
 */
export const CHART_IDS = ["calories", "energy", "protein", "steps", "sleep", "heart"] as const;
export type ChartId = (typeof CHART_IDS)[number];

export const PINS_KEY = "today.pinned_charts";
export const DEFAULT_PINS: ChartId[] = ["calories", "steps"];

export async function loadPins(db: SqlDriver): Promise<ChartId[]> {
  const raw = await getSetting(db, PINS_KEY);
  if (raw === null) return DEFAULT_PINS;
  return raw.split(",").filter((id): id is ChartId => (CHART_IDS as readonly string[]).includes(id));
}

export async function savePins(db: SqlDriver, pins: ChartId[]): Promise<void> {
  await setSetting(db, PINS_KEY, CHART_IDS.filter((id) => pins.includes(id)).join(","));
}
