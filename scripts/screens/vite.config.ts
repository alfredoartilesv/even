import { fileURLToPath } from "node:url";
import { defineConfig, mergeConfig } from "vite";
import base from "../../vite.config.ts";

/** The app as built, with the native database swapped for the in-memory demo one (demoDatabase.ts). */
const demo = fileURLToPath(new URL("./demoDatabase.ts", import.meta.url));

export default mergeConfig(
  base,
  defineConfig({
    root: fileURLToPath(new URL("../..", import.meta.url)),
    plugins: [
      {
        name: "demo-database",
        enforce: "pre",
        resolveId(id, importer) {
          if (id.endsWith("platform/openDatabase") && importer && !importer.endsWith("demoDatabase.ts")) return demo;
        },
      },
    ],
  }),
);
