import type { SqlDriver } from "../../db/driver";
import { getSetting, setSetting } from "../../db/settings";

/**
 * The charts Today keeps for a week or a month (handoff 0.7, "pinned charts"): the owner pins the
 * ones they want, "All" shows the rest. A layout choice of this device, so it stays
 * in app_settings, which syncs only the profile. Kept in the order they were pinned, which is the
 * order Today shows them in (the owner's ask, 9 Nov 2026).
 */
/** "intraday" is a day's eaten against burned, hour by hour: offered on a day only. */
export const CHART_IDS = ["calories", "energy", "protein", "steps", "sleep", "heart", "intraday"] as const;
export type ChartId = (typeof CHART_IDS)[number];

export const PINS_KEY = "today.pinned_charts";
export const DEFAULT_PINS: ChartId[] = ["calories", "steps", "intraday"];
/**
 * Eaten vs burned joined the charts on 15 Nov 2026; before, it always showed on a day. A list saved
 * before then gets it pinned once, last, so it does not vanish; after that, the owner's list rules.
 */
const INTRADAY_KEY = "today.pinned_charts.intraday";

export async function loadPins(db: SqlDriver): Promise<ChartId[]> {
  const raw = await getSetting(db, PINS_KEY);
  if (raw === null) return DEFAULT_PINS;
  const ids = [...new Set(raw.split(",").filter((id): id is ChartId => (CHART_IDS as readonly string[]).includes(id)))];
  if ((await getSetting(db, INTRADAY_KEY)) === null && !ids.includes("intraday")) {
    const next: ChartId[] = [...ids, "intraday"];
    await savePins(db, next);
    return next;
  }
  return ids;
}

export async function savePins(db: SqlDriver, pins: ChartId[]): Promise<void> {
  await setSetting(db, INTRADAY_KEY, "1");
  await setSetting(db, PINS_KEY, [...new Set(pins)].filter((id) => (CHART_IDS as readonly string[]).includes(id)).join(","));
}
