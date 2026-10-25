/** A reading from any Source, already normalised to canonical units. */
export interface SampleInput {
  source: string;
  device: string;
  /** Stable id from the source so re-syncs are idempotent (e.g. "2026-10-24" or a record id). */
  externalId: string;
  metric: string;
  startMs: number;
  endMs?: number;
  offsetMin: number;
  valueNum?: number;
  valueText?: string;
  unit?: string;
  raw?: unknown;
}

export interface SyncResult {
  samples: SampleInput[];
  /** Opaque cursor to store in sync_state; pass back on the next call. */
  nextCursor: string | null;
}

/** Everything the app knows about a data provider. Swap implementations freely. */
export interface Source {
  readonly id: string;
  fetchSince(cursor: string | null): Promise<SyncResult>;
}
