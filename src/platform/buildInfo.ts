declare const __APP_VERSION__: string;
declare const __BUILD_TIME__: string;

/** Set by vite.config.ts at build time; the fallbacks cover code run outside Vite (tests, scripts). */
export const APP_VERSION = typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "dev";
export const BUILD_TIME = typeof __BUILD_TIME__ === "string" ? __BUILD_TIME__ : null;
