import test from "node:test";
import assert from "node:assert/strict";
import { foldBatch, planDefrost, stockAlerts, type BatchInfo, type Move } from "../src/features/mealprep/stock";

const TZ = "Europe/Madrid";
const H = 3_600_000;
// 2026-10-20 19:00 in Madrid (+02:00)
const COOKED = Date.UTC(2026, 9, 20, 17, 0, 0);

function batch(over: Partial<BatchInfo> = {}): BatchInfo {
  return {
    id: "b1",
    mealPrepId: "p1",
    name: "Chili",
    tags: ["dinner"],
    cookedAtMs: COOKED,
    localDay: "2026-10-20",
    portions: 6,
    fridgeDays: 4,
    freezerDays: 90,
    thawHours: 24,
    ...over,
  };
}

let seq = 0;
function move(kind: Move["kind"], portions: number, atMs: number, localDay: string, fromLoc: Move["fromLoc"] = kind === "thaw" ? "freezer" : "fridge"): Move {
  return { id: `m${String(++seq).padStart(3, "0")}`, batchId: "b1", atMs, localDay, kind, fromLoc, portions };
}

test("fold: portions start in the fridge, then freeze, defrost, eat and throw out", () => {
  const s = foldBatch(batch(), [
    move("freeze", 4, COOKED + H, "2026-10-20"),
    move("eat", 1, COOKED + 24 * H, "2026-10-21"),
    move("thaw", 2, COOKED + 72 * H, "2026-10-23"),
    move("discard", 1, COOKED + 73 * H, "2026-10-23", "freezer"),
  ]);
  assert.equal(s.fridgeCount, 3); // 1 fresh + 2 defrosting
  assert.equal(s.freezerCount, 1);
  assert.equal(s.eaten, 1);
  assert.equal(s.discarded, 1);
  assert.equal(s.left, 4);
  assert.equal(s.overdrawn, 0);
  assert.deepEqual(
    s.fridge.map((l) => [l.portions, l.eatBy, l.thawed]),
    [
      [1, "2026-10-24", false], // cooked 20th + 4 fridge days
      [2, "2026-10-28", true], // thaw started 23rd + 1 thaw day + 4 fridge days
    ],
  );
  assert.equal(s.fridge[1].readyAtMs, COOKED + 96 * H);
  assert.deepEqual(s.freezer, [{ portions: 1, frozenDay: "2026-10-20", bestBefore: "2027-01-18" }]);
});

test("fold: eating takes defrosted portions before ones still thawing, and counts overdrawn moves", () => {
  const s = foldBatch(batch({ portions: 2 }), [
    move("freeze", 2, COOKED, "2026-10-20"),
    move("thaw", 1, COOKED + 10 * H, "2026-10-21"),
    move("thaw", 1, COOKED + 40 * H, "2026-10-22"),
    move("eat", 1, COOKED + 36 * H, "2026-10-22"), // sorted by time: only the first thaw is ready
    move("eat", 5, COOKED + 100 * H, "2026-10-24"),
  ]);
  assert.equal(s.eaten, 2);
  assert.equal(s.overdrawn, 4);
  assert.equal(s.left, 0);
});

test("alerts: expired, due soon, still thawing and old in the freezer", () => {
  const s = foldBatch(batch({ freezerDays: 2 }), [
    move("freeze", 3, COOKED, "2026-10-20"),
    move("thaw", 1, COOKED + 100 * H, "2026-10-24"),
  ]);
  const now = COOKED + 101 * H;
  const kinds = stockAlerts([s], "2026-10-25", now).map((a) => [a.kind, a.portions]);
  assert.deepEqual(kinds, [
    ["expired", 3], // eat by the 24th
    ["thawing", 1],
    ["freezer_old", 2],
  ]);
  assert.deepEqual(
    stockAlerts([foldBatch(batch(), [])], "2026-10-23", COOKED).map((a) => a.kind),
    ["eat_soon"],
  );
});

test("plan: eat from the fridge first, defrost the day before it runs out", () => {
  const s = foldBatch(batch(), [move("freeze", 4, COOKED + H, "2026-10-20")]);
  // 2 fresh portions left, 1 a day: covered on the 21st and 22nd, freezer from the 23rd.
  const plan = planDefrost([s], { today: "2026-10-21", nowMs: COOKED + 20 * H, timeZone: TZ, portionsPerDay: 1, horizonDays: 7 });
  assert.equal(plan.fridgeNow, 2);
  assert.equal(plan.freezerNow, 4);
  assert.deepEqual(
    plan.thaw.map((t) => [t.day, t.forDay, t.portions, t.late]),
    [
      ["2026-10-22", "2026-10-23", 1, false],
      ["2026-10-23", "2026-10-24", 1, false],
      ["2026-10-24", "2026-10-25", 1, false],
      ["2026-10-25", "2026-10-26", 1, false],
    ],
  );
  assert.deepEqual(plan.short, [{ day: "2026-10-27", missing: 1 }]);
  assert.equal(plan.coveredThrough, "2026-10-26");
  assert.deepEqual(plan.waste, []);
});

test("plan: portions already eaten today count, late defrosts are flagged, unreachable fridge food is a waste risk", () => {
  const s = foldBatch(batch({ portions: 5, fridgeDays: 2 }), [move("freeze", 1, COOKED, "2026-10-20")]);
  const plan = planDefrost([s], {
    today: "2026-10-20",
    nowMs: COOKED + H,
    timeZone: TZ,
    portionsPerDay: 1,
    eatenToday: 1,
    horizonDays: 4,
  });
  // 4 in the fridge, good until the 22nd: eaten on the 21st and 22nd, 2 left over.
  assert.deepEqual(plan.waste, [{ batchId: "b1", name: "Chili", portions: 2, eatBy: "2026-10-22" }]);
  assert.deepEqual(plan.thaw.map((t) => [t.day, t.forDay]), [["2026-10-22", "2026-10-23"]]);

  const hungry = planDefrost([foldBatch(batch({ portions: 1 }), [move("freeze", 1, COOKED, "2026-10-20")])], {
    today: "2026-10-20",
    nowMs: COOKED + H,
    timeZone: TZ,
    portionsPerDay: 1,
    horizonDays: 1,
  });
  assert.deepEqual(hungry.thaw.map((t) => [t.day, t.forDay, t.late]), [["2026-10-20", "2026-10-20", true]]);
  assert.equal(hungry.coveredThrough, "2026-10-20");
});

test("plan: portions still defrosting count from the day they are ready", () => {
  const s = foldBatch(batch({ portions: 1 }), [move("freeze", 1, COOKED, "2026-10-20"), move("thaw", 1, COOKED + H, "2026-10-20")]);
  const plan = planDefrost([s], { today: "2026-10-20", nowMs: COOKED + 2 * H, timeZone: TZ, portionsPerDay: 1, horizonDays: 2 });
  assert.equal(plan.fridgeNow, 0);
  assert.deepEqual(plan.short, [{ day: "2026-10-20", missing: 1 }]);
  assert.equal(plan.coveredThrough, null);
});
