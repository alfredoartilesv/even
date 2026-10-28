import type { PullResult, PushResult, SyncRow } from "../../core/syncWire";
import type { SyncTransport } from "./cloudSync";

export class SyncHttpError extends Error {
  constructor(readonly status: number) {
    super(status === 401 ? "The sync server did not accept this device's token" : `The sync server answered HTTP ${status}`);
    this.name = "SyncHttpError";
  }
}

/**
 * The sync server over HTTP. `fetchFn` is injected: on the phone it is the native HTTP of
 * src/platform (no WebView CORS), in scripts and tests the global fetch or the Hono app itself.
 * The device token goes in the Authorization header only, never in a URL.
 */
export function httpTransport(baseUrl: string, token: string, fetchFn: typeof fetch = fetch): SyncTransport {
  const base = baseUrl.replace(/\/+$/, "");
  const call = async <T>(path: string, init: RequestInit = {}): Promise<T> => {
    const res = await fetchFn(`${base}${path}`, { ...init, headers: { ...init.headers, authorization: `Bearer ${token}` } });
    if (!res.ok) throw new SyncHttpError(res.status);
    return (await res.json()) as T;
  };
  return {
    push: (rows: SyncRow[]) =>
      call<PushResult>("/v1/push", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ rows }) }),
    pull: (after: number, limit: number) => call<PullResult>(`/v1/pull?after=${after}&limit=${limit}`),
  };
}
