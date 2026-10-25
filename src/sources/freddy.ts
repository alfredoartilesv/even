import type { Source, SyncResult } from "./types";

/**
 * freddy adapter: NOT IMPLEMENTED YET.
 *
 * Blocked on the phase-1 spike (docs/architecture.md section 4, item 1): we have
 * only confirmed freddy's hosted MCP endpoint. Before writing this, find out whether
 * freddy offers a REST API / tokens for third-party apps, and read its terms.
 *
 * Known from freddy's tools: queries are windowed (max 365 days per call; this
 * account's plan currently allows 7), support day/week/month aggregation, and daily
 * totals should come from the de-duplicated "_total" Merged metrics.
 */
export class FreddySource implements Source {
  readonly id = "freddy";

  async fetchSince(_cursor: string | null): Promise<SyncResult> {
    throw new Error("FreddySource is not implemented yet. See docs/architecture.md section 4.");
  }
}
