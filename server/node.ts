import { serve } from "@hono/node-server";
import { createLogger, setLogLevel } from "../src/core/log";
import { createApp } from "./app";
import { migrateServer } from "./migrate";
import { postgresJs } from "./pg";
import { createStores } from "./stores";

/**
 * The `sync` Docker container's entry point (docker-compose.yml): brings the database up to the
 * server schema, then serves the sync API. DATABASE_URL is the compose `db` service locally.
 */
const log = createLogger("server");
setLogLevel((process.env.LOG_LEVEL as never) ?? "info");

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is not set");
const port = Number(process.env.PORT ?? 8787);

const pg = postgresJs(url);
await migrateServer(pg);
const server = serve({ fetch: createApp(createStores(pg, process.env)).fetch, port, hostname: "0.0.0.0" }, () => log.info("sync server listening", { port }));

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    log.info("sync server stopping", { signal });
    server.close(() => void pg.close().then(() => process.exit(0)));
  });
}
