import test from "node:test";
import assert from "node:assert/strict";
import { loadCursor, saveSyncState, upsertSamples } from "../src/db/samples";
import { parseQueryMetrics } from "../src/sources/freddyText";
import { QUERY_METRICS } from "./fixtures";
import { migratedDb } from "./helpers";

const T1 = 1_800_000_000_000;

test("stores parsed samples with all columns", async () => {
  const { db } = await migratedDb();
  const { samples } = parseQueryMetrics(QUERY_METRICS);
  const n = await upsertSamples(db, samples, T1);
  assert.equal(n, samples.length);
  const [row] = await db.all<Record<string, unknown>>(
    "SELECT * FROM health_samples WHERE metric = 'daily_steps' AND external_id = '2026-10-24#0'",
  );
  assert.equal(row.value_num, 10000);
  assert.equal(row.source, "freddy");
  assert.equal(row.device, "Garmin");
  assert.equal(row.offset_min, 120);
  assert.equal(row.created_at, T1);
  assert.match(String(row.id), /^[0-9a-f]{8}-[0-9a-f]{4}-7/);
});

test("re-syncing updates the partial day in place, no duplicates", async () => {
  const { db } = await migratedDb();
  const first = parseQueryMetrics(QUERY_METRICS).samples;
  await upsertSamples(db, first, T1);
  const before = (await db.all<{ n: number }>("SELECT COUNT(*) AS n FROM health_samples"))[0].n;

  // Later the same day finishes with a bigger step count and is no longer partial.
  const later = parseQueryMetrics(QUERY_METRICS.replace("daily_steps: 15000", "daily_steps: 16000")).samples.map((s) => ({
    ...s,
    raw: undefined,
  }));
  await upsertSamples(db, later, T1 + 3_600_000);

  const after = (await db.all<{ n: number }>("SELECT COUNT(*) AS n FROM health_samples"))[0].n;
  assert.equal(after, before);
  const [row] = await db.all<{ value_num: number; created_at: number; updated_at: number; raw_json: string | null }>(
    "SELECT value_num, created_at, updated_at, raw_json FROM health_samples WHERE external_id = '2026-10-25#0' AND metric = 'daily_steps'",
  );
  assert.equal(row.value_num, 16000);
  assert.equal(row.created_at, T1, "created_at keeps the first-seen time");
  assert.equal(row.updated_at, T1 + 3_600_000);
  assert.equal(row.raw_json, null, "partial flag cleared");
});

test("text values are stored in value_text", async () => {
  const { db } = await migratedDb();
  await upsertSamples(db, parseQueryMetrics(QUERY_METRICS).samples, T1);
  const [row] = await db.all<{ value_num: number | null; value_text: string }>(
    "SELECT value_num, value_text FROM health_samples WHERE metric = 'daily_stressQualifier'",
  );
  assert.equal(row.value_num, null);
  assert.equal(row.value_text, "very stressful");
});

test("a failing batch rolls back completely", async () => {
  const { db } = await migratedDb();
  const good = parseQueryMetrics(QUERY_METRICS).samples[0];
  const bad = { ...good, externalId: "x", metric: undefined as unknown as string }; // NOT NULL violation
  await assert.rejects(upsertSamples(db, [good, bad], T1));
  const n = (await db.all<{ n: number }>("SELECT COUNT(*) AS n FROM health_samples"))[0].n;
  assert.equal(n, 0);
});

test("empty input is a no-op", async () => {
  const { db } = await migratedDb();
  assert.equal(await upsertSamples(db, [], T1), 0);
});

test("sync state keeps last success time when a later sync fails", async () => {
  const { db } = await migratedDb();
  assert.equal(await loadCursor(db, "freddy"), null);
  await saveSyncState(db, "freddy", "2026-10-24", T1);
  await saveSyncState(db, "freddy", "2026-10-24", T1 + 5, "network down");
  const [row] = await db.all<{ cursor: string; last_synced_ms: number; last_error: string }>(
    "SELECT cursor, last_synced_ms, last_error FROM sync_state WHERE source = 'freddy'",
  );
  assert.deepEqual(row, { cursor: "2026-10-24", last_synced_ms: T1, last_error: "network down" });
  assert.equal(await loadCursor(db, "freddy"), "2026-10-24");
});
