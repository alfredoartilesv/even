import type { Context } from "hono";
import { createLogger } from "../src/core/log.js";
import { GARMIN_API_URL, GARMIN_AUTH_HEADER, GARMIN_RELAY_PATH, GARMIN_RELAYED_HEADER, garminRelayAllowed } from "../src/core/garminRelay.js";

const log = createLogger("server.garmin");

/** Garmin's answers are small JSON; well under Vercel's function limit even for a slow day. */
const TIMEOUT_MS = 25_000;

/**
 * Passes one of the web app's Garmin requests on (docs/architecture.md section 6c). Behind the
 * device check, for the calls in garminRelayAllowed only. Nothing is stored, and nothing about the
 * request is logged but the service, the status and the time: never the key, a token, a date or a body.
 */
export async function relayToGarmin(c: Context, fetchFn: typeof fetch = (...a) => fetch(...a)): Promise<Response> {
  const path = c.req.path.slice(GARMIN_RELAY_PATH.length);
  const service = path.split("/")[1] ?? "";
  if (!garminRelayAllowed(c.req.method, path)) return c.json({ error: "not relayed" }, 404);
  const auth = c.req.header(GARMIN_AUTH_HEADER);
  if (!auth) return c.json({ error: "no Garmin credential" }, 400);
  const started = Date.now();
  let res: Response;
  try {
    res = await fetchFn(GARMIN_API_URL + path + new URL(c.req.url).search, {
      method: c.req.method,
      headers: { authorization: auth, accept: c.req.header("accept") ?? "*/*" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    log.warn("Garmin unreachable", { service, kind: (e as Error).name, ms: Date.now() - started });
    return c.json({ error: "Garmin unreachable" }, 502);
  }
  log.info("relayed", { service, status: res.status, ms: Date.now() - started });
  return new Response(await res.arrayBuffer(), {
    status: res.status,
    headers: { "content-type": res.headers.get("content-type") ?? "application/octet-stream", "cache-control": "no-store", [GARMIN_RELAYED_HEADER]: "1" },
  });
}
