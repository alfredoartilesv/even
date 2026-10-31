import type { SqlDriver } from "../../db/driver";
import { getSetting, setSetting } from "../../db/settings";
import { loadClaudeKey, type SecretStore } from "../settings/secrets";

/**
 * How the owner talks to Claude on this device (Settings > Connections > Claude): the Chat tab on
 * their own API key, or Claude's own apps through the health connector, on their Claude plan
 * (docs/users.md section 10). Kept per device, like the key itself (app_settings is not synced).
 *
 * Until the owner picks, a device with a key keeps the Chat tab and one without starts on the
 * connector, so nobody sees a Chat tab that cannot answer.
 */
export type ClaudeMode = "api" | "connector";

const MODE_KEY = "claude.mode";

export async function claudeMode(db: SqlDriver, secrets: SecretStore): Promise<ClaudeMode> {
  const saved = await getSetting(db, MODE_KEY);
  if (saved === "api" || saved === "connector") return saved;
  return (await loadClaudeKey(secrets)) ? "api" : "connector";
}

export async function setClaudeMode(db: SqlDriver, mode: ClaudeMode): Promise<void> {
  await setSetting(db, MODE_KEY, mode);
}

/** The Chat tab is shown only on the API key way, once a key is saved (a rejected key still shows it, to fix). */
export async function chatAvailable(db: SqlDriver, secrets: SecretStore): Promise<boolean> {
  return (await claudeMode(db, secrets)) === "api" && Boolean(await loadClaudeKey(secrets));
}
