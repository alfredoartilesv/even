/** A reading from any Source, already normalised to canonical units. */
export interface SampleInput {
  source: string;
  device: string;
  /** Stable id from the source so re-syncs are idempotent (e.g. "2026-10-24#0" or a record id). */
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

/** What a source says it holds for one metric (for metric_catalog). */
export interface CatalogEntry {
  metric: string;
  unit?: string;
  device?: string;
  firstDay?: string;
  lastDay?: string;
  records?: number;
}

export interface SyncResult {
  samples: SampleInput[];
  /** Present when the source listed its metrics during this sync. */
  catalog?: CatalogEntry[];
  /** Opaque cursor to store in sync_state; pass back on the next call. */
  nextCursor: string | null;
  /** Things the user should know about (data lost to a window gap, lines we could not parse). */
  warnings?: string[];
}

/** Everything the app knows about a data provider. Swap implementations freely. */
export interface Source {
  readonly id: string;
  fetchSince(cursor: string | null): Promise<SyncResult>;
}

/** When a numeric sample happened: its start and end, and the UTC offset of its day. */
export interface SampleTime {
  startMs: number;
  endMs: number;
  offsetMin: number;
}

/**
 * Collects numeric samples from one source and device (the Garmin sync and the Garmin export
 * build theirs this way). add() skips a missing value and returns how many it added, 0 or 1,
 * so callers can count what a file or endpoint gave.
 */
export function sampleCollector(source: string, device: string) {
  const samples: SampleInput[] = [];
  const add = (metric: string, value: number | null, unit: string | null, at: SampleTime, externalId: string) => {
    if (value === null) return 0;
    samples.push({
      source,
      device,
      externalId,
      metric,
      startMs: at.startMs,
      endMs: at.endMs,
      offsetMin: at.offsetMin,
      valueNum: value,
      ...(unit ? { unit } : {}),
    });
    return 1;
  };
  return { samples, add };
}
