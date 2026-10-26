import type { HttpOptions, HttpResponse } from "@capacitor/core";
import { createLogger } from "../core/log";

const log = createLogger("http.native");

/**
 * A fetch() look-alike on top of Capacitor's native HTTP (CapacitorHttp.request).
 * Native requests are not subject to WebView CORS. Used for the Garmin sync and the Claude
 * chat: GET, and POST with a JSON or text body; replies (text or event-stream) are read in full.
 *
 * `request` is injected so this file has no runtime Capacitor import and tests can fake it.
 */
export function makeNativeFetch(
  request: (o: HttpOptions) => Promise<HttpResponse>,
  timeouts: { connectTimeoutMs?: number; readTimeoutMs?: number } = {},
): typeof fetch {
  return async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    let data: unknown;
    if (typeof init?.body === "string") {
      // CapacitorHttp serialises `data` itself for JSON requests, so a string would be sent quoted.
      data = (headers["content-type"] ?? "").includes("json") ? JSON.parse(init.body) : init.body;
    }

    let res: HttpResponse;
    const started = Date.now();
    try {
      res = await request({
        url,
        method: init?.method ?? "GET",
        headers,
        data,
        responseType: "text",
        connectTimeout: timeouts.connectTimeoutMs,
        readTimeout: timeouts.readTimeoutMs,
      });
    } catch (e) {
      log.warn("native request failed", { method: init?.method ?? "GET", ms: Date.now() - started, err: e });
      // Match fetch: network failures reject with a TypeError (callers already handle that shape).
      throw new TypeError("Native HTTP request failed", { cause: e });
    }

    log.debug("native request", { method: init?.method ?? "GET", status: res.status, ms: Date.now() - started });
    const text = typeof res.data === "string" ? res.data : res.data == null ? "" : JSON.stringify(res.data);
    const nullBody = res.status === 204 || res.status === 205 || res.status === 304;
    return new Response(nullBody ? null : text, { status: res.status, headers: res.headers });
  };
}
