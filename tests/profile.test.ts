import test from "node:test";
import assert from "node:assert/strict";
import { bmr, calorieTarget, tdee } from "../src/core/health";
import { localDay } from "../src/core/tz";
import { setSetting } from "../src/db/settings";
import { TOOLS_BY_NAME } from "../src/features/chat/tools";
import { upsertSamples } from "../src/features/metrics/samples";
import { dataInventory } from "../src/features/settings/dataInventory";
import { EMPTY_PROFILE, estimates, loadProfile, PROFILE_KEY, saveProfile } from "../src/features/settings/profile";
import { migratedDb } from "./helpers";

const TODAY = "2026-10-26";
const full = { name: " Sam ", birthDate: "1990-03-15", sex: "male", heightCm: 178, activity: "moderate", kgPerWeek: -0.5 };

test("profile: saved, trimmed, read back; every field optional", async () => {
  const { db } = await migratedDb();
  assert.deepEqual(await loadProfile(db), EMPTY_PROFILE);
  const p = await saveProfile(db, full, TODAY, 1);
  assert.equal(p.name, "Sam");
  assert.deepEqual(await loadProfile(db), p);
  assert.deepEqual(await saveProfile(db, { name: "  " }, TODAY, 2), { ...EMPTY_PROFILE }, "blank name is no name");
});

test("profile: out-of-range values are refused with a message, nothing stored", async () => {
  const { db } = await migratedDb();
  await saveProfile(db, full, TODAY, 1);
  await assert.rejects(saveProfile(db, { ...full, heightCm: 300 }, TODAY), /between 120 and 230 cm/);
  await assert.rejects(saveProfile(db, { ...full, heightCm: NaN }, TODAY));
  await assert.rejects(saveProfile(db, { ...full, kgPerWeek: -2 }, TODAY), /1 kg a week/);
  await assert.rejects(saveProfile(db, { ...full, birthDate: "2015-01-01" }, TODAY), /between 16 and 110/);
  await assert.rejects(saveProfile(db, { ...full, birthDate: "2027-01-01" }, TODAY), /after the day/);
  await assert.rejects(saveProfile(db, { ...full, sex: "other" }, TODAY));
  assert.equal((await loadProfile(db)).heightCm, 178, "the earlier profile is untouched");
});

test("profile: a damaged stored value never locks Settings", async () => {
  const { db } = await migratedDb();
  await setSetting(db, PROFILE_KEY, "{not json", 1);
  assert.deepEqual(await loadProfile(db), EMPTY_PROFILE);
  await setSetting(db, PROFILE_KEY, JSON.stringify({ heightCm: 9999 }), 2);
  assert.deepEqual(await loadProfile(db), EMPTY_PROFILE);
});

test("estimates use the core formulas and say what is missing", async () => {
  const { db } = await migratedDb();
  const p = await saveProfile(db, full, TODAY);
  const e = estimates(p, 80, TODAY);
  const person = { sex: "male" as const, ageYears: 36, heightCm: 178, weightKg: 80 };
  assert.equal(e.ageYears, 36);
  assert.deepEqual(e.bmi, { value: 25.2, class: "overweight" });
  assert.equal(e.bmrKcal, Math.round(bmr(person)));
  assert.equal(e.tdeeKcal, Math.round(tdee(person, "moderate")));
  assert.deepEqual(e.target, calorieTarget(person, "moderate", -0.5));
  assert.equal(e.proteinG, 128);
  assert.deepEqual(e.missing, []);

  const partial = estimates({ ...EMPTY_PROFILE, heightCm: 178 }, null, TODAY);
  assert.deepEqual(partial.missing, ["birth date", "sex", "activity level", "weight"]);
  assert.equal(partial.bmrKcal, null);
  assert.ok(partial.healthyWeight, "height alone gives the healthy weight range");
  assert.equal(estimates({ ...p, activity: null }, 80, TODAY).tdeeKcal, null);
});

test("get_profile gives Claude age and estimates, never the name or birth date", async () => {
  const { db } = await migratedDb();
  const today = localDay(Date.now(), Intl.DateTimeFormat().resolvedOptions().timeZone);
  await saveProfile(db, full, today);
  const t = Date.now() - 86_400_000;
  await upsertSamples(db, [{ source: "garmin", device: "", externalId: "w1", metric: "body_weightInGrams", startMs: t, endMs: t, offsetMin: 0, valueNum: 80_000, unit: "grams" }]);
  const tool = TOOLS_BY_NAME.get("get_profile")!;
  assert.equal(tool.dataClass, "aggregate");
  const out = await tool.run(db, {});
  const r = out.result as Record<string, unknown>;
  assert.equal(r.sex, "male");
  assert.equal(r.height_cm, 178);
  assert.deepEqual((r.latest_weight as { kg: number }).kg, 80);
  assert.equal(typeof r.target_kcal, "number");
  assert.deepEqual(r.missing, []);
  const text = JSON.stringify(out);
  assert.doesNotMatch(text, /Sam|1990-03-15/, "data minimisation: no name, no birth date");

  const { db: empty } = await migratedDb();
  const none = (await tool.run(empty, {})).result as { missing: string[]; bmr_kcal: null };
  assert.equal(none.bmr_kcal, null);
  assert.deepEqual(none.missing, ["birth date", "sex", "height", "activity level", "weight"]);
});

test("data inventory reads every table of the real schema", async () => {
  const { db } = await migratedDb();
  const empty = await dataInventory(db);
  assert.ok(empty.length >= 8);
  assert.ok(empty.every((r) => r.count === 0 && r.from === null));
  const t = Date.UTC(2026, 9, 20, 10);
  await upsertSamples(db, [
    { source: "garmin", device: "", externalId: "a", metric: "daily_steps", startMs: t, endMs: t, offsetMin: 0, valueNum: 1 },
    { source: "garmin", device: "", externalId: "b", metric: "daily_steps", startMs: t + 3 * 86_400_000, endMs: t, offsetMin: 0, valueNum: 2 },
  ]);
  const readings = (await dataInventory(db)).find((r) => r.label.startsWith("Health readings"))!;
  assert.deepEqual(readings, { label: readings.label, count: 2, from: "2026-10-20", to: "2026-10-23" });
});
