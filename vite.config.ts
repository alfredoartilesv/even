import { existsSync, readFileSync } from "node:fs";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// package.json is the one place the version lives: the About page shows it, and the Android
// build reads it for versionName.
const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as { version: string };

// Which app to build: each target has its own shell in src/apps/<target>/ and shares everything
// below it. Android is the only one today; EVEN_TARGET picks another once it exists.
const target = process.env.EVEN_TARGET ?? "android";
if (!existsSync(new URL(`./src/apps/${target}/main.tsx`, import.meta.url))) throw new Error(`EVEN_TARGET: no src/apps/${target}/main.tsx`);

export default defineConfig({
  plugins: [react(), { name: "even-target", transformIndexHtml: { order: "pre", handler: (html) => html.replace("%TARGET%", target) } }],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
  },
});
