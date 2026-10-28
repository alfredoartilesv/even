import Anthropic from "@anthropic-ai/sdk";
import { createLogger } from "../../core/log";
import type { SqlDriver } from "../../db/driver";
import { getSetting, setSetting } from "../../db/settings";
import { clearClaudeKey, loadClaudeKey, normalizeClaudeKey, saveClaudeKey, type SecretStore } from "../settings/secrets";
import type { VerifyClaudeKey } from "./client";
import type { ClaudeCreate } from "./engine";

/**
 * Connecting the app to Claude.
 *
 * Why an API key and not a "Sign in with Claude" login: the Claude API authenticates with API
 * keys, Workload Identity Federation (servers) or App Attest (registered iOS/macOS apps only).
 * There is no OAuth sign-in for third-party Android apps, and a Claude.ai subscription does not
 * cover API use; usage is billed to a Claude Console workspace (docs/architecture.md section 5).
 * So connecting = create a key in the Console, paste it, and the app verifies it before saving.
 *
 * State: the key itself in the Keystore (SecretStore), never in SQLite. In app_settings only
 * non-secret facts: when it was verified, its last 4 characters (to recognise it), and a problem
 * message when a request was rejected later (revoked or expired key).
 */

const log = createLogger("chat.connect");

/** Where the owner creates a key. Open in the system browser. */
export const CLAUDE_KEYS_URL = "https://platform.claude.com/settings/keys";

/** Steps the connect screen shows, in order. */
export const CONNECT_STEPS = [
  "Open the Claude Console (button below) and sign in, or create an account. Billing is per use, on that account.",
  "Create a key: Linked account = you, and pick an expiration (30 days is a good balance; you can reconnect any time).",
  "Copy the key (it starts with sk-ant-) and paste it here. The app checks it with Claude before saving it in the phone's secure storage.",
] as const;

const KEYS = { verifiedAt: "claude.verified_at", keyHint: "claude.key_hint", problem: "claude.problem" } as const;

export type ConnectionStatus = "not_connected" | "connected" | "needs_attention";

export interface ClaudeConnection {
  status: ConnectionStatus;
  /** "…AbCd": the last 4 characters, to recognise which key is in use. */
  keyHint: string | null;
  verifiedAtMs: number | null;
  /** Why the last request was rejected (needs_attention only). */
  problem: string | null;
}

export type ConnectResult = { ok: true; connection: ClaudeConnection } | { ok: false; message: string };

/** Check the key with Claude, then store it. A key that fails the check is never saved. */
export async function connectClaude(
  db: SqlDriver,
  secrets: SecretStore,
  apiKey: string,
  verify: VerifyClaudeKey,
  now: number = Date.now(),
): Promise<ConnectResult> {
  let key: string;
  try {
    key = normalizeClaudeKey(apiKey);
  } catch (err) {
    return { ok: false, message: (err as Error).message };
  }
  try {
    await verify(key);
  } catch (err) {
    log.warn("Claude key rejected", { reason: (err as { kind?: string }).kind ?? "unknown" });
    return { ok: false, message: (err as Error).message };
  }
  await saveClaudeKey(secrets, key);
  await setSetting(db, KEYS.verifiedAt, String(now), now);
  await setSetting(db, KEYS.keyHint, `…${key.slice(-4)}`, now);
  await setSetting(db, KEYS.problem, "", now);
  log.info("Claude connected");
  return { ok: true, connection: await claudeConnection(db, secrets) };
}

export async function claudeConnection(db: SqlDriver, secrets: SecretStore): Promise<ClaudeConnection> {
  const key = await loadClaudeKey(secrets);
  if (!key) return { status: "not_connected", keyHint: null, verifiedAtMs: null, problem: null };
  const verified = Number(await getSetting(db, KEYS.verifiedAt));
  const problem = (await getSetting(db, KEYS.problem)) || null;
  return {
    status: problem ? "needs_attention" : "connected",
    keyHint: (await getSetting(db, KEYS.keyHint)) || `…${key.slice(-4)}`,
    verifiedAtMs: Number.isFinite(verified) && verified > 0 ? verified : null,
    problem,
  };
}

/** Remove the key from the phone. Conversations stay; the chat asks to connect again. */
export async function disconnectClaude(db: SqlDriver, secrets: SecretStore, now: number = Date.now()): Promise<void> {
  await clearClaudeKey(secrets);
  for (const k of Object.values(KEYS)) await setSetting(db, k, "", now);
  log.info("Claude disconnected");
}

/**
 * Wrap the Messages API call so the connection state follows reality: a rejected key (revoked,
 * expired, or no longer allowed) marks the connection "needs attention"; the next accepted
 * request clears it. Errors are rethrown unchanged.
 */
export function watchConnection(db: SqlDriver, create: ClaudeCreate, now: () => number = Date.now): ClaudeCreate {
  return async (params) => {
    try {
      const res = await create(params);
      if (await getSetting(db, KEYS.problem)) {
        await setSetting(db, KEYS.problem, "", now());
        log.info("Claude connection restored");
      }
      return res;
    } catch (err) {
      if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
        const message =
          err instanceof Anthropic.AuthenticationError
            ? "Claude no longer accepts this key (revoked or expired). Create a new one and connect again."
            : "This key is not allowed to use the chat model. Check its workspace in the Claude Console.";
        await setSetting(db, KEYS.problem, message, now());
        log.warn("Claude key rejected during chat", { status: err.status });
      }
      throw err;
    }
  };
}
