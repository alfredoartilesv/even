import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { createLogger } from "../src/core/log";
import { MAX_PUSH_BYTES, pushBody, SYNC_PAGE } from "../src/core/syncWire";
import type { Device, SyncStore } from "./store";

const log = createLogger("server");

/**
 * The sync API (docs/architecture.md section 6). The same app runs in the `sync` Docker container
 * (server/node.ts) and as a Vercel function (api/[[...route]].ts).
 *
 *   GET  /health                          no auth, for Docker and uptime checks
 *   POST /v1/push   { rows: SyncRow[] }   -> { accepted, ignored }
 *   GET  /v1/pull?after=N&limit=M         -> { rows, next, more }
 *
 * Every /v1 call carries `Authorization: Bearer <device token>` (npm run sync:device makes one).
 */
export function createApp(store: SyncStore) {
  const app = new Hono<{ Variables: { device: Device } }>();

  app.get("/health", (c) => c.json({ ok: true }));

  app.use("/v1/*", async (c, next) => {
    const token = /^Bearer (\S+)$/.exec(c.req.header("authorization") ?? "")?.[1];
    const device = token ? await store.deviceFor(token) : null;
    if (!device) return c.json({ error: "unauthorized" }, 401);
    c.set("device", device);
    await next();
  });

  app.post("/v1/push", bodyLimit({ maxSize: MAX_PUSH_BYTES, onError: (c) => c.json({ error: "too large" }, 413) }), async (c) => {
    const body = pushBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "bad request" }, 400);
    const device = c.get("device");
    const res = await store.push(device, body.data.rows);
    log.info("push", { device: device.id, rows: body.data.rows.length, accepted: res.accepted });
    return c.json(res);
  });

  app.get("/v1/pull", async (c) => {
    const after = Number(c.req.query("after") ?? -1);
    const limit = Number(c.req.query("limit") ?? SYNC_PAGE);
    if (!Number.isSafeInteger(after) || after < -1 || !Number.isInteger(limit) || limit < 1 || limit > SYNC_PAGE) return c.json({ error: "bad request" }, 400);
    const device = c.get("device");
    const res = await store.pull(device.ownerId, after, limit);
    log.info("pull", { device: device.id, rows: res.rows.length, more: res.more });
    return c.json(res);
  });

  app.onError((err, c) => {
    log.error("request failed", { err, path: c.req.path });
    return c.json({ error: "server error" }, 500);
  });

  return app;
}
