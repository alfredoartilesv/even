import { createLogger, isLevel, setLogLevel, type Threshold } from "../../core/log";
import type { SqlDriver } from "../../db/driver";
import { getSetting, setSetting } from "../../db/settings";

/** The log level chosen in Settings, kept in app_settings so it survives restarts. */
export const LOG_LEVEL_KEY = "log.level";

const log = createLogger("settings");

export async function loadLogLevel(db: SqlDriver, fallback: Threshold): Promise<Threshold> {
  const v = await getSetting(db, LOG_LEVEL_KEY);
  return isLevel(v) ? v : fallback;
}

/** Apply the stored level (or the fallback) to the logger. Returns the level in force. */
export async function applyStoredLogLevel(db: SqlDriver, fallback: Threshold): Promise<Threshold> {
  const level = await loadLogLevel(db, fallback);
  setLogLevel(level);
  return level;
}

export async function saveLogLevel(db: SqlDriver, level: Threshold, nowMs: number = Date.now()): Promise<void> {
  if (!isLevel(level)) throw new RangeError(`Unknown log level ${level}`);
  await setSetting(db, LOG_LEVEL_KEY, level, nowMs);
  setLogLevel(level);
  log.info("log level changed", { level });
}
