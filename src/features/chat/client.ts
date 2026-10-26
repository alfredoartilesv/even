import Anthropic from "@anthropic-ai/sdk";
import { CHAT_MODEL, ChatApiError, toChatError, type ClaudeCreate } from "./engine";

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

/** Checks a key before it is saved. Throws a ChatApiError with a message safe to show. */
export type VerifyClaudeKey = (apiKey: string) => Promise<void>;

/**
 * Verify a key with GET /v1/models/{CHAT_MODEL}: free (no tokens), proves the key is valid and
 * that its workspace can use the chat model. Same transport as the chat (pass the native fetch).
 */
export function claudeKeyVerifier(fetchImpl?: typeof fetch): VerifyClaudeKey {
  return async (apiKey) => {
    const client = new Anthropic({ apiKey, fetch: fetchImpl, dangerouslyAllowBrowser: true, maxRetries: 1, timeout: 20_000 });
    try {
      await client.models.retrieve(CHAT_MODEL);
    } catch (err) {
      if (err instanceof Anthropic.NotFoundError) {
        throw new ChatApiError("bad_request", `This key works, but its workspace cannot use ${CHAT_MODEL}. Check the workspace's model access in the Claude Console.`, false, 404);
      }
      throw toChatError(err);
    }
  };
}
