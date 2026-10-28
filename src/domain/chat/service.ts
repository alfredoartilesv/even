import type { SqlDriver } from "../../db/driver";
import { deviceId, getSetting, setSetting } from "../../db/settings";
import { loadClaudeKey, type SecretStore } from "../settings/secrets";
import { claudeCreate } from "./client";
import { watchConnection } from "./connect";
import type { ChatDeps, Effort } from "./engine";
import { DEFAULT_EFFORT } from "./engine";
import type { ActionProposal } from "./actions";
import type { ConsentScope } from "./consent";

/**
 * Entry point for the UI: everything the chat needs on this device, or null when Claude is not
 * connected yet (show the connect screen: connect.ts CONNECT_STEPS, CLAUDE_KEYS_URL, connectClaude
 * with claudeKeyVerifier(deviceFetch(...))). Rejected keys during chat mark the connection
 * "needs attention" (claudeConnection) so the screen can ask to reconnect. The platform pieces come in
 * from the caller (src/app), so this file runs in Node too.
 *
 *   const deps = await chatDeps(db, {
 *     secrets: secretStore,
 *     // Native HTTP on the phone (no WebView CORS). Long read timeout: a reply with thinking can take minutes.
 *     fetch: deviceFetch({ connectTimeoutMs: 30_000, readTimeoutMs: 5 * 60_000 }),
 *     askConsent: (scope, text) => showConsentDialog(text),
 *     confirmAction: (p) => showConfirmSheet(p.summary, p.lines),   // every change the agent wants to save
 *   });
 *   const photo = attachmentFromPhoto(await downscalePhoto(file));    // file from <input type="file" capture>
 *   const res = deps && (await startConversation(deps, "Log this meal", { images: [photo] }));
 *   // res.actions: what was saved / declined; undoAgentAction(db, res.actions[0].id) to revert
 */
export async function chatDeps(
  db: SqlDriver,
  opts: {
    secrets: SecretStore;
    /** Defaults to the global fetch. */
    fetch?: typeof fetch;
    askConsent?: (scope: ConsentScope, text: string) => Promise<boolean>;
    confirmAction?: (proposal: ActionProposal) => Promise<boolean>;
  },
): Promise<ChatDeps | null> {
  const key = await loadClaudeKey(opts.secrets);
  if (!key) return null;
  return {
    db,
    create: watchConnection(db, claudeCreate(key, opts.fetch)),
    deviceId: await deviceId(db),
    effort: await loadEffort(db),
    askConsent: opts.askConsent,
    confirmAction: opts.confirmAction,
  };
}

export const EFFORT_KEY = "claude.effort";
const EFFORTS: Effort[] = ["low", "medium", "high", "xhigh", "max"];

export async function loadEffort(db: SqlDriver): Promise<Effort> {
  const v = await getSetting(db, EFFORT_KEY);
  return EFFORTS.includes(v as Effort) ? (v as Effort) : DEFAULT_EFFORT;
}

export async function saveEffort(db: SqlDriver, effort: Effort): Promise<void> {
  await setSetting(db, EFFORT_KEY, effort);
}
