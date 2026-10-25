import test from "node:test";
import assert from "node:assert/strict";
import {
  ageOn,
  alcoholGrams,
  bmi,
  bmiClass,
  bmr,
  calorieTarget,
  healthyWeightRange,
  heartRateZones,
  kcalFromMacros,
  kgPerWeekFromBalance,
  macroSplit,
  maxHeartRate,
  mean,
  proteinTarget,
  rollingAverage,
  slopePerDay,
  smoothed,
  standardDrinks,
  tdee,
} from "../src/lib/health";

const him = { sex: "male" as const, weightKg: 80, heightCm: 180, ageYears: 30 };
const her = { sex: "female" as const, weightKg: 60, heightCm: 165, ageYears: 30 };

test("age in whole years, birthday counted on the day", () => {
  assert.equal(ageOn("1990-10-26", "2026-10-25"), 35);
  assert.equal(ageOn("1990-10-25", "2026-10-25"), 36);
  assert.equal(ageOn("2000-02-29", "2026-02-28"), 25);
  assert.throws(() => ageOn("2030-01-01", "2026-01-01"), /after/);
  assert.throws(() => ageOn("1990/1/1", "2026-01-01"), /YYYY-MM-DD/);
});

test("BMI, WHO classes and healthy range", () => {
  assert.equal(Math.round(bmi(80, 180) * 100) / 100, 24.69);
  assert.deepEqual([18.4, 18.5, 24.99, 25, 30].map(bmiClass), ["underweight", "healthy", "healthy", "overweight", "obese"]);
  assert.deepEqual(healthyWeightRange(180), { minKg: 59.9, maxKg: 80.7 });
  assert.throws(() => bmi(80, 0), /Height/);
});

test("BMR (Mifflin-St Jeor), TDEE and calorie target with the BMR floor", () => {
  assert.equal(bmr(him), 1780);
  assert.equal(bmr(her), 1320.25);
  assert.equal(tdee(him, "moderate"), 2759);
  assert.equal(Math.round(tdee(her, "sedentary")), 1584);
  assert.deepEqual(calorieTarget(him, "moderate", -0.5), { kcal: 2210, floored: false });
  assert.deepEqual(calorieTarget(him, "moderate", 0), { kcal: 2760, floored: false });
  assert.deepEqual(calorieTarget(him, "moderate", -2), { kcal: 1780, floored: true });
  assert.equal(kgPerWeekFromBalance(-550), -0.5);
  assert.throws(() => bmr({ ...him, ageYears: 0 }), /Age/);
});

test("energy from macros and the split", () => {
  assert.equal(kcalFromMacros({ proteinG: 30, carbsG: 80, fatG: 20 }), 620);
  assert.equal(kcalFromMacros({ proteinG: 30, carbsG: 80, fatG: 20, alcoholG: 10 }), 690);
  assert.equal(kcalFromMacros({ proteinG: 10, carbsG: null }), 40);
  assert.equal(kcalFromMacros({}), null);
  assert.deepEqual(macroSplit({ proteinG: 25, carbsG: 50, fatG: 0 }), { protein: 33.3, carbs: 66.7, fat: 0, alcohol: 0 });
  assert.equal(macroSplit({}), null);
  assert.equal(proteinTarget(80), 128);
  assert.equal(proteinTarget(80, 0.8), 64);
});

test("alcohol grams and standard drinks", () => {
  const beer = alcoholGrams(330, 5);
  assert.equal(Math.round(beer * 100) / 100, 13.02);
  assert.equal(Math.round(standardDrinks(beer) * 10) / 10, 1.3);
  assert.equal(Math.round(standardDrinks(beer, "US") * 100) / 100, 0.93);
  assert.throws(() => alcoholGrams(330, 120), /ABV/);
});

test("max heart rate (Tanaka) and zones, with and without resting rate", () => {
  assert.equal(maxHeartRate(30), 187);
  const pct = heartRateZones(187);
  assert.deepEqual(pct[0], { zone: 1, minBpm: 94, maxBpm: 112 });
  assert.deepEqual(pct[4], { zone: 5, minBpm: 168, maxBpm: 187 });
  const karvonen = heartRateZones(187, 60);
  assert.deepEqual(karvonen[0], { zone: 1, minBpm: 124, maxBpm: 136 });
  assert.equal(karvonen[4].maxBpm, 187);
  assert.throws(() => heartRateZones(187, 190), /below/);
});

test("series: mean, slope over calendar days, rolling average with gaps, smoothing", () => {
  assert.equal(mean([]), null);
  assert.equal(mean([1, 2, NaN, 3]), 2);
  assert.equal(slopePerDay([{ day: "2026-10-20", value: 0 }, { day: "2026-10-22", value: 2 }]), 1);
  assert.equal(slopePerDay([{ day: "2026-10-20", value: 5 }]), 0);
  // Over a DST change the slope still counts calendar days.
  assert.equal(slopePerDay([{ day: "2026-10-24", value: 80 }, { day: "2026-10-26", value: 79 }]), -0.5);
  assert.deepEqual(
    rollingAverage(
      [
        { day: "2026-10-20", value: 1 },
        { day: "2026-10-21", value: 3 },
        { day: "2026-10-25", value: 5 },
      ],
      3,
    ).map((p) => p.value),
    [1, 2, 5],
  );
  assert.deepEqual(
    smoothed(
      [
        { day: "a", value: 10 },
        { day: "b", value: 20 },
        { day: "c", value: 20 },
      ],
      0.5,
    ).map((p) => p.value),
    [10, 15, 17.5],
  );
  assert.throws(() => smoothed([], 0), /alpha/);
});
