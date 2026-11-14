import test from "node:test";
import assert from "node:assert/strict";
import { clockOf, intradayEnergy } from "../src/domain/dashboard/intraday";

const TZ = "UTC";
const at = (h: number, m = 0) => Date.UTC(2026, 10, 13, h, m);

test("a past day: eaten steps up at each meal's time, burned spreads the day total over 24 hours", () => {
  const pts = intradayEnergy(
    "2026-11-13",
    TZ,
    [
      { atMs: at(9), kcal: 412 },
      { atMs: at(14, 52), kcal: 990 },
      { atMs: at(20), kcal: 180 },
    ],
    2400,
    null,
  );
  assert.equal(pts.length, 25, "midnight to midnight, one point an hour");
  assert.deepEqual(pts[0], { minute: 0, eaten: 0, burned: 0 });
  assert.equal(pts[9].eaten, 412, "breakfast counts from 09:00");
  assert.equal(pts[14].eaten, 412, "lunch at 14:52 is not there yet at 14:00");
  assert.equal(pts[15].eaten, 1402);
  assert.deepEqual(pts[24], { minute: 1440, eaten: 1582, burned: 2400 });
  assert.equal(pts[12].burned, 1200, "half the day, half the burn");
});

test("today ends at now, burned reaching the watch's total so far there; no watch number, no burned line", () => {
  const now = at(15, 30);
  const pts = intradayEnergy("2026-11-13", TZ, [{ atMs: at(15, 10), kcal: 500 }], 1860, now);
  const last = pts[pts.length - 1];
  assert.equal(last.minute, 930, "a last point at 15:30");
  assert.deepEqual([last.eaten, last.burned], [500, 1860]);
  assert.equal(pts[15].eaten, 0, "the 15:10 meal comes after the 15:00 point");
  assert.equal(intradayEnergy("2026-11-13", TZ, [], null, now)[3].burned, null);
  const early = intradayEnergy("2026-11-13", TZ, [], 1000, at(20, 7)).map((p) => p.minute);
  assert.deepEqual(early.slice(-2), [19 * 60, 20 * 60 + 7], "a now 7 minutes past the hour takes that hour's place");
  assert.equal(clockOf(930), "15:30");
  assert.equal(clockOf(1440), "00:00");
});
