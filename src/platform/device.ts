import { Capacitor, CapacitorHttp, type HttpOptions, type HttpResponse } from "@capacitor/core";
import { Share } from "@capacitor/share";
import { makeNativeFetch } from "./nativeFetch";

/** True in the Android/iOS app, false in the browser build. */
export const isNative = Capacitor.isNativePlatform();

/** "android", "ios" or "web". */
export const platformName = Capacitor.getPlatform();

/** One HTTP request through the native stack (no WebView CORS). */
export const nativeRequest = (o: HttpOptions): Promise<HttpResponse> => CapacitorHttp.request(o);

/** A fetch over native HTTP on the phone; undefined in the browser so callers use the global fetch. */
export function deviceFetch(opts?: Parameters<typeof makeNativeFetch>[1]): typeof fetch | undefined {
  return isNative ? makeNativeFetch(nativeRequest, opts) : undefined;
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
