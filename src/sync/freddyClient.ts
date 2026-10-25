import type { HttpOptions, HttpResponse } from "@capacitor/core";
import type { SqlDriver } from "../db/driver";
import { getSetting } from "../db/settings";
import type { FreddyCredentials } from "../settings/secrets";
import { FreddySource } from "../sources/freddy";
import { McpHttpCaller } from "../sources/mcpHttp";
import { makeNativeFetch } from "../sources/nativeFetch";

/**
 * How requests reach freddy. "native" (CapacitorHttp) is not subject to WebView CORS and
 * is the default on the phone. "fetch" is the WebView's fetch, kept to test whether
 * freddy's CORS headers are enough (docs/architecture.md 4b) and for the browser build.
 */
export type Transport = "native" | "fetch";
export const TRANSPORT_KEY = "freddy.transport";

export async function loadTransport(db: SqlDriver, isNative: boolean): Promise<Transport> {
  const v = await getSetting(db, TRANSPORT_KEY);
  if (v === "native" || v === "fetch") return v;
  return isNative ? "native" : "fetch";
}

export function freddySource(
  creds: FreddyCredentials,
  transport: Transport,
  nativeRequest?: (o: HttpOptions) => Promise<HttpResponse>,
): FreddySource {
  const doFetch = transport === "native" && nativeRequest ? makeNativeFetch(nativeRequest) : undefined;
  const caller = new McpHttpCaller({ url: creds.url, apiKey: creds.apiKey ?? undefined, fetch: doFetch });
  return new FreddySource({ caller });
}
