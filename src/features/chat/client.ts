import Anthropic from "@anthropic-ai/sdk";
import type { ClaudeCreate } from "./engine";

/**
 * The real Messages API call, through the official SDK.
 *
 * On the phone, pass makeNativeFetch(CapacitorHttp.request, { readTimeoutMs: ... }) as `fetchImpl`
 * so the request goes over native HTTP (no WebView CORS, same as the freddy sync). The SDK
 * refuses to run in a browser-like environment unless `dangerouslyAllowBrowser` is set; that
 * guard is about shipping a shared key to strangers' browsers. Here the key is the owner's own,
 * typed into their own phone and kept in the Keystore (architecture.md section 5: acceptable for
 * personal use, not for a public release).
 */
export function claudeCreate(apiKey: string, fetchImpl?: typeof fetch): ClaudeCreate {
  const client = new Anthropic({
    apiKey,
    fetch: fetchImpl,
    dangerouslyAllowBrowser: true,
    maxRetries: 2, // 408/409/429/5xx and connection errors
    timeout: 5 * 60_000,
  });
  return (params) => client.beta.messages.create(params);
}
