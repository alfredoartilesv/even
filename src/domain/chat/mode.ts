import type { SqlDriver } from "../../db/driver";
import { getSetting, setSetting } from "../../db/settings";
import { loadClaudeKey, type SecretStore } from "../settings/secrets";

/**
 * The two ways to use Claude (You > Connections > Claude) are independent and can both be on:
 * Coach (the in-app chat) on the owner's own API key, and Claude's own apps through the health
 * connector, on their Claude plan (docs/users.md section 10). Coach shows once a key is saved on
 * this device (a rejected key still shows it, to fix), unless the owner switched it off.
 */
export async function chatAvailable(secrets: SecretStore): Promise<boolean> {
  return Boolean(await loadClaudeKey(secrets));
}

/**
 * Coach switched off on this device (the switch in You > Connections and in first-run Connect):
 * it disappears from the whole app and nothing goes to Claude from it. The key stays saved, so
 * turning it back on needs nothing more. Device-local: app_settings syncs only the profile.
 */
export const COACH_OFF_KEY = "coach.off";

export async function coachSwitchedOff(db: SqlDriver): Promise<boolean> {
  return (await getSetting(db, COACH_OFF_KEY)) === "1";
}

export async function setCoachSwitchedOff(db: SqlDriver, off: boolean): Promise<void> {
  await setSetting(db, COACH_OFF_KEY, off ? "1" : "0");
}

/** Coach is in the app: a key is saved and the owner has not switched it off. */
export async function coachOn(db: SqlDriver, secrets: SecretStore): Promise<boolean> {
  const [key, off] = await Promise.all([chatAvailable(secrets), coachSwitchedOff(db)]);
  return key && !off;
}
