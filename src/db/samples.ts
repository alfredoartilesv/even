import type { SampleInput } from "../sources/types";
import { uuidv7 } from "../lib/uuidv7";
import type { SqlDriver } from "./driver";

const UPSERT = `
INSERT INTO health_samples
  (id, source, device, external_id, metric, start_ms, end_ms, offset_min,
   value_num, value_text, unit, raw_json, local_day, created_at, updated_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT (source, device, metric, external_id) DO UPDATE SET
  start_ms   = excluded.start_ms,
  end_ms     = excluded.end_ms,
  offset_min = excluded.offset_min,
  value_num  = excluded.value_num,
  value_text = excluded.value_text,
  unit       = excluded.unit,
  raw_json   = excluded.raw_json,
  local_day  = excluded.local_day,
  updated_at = excluded.updated_at`;

/** Calendar day of a sample in the zone its offset describes (same rule as migration 0002's backfill). */
export function sampleLocalDay(s: Pick<SampleInput, "startMs" | "offsetMin">): string {
  return new Date(s.startMs + s.offsetMin * 60_000).toISOString().slice(0, 10);
}

/** Insert or refresh samples in one transaction. Re-running with the same input is a no-op in effect. */
export async function upsertSamples(
  db: SqlDriver,
  samples: SampleInput[],
  nowMs: number = Date.now(),
  newId: () => string = () => uuidv7(nowMs),
): Promise<number> {
  if (samples.length === 0) return 0;
  await db.exec("BEGIN");
  try {
    for (const s of samples) {
      await db.run(UPSERT, [
        newId(),
        s.source,
        s.device,
        s.externalId,
        s.metric,
        s.startMs,
        s.endMs ?? null,
        s.offsetMin,
        s.valueNum ?? null,
        s.valueText ?? null,
        s.unit ?? null,
        s.raw === undefined ? null : JSON.stringify(s.raw),
        sampleLocalDay(s),
        nowMs,
        nowMs,
      ]);
    }
    await db.exec("COMMIT");
  } catch (err) {
    await db.exec("ROLLBACK");
    throw err;
  }
  return samples.length;
}

/** Remember how far a source has been synced. */
export async function saveSyncState(
  db: SqlDriver,
  source: string,
  cursor: string | null,
  nowMs: number = Date.now(),
  error: string | null = null,
): Promise<void> {
  await db.run(
    `INSERT INTO sync_state (source, cursor, last_synced_ms, last_error, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (source) DO UPDATE SET
       cursor = excluded.cursor,
       last_synced_ms = COALESCE(excluded.last_synced_ms, sync_state.last_synced_ms),
       last_error = excluded.last_error, updated_at = excluded.updated_at`,
    [source, cursor, error === null ? nowMs : null, error, nowMs],
  );
}

export async function loadCursor(db: SqlDriver, source: string): Promise<string | null> {
  const rows = await db.all<{ cursor: string | null }>("SELECT cursor FROM sync_state WHERE source = ?", [source]);
  return rows[0]?.cursor ?? null;
}
