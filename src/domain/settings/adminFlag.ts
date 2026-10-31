import type { SqlDriver } from "../../db/driver";
import { getSetting, setSetting } from "../../db/settings";

/**
 * The account id the server last said is an admin, so Settings still offers Admin's local pages
 * (Debug logs) offline, when the logs matter most. Only a hint for this install's own menu: the
 * server checks the role on every /v1/admin request, and nothing here opens anything remote.
 */
export const ADMIN_ACCOUNT_KEY = "admin.account";

export async function wasAdmin(db: SqlDriver, accountId: string): Promise<boolean> {
  return (await getSetting(db, ADMIN_ACCOUNT_KEY)) === accountId;
}

export async function rememberAdmin(db: SqlDriver, accountId: string, isAdmin: boolean, nowMs: number = Date.now()): Promise<void> {
  await setSetting(db, ADMIN_ACCOUNT_KEY, isAdmin ? accountId : "", nowMs);
}
