import test from "node:test";
import assert from "node:assert/strict";
import { uuidv7 } from "../src/lib/uuidv7";

test("format, version and variant", () => {
  const id = uuidv7();
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test("embeds the timestamp in the first 48 bits", () => {
  const ms = Date.UTC(2026, 9, 25, 18, 0, 0);
  const id = uuidv7(ms);
  const hex = id.replace(/-/g, "").slice(0, 12);
  assert.equal(parseInt(hex, 16), ms);
});

test("sorts by time", () => {
  const a = uuidv7(1_000_000_000_000);
  const b = uuidv7(1_000_000_000_001);
  const c = uuidv7(1_800_000_000_000);
  assert.deepEqual([c, a, b].sort(), [a, b, c]);
});

test("unique across many calls", () => {
  const ids = new Set(Array.from({ length: 10_000 }, () => uuidv7()));
  assert.equal(ids.size, 10_000);
});
