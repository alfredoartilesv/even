import { readFileSync } from "node:fs";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// package.json is the one place the version lives: the About page shows it, and the Android
// build reads it for versionName.
const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as { version: string };

// The web app reaches the sync server on its own origin, as on Vercel (vercel.json): in development
// and in the `web` container Vite passes /v1 and /health on to it.
const syncServer = process.env.SYNC_PROXY ?? "http://localhost:8787";
const proxy = { "/v1": syncServer, "/health": syncServer };

export default defineConfig({
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
  },
  server: { proxy },
  preview: { proxy },
});
