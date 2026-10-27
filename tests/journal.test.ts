import test from "node:test";
import assert from "node:assert/strict";
import { latestWeight } from "../src/features/alcohol/alcohol";
import { loadDashboard } from "../src/features/dashboard/dashboard";
import {
  addMeasurement,
  deleteDayNote,
  deleteMeasurement,
  fmtMeasurement,
  getDayNote,
  kindLabel,
  listDayNotes,
  listMeasurements,
  measurementKinds,
  measurementSeries,
  presetFor,
  restoreMeasurement,
  saveDayNote,
} from "../src/features/journal/entries";
import { insertDayNote } from "../src/features/journal/journal";
import { migratedDb } from "./helpers";

const TZ = "Europe/Madrid";
const TODAY = "2026-10-26";
const NOW = Date.parse("2026-10-26T18:00:00Z"); // 19:00 in Madrid (CET)
const at = (day: string, hhmm: string) => Date.parse(`${day}T${hhmm}:00Z`) - 60 * 60_000; // CET wall clock

test("measurements: each kind checks its shape and range, with a message safe to show", async () => {
  const { db } = await migratedDb();
  const add = (m: Parameters<typeof addMeasurement>[1]) => addMeasurement(db, m, "user", NOW);
  await assert.rejects(add({ kind: "weight", value: null, timeZone: TZ }), /Enter the weight/);
  await assert.rejects(add({ kind: "weight", value: 900, timeZone: TZ }), /between 20 and 400 kg/);
  await assert.rejects(add({ kind: "weight", value: NaN, timeZone: TZ }), /Enter the weight/);
  await assert.rejects(add({ kind: "blood_pressure", value: 120, timeZone: TZ }), /both numbers/);
  await assert.rejects(add({ kind: "blood_pressure", value: 80, value2: 120, timeZone: TZ }), /lower than the first/);
  await assert.rejects(add({ kind: "supplement", text: "  ", timeZone: TZ }), /Write what the supplement was/);
  await assert.rejects(add({ kind: "Blood Pressure", value: 1, timeZone: TZ }), /lower case/);
  await assert.rejects(add({ kind: "weight", value: 80, atMs: NOW + 3_600_000, timeZone: TZ }), /in the future/);
  assert.equal((await listMeasurements(db, "2000-01-01", TODAY)).length, 0, "nothing saved by a refused input");
});

test("measurements: saved in the owner's zone with the kind's unit; listed, summarised and charted per day", async () => {
  const { db } = await migratedDb();
  const add = (m: Parameters<typeof addMeasurement>[1]) => addMeasurement(db, m, "user", NOW);
  await add({ kind: "weight", value: 82.4, atMs: at("2026-10-24", "07:30"), timeZone: TZ });
  await add({ kind: "weight", value: 82.0, atMs: at("2026-10-26", "07:10"), timeZone: TZ });
  await add({ kind: "weight", value: 81.6, atMs: at("2026-10-26", "18:00"), timeZone: TZ, notes: " after the run " });
  await add({ kind: "blood_pressure", value: 128, value2: 82, atMs: at("2026-10-25", "08:00"), timeZone: TZ });
  await add({ kind: "supplement", text: "Vitamin D 2000 IU", value: 5, atMs: at("2026-10-26", "09:00"), timeZone: TZ });
  // 23:30 in Madrid is 22:30 UTC: the owner's zone decides the day.
  const late = await add({ kind: "glucose", value: 5.4, atMs: at("2026-10-25", "23:30"), timeZone: TZ });

  const all = await listMeasurements(db, "2026-10-01", TODAY);
  assert.deepEqual(
    all.map((m) => [m.kind, m.day]),
    [
      ["weight", "2026-10-26"],
      ["supplement", "2026-10-26"],
      ["weight", "2026-10-26"],
      ["glucose", "2026-10-25"],
      ["blood_pressure", "2026-10-25"],
      ["weight", "2026-10-24"],
    ],
    "newest first, local days",
  );
  const w = all[0];
  assert.deepEqual([w.value, w.unit, w.notes, w.createdBy], [81.6, "kg", "after the run", "user"]);
  const supp = all.find((m) => m.kind === "supplement")!;
  assert.deepEqual([supp.value, supp.text, supp.unit], [null, "Vitamin D 2000 IU", null], "a text kind keeps no number");
  assert.equal(all.find((m) => m.id === late)!.day, "2026-10-25");

  assert.equal(fmtMeasurement(w), "81.6 kg");
  assert.equal(fmtMeasurement(all.find((m) => m.kind === "blood_pressure")!), "128/82 mmHg");
  assert.equal(fmtMeasurement(supp), "Vitamin D 2000 IU");
  assert.equal(fmtMeasurement({ value: 18.5, value2: null, text: null, unit: "%" }), "18.5%");

  const kinds = await measurementKinds(db);
  assert.deepEqual(
    kinds.map((k) => [k.kind, k.count, k.latest.value ?? k.latest.text]),
    [
      ["weight", 3, 81.6],
      ["supplement", 1, "Vitamin D 2000 IU"],
      ["glucose", 1, 5.4],
      ["blood_pressure", 1, 128],
    ],
    "most recently used first, with the latest entry",
  );

  const s = await measurementSeries(db, "weight", "2026-10-23", TODAY);
  assert.deepEqual(s.days, ["2026-10-23", "2026-10-24", "2026-10-25", "2026-10-26"]);
  assert.deepEqual(s.values, [null, 82.4, null, 81.6], "the day's last entry, gaps as null");
  const bp = await measurementSeries(db, "blood_pressure", "2026-10-25", "2026-10-25");
  assert.deepEqual([bp.values, bp.values2], [[128], [82]]);

  // A weight logged here is the one the alcohol screen and the profile use.
  assert.deepEqual(await latestWeight(db, TODAY), { kg: 81.6, day: TODAY, source: "manual" });

  await deleteMeasurement(db, w.id, NOW);
  assert.equal((await listMeasurements(db, TODAY, TODAY, "weight")).length, 1);
  assert.equal((await latestWeight(db, TODAY))?.kg, 82);
  await restoreMeasurement(db, w.id, NOW);
  assert.equal((await latestWeight(db, TODAY))?.kg, 81.6, "undo puts it back");
});

test("kinds: presets have labels and units; unknown kinds read as words", () => {
  assert.deepEqual([presetFor("weight").unit, presetFor("blood_pressure").shape, presetFor("symptom").shape], ["kg", "pair", "text"]);
  assert.deepEqual(presetFor("ketones"), { kind: "ketones", label: "Ketones", shape: "number", unit: null });
  assert.equal(kindLabel("resting_hr"), "Resting heart rate");
  assert.equal(kindLabel("vo2_max_lab"), "Vo2 max lab");
});

test("day notes: one per day, created then edited in place; empty removes it; future days refused", async () => {
  const { db } = await migratedDb();
  await assert.rejects(saveDayNote(db, { day: "2026-10-27", mood: 3, energy: null, body: "" }, TODAY, NOW), /not happened yet/);
  await assert.rejects(saveDayNote(db, { day: TODAY, mood: 6, energy: null, body: "" }, TODAY, NOW));

  const a = await saveDayNote(db, { day: TODAY, mood: 4, energy: null, body: "  Good sleep.  " }, TODAY, NOW);
  assert.deepEqual([a?.mood, a?.energy, a?.body, a?.createdBy], [4, null, "Good sleep.", "user"]);
  const b = await saveDayNote(db, { day: TODAY, mood: 4, energy: 2, body: "Good sleep. Tired after lunch." }, TODAY, NOW + 1000);
  assert.equal(b?.id, a?.id, "the same row, edited");
  assert.equal(b?.updatedAtMs, NOW + 1000);
  const [{ n }] = await db.all<{ n: number }>("SELECT COUNT(*) AS n FROM day_notes");
  assert.equal(n, 1);

  // The chat adds notes for days without one; the owner then edits them here.
  await insertDayNote(db, { localDay: "2026-10-24", mood: 2, energy: 3, body: "Headache" }, { deviceId: "dev", createdBy: "assistant", now: NOW });
  const edited = await saveDayNote(db, { day: "2026-10-24", mood: 3, energy: 3, body: "Headache, better by evening" }, TODAY, NOW);
  assert.equal(edited?.createdBy, "assistant", "who created it stays on record");

  assert.deepEqual(
    (await listDayNotes(db, "2026-10-01", TODAY)).map((x) => x.day),
    [TODAY, "2026-10-24"],
  );

  assert.equal(await saveDayNote(db, { day: TODAY, mood: null, energy: null, body: "   " }, TODAY, NOW), null);
  assert.equal(await getDayNote(db, TODAY), null, "an emptied note is deleted");
  const again = await saveDayNote(db, { day: TODAY, mood: 5, energy: 5, body: "" }, TODAY, NOW);
  assert.ok(again, "a new note can follow a deleted one (the unique index is on live rows)");
  await deleteDayNote(db, again!.id, NOW);
  assert.equal(await getDayNote(db, TODAY), null);
});

test("dashboard check-in: the span's notes, average mood and energy, and the latest weight", async () => {
  const { db } = await migratedDb();
  await saveDayNote(db, { day: "2026-10-20", mood: 4, energy: 3, body: "" }, TODAY, NOW);
  await saveDayNote(db, { day: "2026-10-22", mood: 2, energy: null, body: "Bad night" }, TODAY, NOW);
  await addMeasurement(db, { kind: "weight", value: 80.5, atMs: at("2026-10-21", "07:00"), timeZone: TZ }, "user", NOW);
  await addMeasurement(db, { kind: "weight", value: 79.9, atMs: at("2026-10-26", "07:00"), timeZone: TZ }, "user", NOW);

  const week = await loadDashboard(db, "week", "2026-10-22", TODAY);
  assert.deepEqual(
    week.journal.notes.map((n) => n.day),
    ["2026-10-22", "2026-10-20"],
  );
  assert.deepEqual(week.journal.mood, { total: 6, avg: 3, daysWithData: 2 });
  assert.deepEqual(week.journal.energy, { total: 3, avg: 3, daysWithData: 1 });
  assert.deepEqual(week.journal.weight, { kg: 80.5, day: "2026-10-21", source: "manual" }, "the latest weight within the week, not after it");

  const day = await loadDashboard(db, "day", TODAY, TODAY);
  assert.deepEqual([day.journal.notes.length, day.journal.weight?.kg], [0, 79.9]);
});
