import { openDatabase } from "../platform/openDatabase";

/**
 * Start opening the database before React renders the first screen; App picks up the same
 * promise. On the web there is no database: App shows that error, so it is not reported here.
 */
export function startOpeningDatabase(): void {
  openDatabase().catch(() => {});
}
