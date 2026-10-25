import test from "node:test";
import assert from "node:assert/strict";
import { loadCursor } from "../src/db/samples";
import { lastSync, runSync } from "../src/sync/runSync";
import { FreddySource, type ToolCaller } from "../src/sources/freddy";
import type { Source, SyncResult } from "../src/sources/types";
import { LIST_METRICS, QUERY_METRICS } from "./fixtures";
import { migratedDb } from "./helpers";

const NOW = Date.UTC(2026, 9, 25, 18, 0, 0);
let tick = 0;
const clock = () => NOW + tick++;

const freddy = (fail = false) => {
  const caller: ToolCaller = {
    async callTool(name) {
      if (fail) throw new Error("freddy rejected the credentials (HTTP 401). Check the MCP key.");
      return name === "list_metrics" ? LIST_METRICS : QUERY_METRICS;
    },
  };
  return new FreddySource({ caller, now: () => NOW });
};

test("a good sync stores samples and catalog, moves the cursor and logs the run", async () => {
  const { db } = await migratedDb();
  const out = await runSync(db, freddy(), clock);
  assert.equal(out.status, "ok");
  assert.ok(out.samplesWritten > 0);
  assert.equal(out.cursorBefore, null);
  assert.equal(await loadCursor(db, "freddy"), "2026-10-24");

  const [{ n }] = await db.all<{ n: number }>("SELECT COUNT(*) AS n FROM metric_catalog");
  assert.equal(n, 6);
  const last = await lastSync(db, "freddy");
  assert.equal(last?.status, "ok");
  assert.equal(last?.samplesWritten, out.samplesWritten);
  assert.ok(last?.warnings.some((w) => /not understood/.test(w)));
  assert.equal(last?.lastOkMs, last?.finishedMs);
});

test("a failed sync keeps the cursor, records the error, and remembers the last success", async () => {
  const { db } = await migratedDb();
  const ok = await runSync(db, freddy(), clock);
  const bad = await runSync(db, freddy(true), clock);
  assert.equal(bad.status, "error");
  assert.match(bad.error!, /HTTP 401/);
  assert.equal(await loadCursor(db, "freddy"), ok.cursorAfter);

  const last = await lastSync(db, "freddy");
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
  assert.equal(await lastSync(db, "freddy"), null);
});
