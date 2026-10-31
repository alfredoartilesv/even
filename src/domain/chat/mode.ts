import { loadClaudeKey, type SecretStore } from "../settings/secrets";

/**
 * The two ways to use Claude (Settings > Connections > Claude) are independent and can both be on:
 * the Chat tab on the owner's own API key, and Claude's own apps through the health connector, on
 * their Claude plan (docs/users.md section 10). The Chat tab shows once a key is saved on this
 * device (a rejected key still shows it, to fix); the connector has its own consents.
 */
export async function chatAvailable(secrets: SecretStore): Promise<boolean> {
  return Boolean(await loadClaudeKey(secrets));
}
