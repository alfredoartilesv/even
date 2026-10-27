import test from "node:test";
import assert from "node:assert/strict";
import { loadCursor } from "../src/features/metrics/samples";
import { lastSync, runSync } from "../src/features/sync/runSync";
import type { Source, SyncResult } from "../src/features/sync/types";
import { migratedDb } from "./helpers";

const NOW = Date.UTC(2026, 9, 25, 18, 0, 0);
let tick = 0;
const clock = () => NOW + tick++;

/** A source with two days of steps, a catalog of three metrics and one warning; or one that fails. */
const fake = (fail = false): Source => ({
  id: "garmin",
  async fetchSince(): Promise<SyncResult> {
    if (fail) throw new Error("Garmin rejected the personal API key (HTTP 401). It may have expired: make a new one in Garmin Connect.");
    const day = (d: string) => Date.parse(`${d}T00:00:00Z`) - 120 * 60_000;
    return {
      samples: ["2026-10-24", "2026-10-25"].map((d) => ({
        source: "garmin", device: "Garmin", externalId: `${d}#0`, metric: "daily_steps", startMs: day(d), endMs: day(d) + 86_400_000, offsetMin: 120, valueNum: 9000,
      })),
      catalog: [{ metric: "daily_steps" }, { metric: "sleep_durationInSeconds" }, { metric: "hrv_lastNightAvg" }],
      nextCursor: "2026-10-24",
      warnings: ["HRV: not available (HTTP 403)"],
    };
  },
});

test("a good sync stores samples and catalog, moves the cursor and logs the run", async () => {
  const { db } = await migratedDb();
  const out = await runSync(db, fake(), clock);
  assert.equal(out.status, "ok");
  assert.equal(out.samplesWritten, 2);
  assert.equal(out.cursorBefore, null);
  assert.equal(await loadCursor(db, "garmin"), "2026-10-24");

  const [{ n }] = await db.all<{ n: number }>("SELECT COUNT(*) AS n FROM metric_catalog");
  assert.equal(n, 3);
  const last = await lastSync(db, "garmin");
  assert.equal(last?.status, "ok");
  assert.equal(last?.samplesWritten, out.samplesWritten);
  assert.deepEqual(last?.warnings, ["HRV: not available (HTTP 403)"]);
  assert.equal(last?.lastOkMs, last?.finishedMs);
});

test("a failed sync keeps the cursor, records the error, and remembers the last success", async () => {
  const { db } = await migratedDb();
  const ok = await runSync(db, fake(), clock);
  const bad = await runSync(db, fake(true), clock);
  assert.equal(bad.status, "error");
  assert.match(bad.error!, /HTTP 401/);
  assert.equal(await loadCursor(db, "garmin"), ok.cursorAfter);

  const last = await lastSync(db, "garmin");
  assert.equal(last?.status, "error");
  assert.match(last!.error!, /HTTP 401/);
  assert.ok(last!.lastOkMs! < last!.startedMs);
  const [state] = await db.all<{ last_error: string }>("SELECT last_error FROM sync_state");
  assert.match(state.last_error, /HTTP 401/);
});

test("concurrent syncs of one source share a single run", async () => {
  const { db } = await migratedDb();
  let calls = 0;
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const slow: Source = {
    id: "slow",
    async fetchSince(): Promise<SyncResult> {
      calls++;
      await gate;
      return { samples: [], nextCursor: "2026-10-24" };
    },
  };
  const a = runSync(db, slow, clock);
  const b = runSync(db, slow, clock);
  release();
  assert.equal(await a, await b);
  assert.equal(calls, 1);
  const [{ n }] = await db.all<{ n: number }>("SELECT COUNT(*) AS n FROM sync_runs WHERE source = 'slow'");
  assert.equal(n, 1);
});

test("lastSync is null before the first sync", async () => {
  const { db } = await migratedDb();
  assert.equal(await lastSync(db, "garmin"), null);
});
