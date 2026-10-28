import { createLogger, setLogLevel, type Threshold } from "../../core/log";
import { isNative } from "../../platform/device";

/** debug while developing (npm run dev), info in the built app. Settings can change it. */
export const DEFAULT_LOG_LEVEL: Threshold = import.meta.env.DEV ? "debug" : "info";

const log = createLogger("app");

/** Called once before React renders: default level, and uncaught errors go to the log too. */
export function initLogging(): void {
  setLogLevel(DEFAULT_LOG_LEVEL);
  window.addEventListener("error", (e) => log.error("uncaught error", { err: e.error ?? e.message }));
  window.addEventListener("unhandledrejection", (e) => log.error("unhandled promise rejection", { err: e.reason }));
  log.info("app starting", { level: DEFAULT_LOG_LEVEL, native: isNative });
}
