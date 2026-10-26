import test from "node:test";
import assert from "node:assert/strict";
import { FreddySource, defaultMetricFilter, type ToolCaller } from "../src/features/sync/freddy";
import { parseListMetrics } from "../src/features/sync/freddyText";
import { LIST_METRICS, QUERY_METRICS } from "./fixtures";

// 25 Oct 2026, 19:00 in Madrid (18:00 UTC)
const NOW = Date.UTC(2026, 9, 25, 18, 0, 0);

function fakeCaller(queryText = QUERY_METRICS) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const caller: ToolCaller = {
    async callTool(name, args) {
      calls.push({ name, args });
      return name === "list_metrics" ? LIST_METRICS : queryText;
    },
  };
  return { caller, calls };
}

test("default filter keeps daily/summary metrics, drops epoch and raw-only samples", () => {
  const names = defaultMetricFilter(parseListMetrics(LIST_METRICS));
  assert.deepEqual(names, ["activity_distanceInMeters", "body_weightInGrams", "daily_steps", "sleep_durationInSeconds"]);
});

test("first sync asks for the whole 7-day window", async () => {
  const { caller, calls } = fakeCaller();
  const src = new FreddySource({ caller, now: () => NOW });
  const res = await src.fetchSince(null);
  const q = calls.find((c) => c.name === "query_metrics")!;
  assert.equal(q.args.start, "2026-10-19");
  assert.equal(q.args.end, "2026-10-25");
  assert.deepEqual(q.args.metrics, ["activity_distanceInMeters", "body_weightInGrams", "daily_steps", "sleep_durationInSeconds"]);
  assert.ok(res.samples.length > 0);
  assert.equal(res.nextCursor, "2026-10-24");
});

test("later sync starts at the cursor, not the window start", async () => {
  const { caller, calls } = fakeCaller();
  await new FreddySource({ caller, now: () => NOW }).fetchSince("2026-10-23");
  assert.equal(calls.find((c) => c.name === "query_metrics")!.args.start, "2026-10-23");
});

test("a cursor older than the window warns about the lost days", async () => {
  const { caller, calls } = fakeCaller();
  const res = await new FreddySource({ caller, now: () => NOW }).fetchSince("2026-10-10");
  assert.equal(calls.find((c) => c.name === "query_metrics")!.args.start, "2026-10-19");
  assert.match(res.warnings![0], /Gap: .*2026-10-11 to 2026-10-18/);
});

test("explicit metrics skip list_metrics and are chunked at 50", async () => {
  const { caller, calls } = fakeCaller();
  const metrics = Array.from({ length: 120 }, (_, i) => `m_${i}`);
  await new FreddySource({ caller, metrics, now: () => NOW }).fetchSince(null);
  assert.equal(calls.some((c) => c.name === "list_metrics"), false);
  const sizes = calls.map((c) => (c.args.metrics as string[]).length);
  assert.deepEqual(sizes, [50, 50, 20]);
});

test("unparsed lines surface as a warning", async () => {
  const { caller } = fakeCaller();
  const res = await new FreddySource({ caller, now: () => NOW }).fetchSince(null);
  assert.match(res.warnings!.join("\n"), /1 line\(s\) not understood/);
});

test("tool errors propagate so the caller can record last_error", async () => {
  const caller: ToolCaller = {
    async callTool() {
      throw new Error("401 Unauthorized");
    },
  };
  await assert.rejects(new FreddySource({ caller, now: () => NOW }).fetchSince(null), /401/);
});
