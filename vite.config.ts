import { existsSync, readFileSync } from "node:fs";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// package.json is the one place the version lives: the About page shows it, and the Android
// build reads it for versionName.
const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as { version: string };

// The web app reaches the sync server on its own origin, as on Vercel (vercel.json): in development
// and in the `web` container Vite passes /v1 and /health on to it.
const syncServer = process.env.SYNC_PROXY ?? "http://localhost:8787";
const proxy = { "/v1": syncServer, "/health": syncServer };

// Which app to build. Each target has its own entry in src/apps/<target>/ over the shared code:
// `--mode web` builds the web app (Vercel, the web container, dev:web); any other mode builds
// Android. The target is written into index.html, and android-harden.mjs refuses a web build.
const targetOf = (mode: string) => (mode === "web" ? "web" : "android");

export default defineConfig(({ mode }) => {
  const target = targetOf(mode);
  if (!existsSync(new URL(`./src/apps/${target}/main.tsx`, import.meta.url))) throw new Error(`no src/apps/${target}/main.tsx`);
  return {
    plugins: [react(), { name: "even-target", transformIndexHtml: { order: "pre" as const, handler: (html: string) => html.replaceAll("%TARGET%", target) } }],
    define: {
      __APP_VERSION__: JSON.stringify(pkg.version),
      __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
    },
    server: { proxy },
    preview: { proxy },
  };
});
