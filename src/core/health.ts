/**
 * Health calculations: energy, body, nutrition, alcohol, heart rate and series statistics.
 * Pure and dependency-free, so screens, the chat tools and tests share one definition.
 * Formulas are the standard population estimates; each says which one it uses.
 * Estimates for information, not medical advice.
 */

export type Sex = "male" | "female";

/** Physical activity level multipliers for TDEE (FAO/WHO style). */
export const ACTIVITY_FACTORS = {
  sedentary: 1.2, // desk job, little exercise
  light: 1.375, // exercise 1 to 3 days a week
  moderate: 1.55, // 3 to 5 days
  active: 1.725, // 6 to 7 days
  very_active: 1.9, // hard training or a physical job
} as const;
export type ActivityLevel = keyof typeof ACTIVITY_FACTORS;

/** kcal per gram (Atwater general factors). */
export const KCAL_PER_G = { protein: 4, carbs: 4, fat: 9, alcohol: 7 } as const;

/** Energy in 1 kg of body weight change, the usual planning figure. */
export const KCAL_PER_KG_BODY = 7700;

/** Density of ethanol, g/ml. */
export const ETHANOL_DENSITY = 0.789;

const DAY_MS = 86_400_000;

function positive(n: number, what: string): number {
  if (!Number.isFinite(n) || n <= 0) throw new RangeError(`${what} must be a positive number`);
  return n;
}

const round = (n: number, dp = 0) => {
  const k = 10 ** dp;
  return Math.round(n * k) / k;
};

// ---- Age ----

/** Whole years between a YYYY-MM-DD birth date and a YYYY-MM-DD day. */
export function ageOn(birthDay: string, day: string): number {
  const [by, bm, bd] = birthDay.split("-").map(Number);
  const [y, m, d] = day.split("-").map(Number);
  if ([by, bm, bd, y, m, d].some((v) => !Number.isInteger(v))) throw new RangeError("Dates must be YYYY-MM-DD");
  const age = y - by - (m < bm || (m === bm && d < bd) ? 1 : 0);
  if (age < 0) throw new RangeError("Birth date is after the day");
  return age;
}

// ---- Body ----

/** Body mass index, kg/m². */
export function bmi(weightKg: number, heightCm: number): number {
  const m = positive(heightCm, "Height") / 100;
  return positive(weightKg, "Weight") / (m * m);
}

export type BmiClass = "underweight" | "healthy" | "overweight" | "obese";

/** WHO adult classes. BMI does not tell fat from muscle: read it alongside other measures. */
export function bmiClass(value: number): BmiClass {
  if (value < 18.5) return "underweight";
  if (value < 25) return "healthy";
  if (value < 30) return "overweight";
  return "obese";
}

/** Weight range for the WHO healthy BMI band (18.5 to 24.9) at a height. */
export function healthyWeightRange(heightCm: number): { minKg: number; maxKg: number } {
  const m2 = (positive(heightCm, "Height") / 100) ** 2;
  return { minKg: round(18.5 * m2, 1), maxKg: round(24.9 * m2, 1) };
}

// ---- Energy ----

export interface Person {
  sex: Sex;
  weightKg: number;
  heightCm: number;
  ageYears: number;
}

/** Basal metabolic rate, kcal/day, Mifflin-St Jeor (1990). */
export function bmr(p: Person): number {
  positive(p.weightKg, "Weight");
  positive(p.heightCm, "Height");
  positive(p.ageYears, "Age");
  return 10 * p.weightKg + 6.25 * p.heightCm - 5 * p.ageYears + (p.sex === "male" ? 5 : -161);
}

/** Total daily energy expenditure, kcal/day: BMR times the activity factor. */
export function tdee(p: Person, activity: ActivityLevel): number {
  return bmr(p) * ACTIVITY_FACTORS[activity];
}

/**
 * Daily intake for a weight change of kgPerWeek (negative to lose), rounded to 10 kcal.
 * Never below BMR: a deeper cut is flagged instead of returned.
 */
export function calorieTarget(p: Person, activity: ActivityLevel, kgPerWeek: number): { kcal: number; floored: boolean } {
  if (!Number.isFinite(kgPerWeek)) throw new RangeError("kgPerWeek must be a number");
  const raw = tdee(p, activity) + (kgPerWeek * KCAL_PER_KG_BODY) / 7;
  const floor = bmr(p);
  return { kcal: round(Math.max(raw, floor) / 10) * 10, floored: raw < floor };
}

/**
 * Weight change a sustained daily balance implies, kg/week.
 * balance = intake - expenditure (negative = deficit).
 */
export const kgPerWeekFromBalance = (balanceKcalPerDay: number) => (balanceKcalPerDay * 7) / KCAL_PER_KG_BODY;

// ---- Nutrition ----

export interface MacroGrams {
  proteinG?: number | null;
  carbsG?: number | null;
  fatG?: number | null;
  alcoholG?: number | null;
}

/** Energy from macros, kcal. Null when no macro is known. */
export function kcalFromMacros(m: MacroGrams): number | null {
  const parts: [number | null | undefined, number][] = [
    [m.proteinG, KCAL_PER_G.protein],
    [m.carbsG, KCAL_PER_G.carbs],
    [m.fatG, KCAL_PER_G.fat],
    [m.alcoholG, KCAL_PER_G.alcohol],
  ];
  const known = parts.filter(([g]) => g != null && Number.isFinite(g));
  if (!known.length) return null;
  return known.reduce((s, [g, k]) => s + (g as number) * k, 0);
}

/** Share of energy from each macro, percent (adds up to 100 over the known ones). */
export function macroSplit(m: MacroGrams): { protein: number; carbs: number; fat: number; alcohol: number } | null {
  const total = kcalFromMacros(m);
  if (!total) return null;
  const pct = (g: number | null | undefined, k: number) => round((((g ?? 0) * k) / total) * 100, 1);
  return {
    protein: pct(m.proteinG, KCAL_PER_G.protein),
    carbs: pct(m.carbsG, KCAL_PER_G.carbs),
    fat: pct(m.fatG, KCAL_PER_G.fat),
    alcohol: pct(m.alcoholG, KCAL_PER_G.alcohol),
  };
}

/** Daily protein in grams at g/kg body weight. 0.8 is the adult minimum, 1.6 a common training figure. */
export function proteinTarget(weightKg: number, gPerKg = 1.6): number {
  return round(positive(weightKg, "Weight") * positive(gPerKg, "g/kg"));
}

// ---- Alcohol ----

/** Grams of ethanol in a drink. Same formula as the daily_alcohol view. */
export function alcoholGrams(volumeMl: number, abvPercent: number): number {
  if (!(volumeMl >= 0) || !(abvPercent >= 0 && abvPercent <= 100)) throw new RangeError("Volume must be 0 or more and ABV 0 to 100");
  return volumeMl * (abvPercent / 100) * ETHANOL_DENSITY;
}

/** Grams per standard drink in some countries. Spain counts 10 g, the US 14 g, the UK unit is 8 g. */
export const STANDARD_DRINK_G = { ES: 10, EU: 10, UK: 8, US: 14 } as const;

export function standardDrinks(grams: number, country: keyof typeof STANDARD_DRINK_G = "ES"): number {
  return grams / STANDARD_DRINK_G[country];
}

/**
 * kcal from the alcohol alone (7 kcal/g). Beer, cider and cocktails also carry sugar, so this
 * underestimates them: a real label value is better when there is one.
 */
export function alcoholKcal(volumeMl: number, abvPercent: number): number {
  return alcoholGrams(volumeMl, abvPercent) * KCAL_PER_G.alcohol;
}

/**
 * The weight implied by not having eaten or drunk `kcal` extra, assuming they were not made up
 * for elsewhere (7700 kcal per kg). An upper bound on the effect, not a prediction.
 */
export function weightWithoutKcal(currentKg: number, kcal: number): number {
  positive(currentKg, "Weight");
  if (!(kcal >= 0)) throw new RangeError("kcal must be 0 or more");
  return currentKg - kcal / KCAL_PER_KG_BODY;
}

// ---- Heart rate ----

/** Estimated maximum heart rate, Tanaka (2001): 208 - 0.7 x age. */
export function maxHeartRate(ageYears: number): number {
  return round(208 - 0.7 * positive(ageYears, "Age"));
}

export interface HrZone {
  zone: 1 | 2 | 3 | 4 | 5;
  minBpm: number;
  maxBpm: number;
}

/**
 * Five training zones at 50-60-70-80-90-100 % of intensity. With a resting rate they use the
 * heart rate reserve (Karvonen), otherwise a share of the maximum.
 */
export function heartRateZones(maxBpm: number, restingBpm?: number): HrZone[] {
  positive(maxBpm, "Max heart rate");
  const rest = restingBpm ?? 0;
  if (rest < 0 || rest >= maxBpm) throw new RangeError("Resting heart rate must be below the maximum");
  const at = (f: number) => round(rest + (maxBpm - rest) * f);
  return ([1, 2, 3, 4, 5] as const).map((zone) => ({ zone, minBpm: at(0.4 + zone * 0.1), maxBpm: at(0.5 + zone * 0.1) }));
}

// ---- Series ----

export interface DayPoint {
  day: string;
  value: number;
}

const dayNumber = (day: string) => Date.parse(`${day}T00:00:00Z`) / DAY_MS;

export function mean(values: number[]): number | null {
  const v = values.filter(Number.isFinite);
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
}

/** Least-squares slope of value over calendar days, units per day. 0 with fewer than 2 days. */
export function slopePerDay(points: DayPoint[]): number {
  if (points.length < 2) return 0;
  const xs = points.map((p) => dayNumber(p.day));
  const mx = mean(xs)!;
  const my = mean(points.map((p) => p.value))!;
  let num = 0;
  let den = 0;
  points.forEach((p, i) => {
    num += (xs[i] - mx) * (p.value - my);
    den += (xs[i] - mx) ** 2;
  });
  return den === 0 ? 0 : num / den;
}

/**
 * Trailing average over the last `days` calendar days (including the point's own day), one
 * output per input point. Gaps count as missing, not zero. Points must be sorted by day.
 */
export function rollingAverage(points: DayPoint[], days = 7): DayPoint[] {
  positive(days, "Window");
  return points.map((p, i) => {
    const start = dayNumber(p.day) - days + 1;
    const window: number[] = [];
    for (let j = i; j >= 0 && dayNumber(points[j].day) >= start; j--) window.push(points[j].value);
    return { day: p.day, value: mean(window)! };
  });
}

/**
 * Exponentially smoothed trend (the "trend weight" idea): each day moves alpha of the way
 * towards the new reading, so one salty dinner barely moves it. Points must be sorted by day.
 */
export function smoothed(points: DayPoint[], alpha = 0.1): DayPoint[] {
  if (!(alpha > 0 && alpha <= 1)) throw new RangeError("alpha must be in (0, 1]");
  let t: number | null = null;
  return points.map((p) => {
    t = t === null ? p.value : t + alpha * (p.value - t);
    return { day: p.day, value: t };
  });
}
