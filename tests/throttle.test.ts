import test from "node:test";
import assert from "node:assert/strict";
import { throttle } from "../src/core/throttle";

test("throttle runs the first call at once and folds the calls during the wait into one at its end", () => {
  const waits: (() => void)[] = [];
  const timers = { setTimeout: ((fn: () => void) => waits.push(fn)) as unknown as typeof setTimeout };
  let runs = 0;
  const run = throttle(() => runs++, 1_000, timers);
  run();
  run();
  run();
  assert.equal(runs, 1);
  waits.shift()!();
  assert.equal(runs, 2, "the last call is not lost");
  waits.shift()!();
  assert.equal(runs, 2, "nothing waiting, nothing run");
  run();
  assert.equal(runs, 3);
});
