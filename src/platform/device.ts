import { Capacitor, CapacitorHttp, type HttpOptions, type HttpResponse } from "@capacitor/core";
import { Share } from "@capacitor/share";
import { garminRelayFetch } from "../core/garminRelay";
import { makeNativeFetch } from "./nativeFetch";

/** True in the Android/iOS app, false in the browser build. */
export const isNative = Capacitor.isNativePlatform();

/** "android", "ios" or "web". */
export const platformName = Capacitor.getPlatform();

/** One HTTP request through the native stack (no WebView CORS). */
const nativeRequest = (o: HttpOptions): Promise<HttpResponse> => CapacitorHttp.request(o);

/** A fetch over native HTTP on the phone; undefined in the browser so callers use the global fetch. */
export function deviceFetch(opts?: Parameters<typeof makeNativeFetch>[1]): typeof fetch | undefined {
  return isNative ? makeNativeFetch(nativeRequest, opts) : undefined;
}

/**
 * The fetch GarminApi uses: native HTTP on the phone; in the browser, the relay on this device's sync
 * server (Garmin sends no CORS headers). Undefined in a browser not signed in: there is no relay to use.
 */
export function garminFetch(session: { serverUrl: string; token: string } | null, opts?: Parameters<typeof makeNativeFetch>[1]): typeof fetch | undefined {
  if (isNative) return deviceFetch(opts);
  return session ? garminRelayFetch(session.serverUrl, session.token) : undefined;
}

/** Share text through the system sheet on the phone, or copy it in the browser. Returns what happened. */
export async function shareText(title: string, text: string): Promise<"shared" | "copied"> {
  if (isNative) {
    await Share.share({ title, text });
    return "shared";
  }
  await navigator.clipboard.writeText(text);
  return "copied";
}
