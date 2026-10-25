import { Capacitor, CapacitorHttp } from "@capacitor/core";
import type { SqlDriver } from "../db/driver";
import { deviceId, getSetting, setSetting } from "../db/settings";
import { loadClaudeKey } from "../settings/secrets";
import { secretStore } from "../settings/secureStore";
import { makeNativeFetch } from "../sources/nativeFetch";
import { claudeCreate } from "./client";
import type { ChatDeps, Effort } from "./engine";
import { DEFAULT_EFFORT } from "./engine";
import type { ConsentScope } from "./consent";

/**
 * Entry point for the UI: everything the chat needs on this device, or null when no
 * Claude API key is stored yet (show the key field in Settings).
 *
 *   const deps = await chatDeps(db, { askConsent: (scope, text) => showConsentDialog(text) });
 *   const res = deps && (await startConversation(deps, question));
 */
export async function chatDeps(
  db: SqlDriver,
  opts: { askConsent?: (scope: ConsentScope, text: string) => Promise<boolean> } = {},
): Promise<ChatDeps | null> {
  const key = await loadClaudeKey(secretStore);
  if (!key) return null;
  // Native HTTP on the phone (no WebView CORS). Long read timeout: a reply with thinking can take minutes.
  const fetchImpl = Capacitor.isNativePlatform()
    ? makeNativeFetch((o) => CapacitorHttp.request(o), { connectTimeoutMs: 30_000, readTimeoutMs: 5 * 60_000 })
    : undefined;
  return {
    db,
    create: claudeCreate(key, fetchImpl),
    deviceId: await deviceId(db),
    effort: await loadEffort(db),
    askConsent: opts.askConsent,
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
