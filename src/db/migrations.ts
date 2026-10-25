import { parseMigrations } from "./migrate";

// Vite inlines every migration file as a raw string at build time.
const files = import.meta.glob("./migrations/*.sql", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

export const migrations = parseMigrations(files);
