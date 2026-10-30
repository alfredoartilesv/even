/**
 * The web app's way to Garmin (docs/architecture.md section 6c). Garmin's Personal API sends no
 * CORS headers, so a browser cannot read its answers; the phone uses native HTTP instead. The web
 * app sends the same requests to its own sync server, which passes them on and keeps nothing.
 *
 * Shared by the web app (garminRelayFetch) and the server (garminRelayAllowed), so both agree on
 * what may pass. Loaded by the Vercel function: no imports, no parameter properties.
 */

export const GARMIN_API_URL = "https://personal.connectapi.garmin.com";
export const GARMIN_RELAY_PATH = "/v1/garmin";
/** The Garmin credential (`ApiKey …` or `Bearer <garmin token>`), since Authorization carries the device token. */
export const GARMIN_AUTH_HEADER = "x-garmin-authorization";
/** Set on every answer the relay passed on from Garmin, so the web app can tell it from the server's own refusals. */
export const GARMIN_RELAYED_HEADER = "x-garmin-relayed";

const DAY = "\\d{4}-\\d{2}-\\d{2}";
/** Exactly the calls GarminApi makes (src/domain/sync/garmin.ts), and nothing else. */
const ALLOWED: { method: "GET" | "POST"; path: RegExp }[] = [
  { method: "POST", path: /^\/personalapitoken-service\/personal-api\/personal-api-key\/token$/ },
  { method: "GET", path: /^\/usersummary-service\/v2\/dailysummaries$/ },
  { method: "GET", path: /^\/sleep-service\/sleep\/dailySleepSummariesByDate$/ },
  { method: "GET", path: new RegExp(`^/hrv-service/hrv/daily/${DAY}/${DAY}$`) },
  { method: "GET", path: new RegExp(`^/weight-service/weight/range/${DAY}/${DAY}$`) },
  { method: "GET", path: /^\/activitylist-service\/activities\/search\/activities$/ },
  { method: "GET", path: /^\/userprofile-service\/userprofile\/settings$/ },
];

/** True for a Garmin path (after GARMIN_RELAY_PATH) the relay passes on. */
export function garminRelayAllowed(method: string, path: string): boolean {
  return ALLOWED.some((a) => a.method === method && a.path.test(path));
}

/** A server answer that did not come from Garmin: kept apart so a lapsed sign-in never reads as a rejected Garmin key. */
export class GarminRelayError extends Error {
  status: number;
  constructor(status: number) {
    super(status === 401 || status === 403 ? "the sync server refused this browser: sign in again" : `the sync server could not pass it on, HTTP ${status}`);
    this.name = "GarminRelayError";
    this.status = status;
  }
}

/**
 * A fetch for GarminApi in the browser: the same Garmin requests, sent to the sync server with the
 * device token in Authorization and the Garmin credential in GARMIN_AUTH_HEADER.
 */
export function garminRelayFetch(serverUrl: string, deviceToken: string, fetchFn: typeof fetch = (...a) => fetch(...a)): typeof fetch {
  const base = serverUrl.replace(/\/$/, "") + GARMIN_RELAY_PATH;
  return async (input, init = {}) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith(`${GARMIN_API_URL}/`)) throw new Error("not a Garmin request");
    const headers = new Headers(init.headers);
    const garminAuth = headers.get("authorization");
    headers.delete("authorization");
    if (garminAuth) headers.set(GARMIN_AUTH_HEADER, garminAuth);
    headers.set("authorization", `Bearer ${deviceToken}`);
    const res = await fetchFn(base + url.slice(GARMIN_API_URL.length), { ...init, headers });
    if (!res.headers.has(GARMIN_RELAYED_HEADER)) throw new GarminRelayError(res.status);
    return res;
  };
}
