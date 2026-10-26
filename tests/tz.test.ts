import test from "node:test";
import assert from "node:assert/strict";
import { addDays, localDateTimeToMs, localDay, localDayStart, tzOffsetMinutes } from "../src/lib/tz";

const MAD = "Europe/Madrid";

test("offset follows DST in Madrid", () => {
  assert.equal(tzOffsetMinutes(Date.UTC(2026, 6, 1, 12), MAD), 120); // summer
  assert.equal(tzOffsetMinutes(Date.UTC(2026, 0, 15, 12), MAD), 60); // winter
});

test("normal day starts at local midnight", () => {
  const { startMs, offsetMin } = localDayStart("2026-10-24", MAD);
  assert.equal(new Date(startMs).toISOString(), "2026-10-23T22:00:00.000Z");
  assert.equal(offsetMin, 120);
});

test("DST end day (2026-10-25) is 25 hours and starts at +02:00", () => {
  const a = localDayStart("2026-10-25", MAD);
  const b = localDayStart("2026-10-26", MAD);
  assert.equal(new Date(a.startMs).toISOString(), "2026-10-24T22:00:00.000Z");
  assert.equal(a.offsetMin, 120);
  assert.equal(b.offsetMin, 60);
  assert.equal((b.startMs - a.startMs) / 3_600_000, 25);
});

test("DST start day (2026-03-29) is 23 hours", () => {
  const a = localDayStart("2026-03-29", MAD);
  const b = localDayStart("2026-03-30", MAD);
  assert.equal((b.startMs - a.startMs) / 3_600_000, 23);
});

test("UTC zone has offset 0", () => {
  assert.equal(localDayStart("2026-01-01", "UTC").offsetMin, 0);
});

test("local date + time to UTC, including both DST transitions", () => {
  const iso = (day: string, time: string) => {
    const r = localDateTimeToMs(day, time, MAD);
    return `${new Date(r.ms).toISOString()} ${r.offsetMin}`;
  };
  assert.equal(iso("2026-10-24", "13:30"), "2026-10-24T11:30:00.000Z 120");
  assert.equal(iso("2026-01-15", "08:00"), "2026-01-15T07:00:00.000Z 60");
  assert.equal(iso("2026-10-25", "02:30"), "2026-10-25T00:30:00.000Z 120"); // ambiguous hour: summer time
  assert.equal(iso("2026-10-25", "20:00"), "2026-10-25T19:00:00.000Z 60"); // after fall-back
  assert.equal(iso("2026-03-29", "02:30"), "2026-03-29T01:30:00.000Z 120"); // skipped hour -> 03:30 local
  assert.equal(iso("2026-03-29", "12:00"), "2026-03-29T10:00:00.000Z 120");
  assert.throws(() => localDateTimeToMs("2026-10-24", "25:00", MAD), /Bad time/);
});

test("localDay and addDays", () => {
  assert.equal(localDay(Date.UTC(2026, 9, 24, 23, 30), MAD), "2026-10-25"); // 01:30 local
  assert.equal(addDays("2026-10-31", 1), "2026-11-01");
  assert.equal(addDays("2026-03-01", -1), "2026-02-28");
  assert.throws(() => addDays("25/10/2026", 1), /Bad date/);
});
