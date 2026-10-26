import { z } from "zod";
import { ACTIVITY_FACTORS, ageOn, bmi, bmiClass, bmr, calorieTarget, healthyWeightRange, proteinTarget, tdee, type ActivityLevel, type BmiClass, type Sex } from "../../core/health";
import { createLogger } from "../../core/log";
import type { SqlDriver } from "../../db/driver";
import { getSetting, setSetting } from "../../db/settings";

/**
 * The owner's profile: what the energy and body calculations need (birth date, sex, height,
 * activity level, weight goal) and a name to address them by. One JSON value in app_settings,
 * so it travels with the backup. Weight is not stored here: it comes from the latest weigh-in
 * (synced or manual), so it is never stale.
 */

const log = createLogger("settings.profile");

export const PROFILE_KEY = "profile";
export const ACTIVITY_LEVELS = Object.keys(ACTIVITY_FACTORS) as ActivityLevel[];

export const ACTIVITY_LABEL: Record<ActivityLevel, string> = {
  sedentary: "Sedentary: desk job, little exercise",
  light: "Light: exercise 1 to 3 days a week",
  moderate: "Moderate: exercise 3 to 5 days a week",
  active: "Active: exercise 6 to 7 days a week",
  very_active: "Very active: hard training or a physical job",
};

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Every field optional: the owner fills in what they want, and estimates appear once enough is there. */
export const profileSchema = z.object({
  name: z.string().trim().max(60).nullable().default(null),
  birthDate: z.string().regex(DAY, "Birth date must be a date").nullable().default(null),
  sex: z.enum(["male", "female"]).nullable().default(null),
  heightCm: z.number().min(120, "Height must be between 120 and 230 cm").max(230, "Height must be between 120 and 230 cm").nullable().default(null),
  activity: z.enum(ACTIVITY_LEVELS as [ActivityLevel, ...ActivityLevel[]]).nullable().default(null),
  /** Wanted weight change per week, negative to lose. */
  kgPerWeek: z.number().min(-1, "At most 1 kg a week").max(1, "At most 1 kg a week").default(0),
});

export type Profile = z.infer<typeof profileSchema>;

export const EMPTY_PROFILE: Profile = profileSchema.parse({});

export async function loadProfile(db: SqlDriver): Promise<Profile> {
  const raw = await getSetting(db, PROFILE_KEY);
  if (!raw) return EMPTY_PROFILE;
  try {
    return profileSchema.parse(JSON.parse(raw));
  } catch (err) {
    // A damaged value must not lock the owner out of Settings: start empty and say so in the log.
    log.warn("stored profile unreadable, using an empty one", { err });
    return EMPTY_PROFILE;
  }
}

/** Validate and store. Throws a message safe to show for a value out of range. */
export async function saveProfile(db: SqlDriver, input: unknown, today: string, nowMs: number = Date.now()): Promise<Profile> {
  const res = profileSchema.safeParse(input);
  if (!res.success) throw new Error(res.error.issues[0].message);
  const p = { ...res.data, name: res.data.name || null };
  if (p.birthDate) {
    const age = ageOn(p.birthDate, today); // throws for a date after today
    if (age < 16 || age > 110) throw new Error("Age must be between 16 and 110 for the estimates");
  }
  await setSetting(db, PROFILE_KEY, JSON.stringify(p), nowMs);
  log.info("profile saved", { fields: Object.entries(p).filter(([, v]) => v !== null).map(([k]) => k) });
  return p;
}

export interface Estimates {
  ageYears: number | null;
  bmi: { value: number; class: BmiClass } | null;
  healthyWeight: { minKg: number; maxKg: number } | null;
  bmrKcal: number | null;
  tdeeKcal: number | null;
  target: { kcal: number; floored: boolean } | null;
  proteinG: number | null;
  /** Profile fields still needed for the energy figures. */
  missing: ("birth date" | "sex" | "height" | "activity level" | "weight")[];
}

/** What the profile and the latest weight allow: each figure is null until its inputs are there. */
export function estimates(p: Profile, weightKg: number | null, today: string): Estimates {
  const ageYears = p.birthDate ? ageOn(p.birthDate, today) : null;
  const missing: Estimates["missing"] = [];
  if (ageYears === null) missing.push("birth date");
  if (!p.sex) missing.push("sex");
  if (p.heightCm === null) missing.push("height");
  if (!p.activity) missing.push("activity level");
  if (weightKg === null) missing.push("weight");

  const b = weightKg !== null && p.heightCm !== null ? bmi(weightKg, p.heightCm) : null;
  const person = ageYears !== null && p.sex && p.heightCm !== null && weightKg !== null ? { sex: p.sex as Sex, ageYears, heightCm: p.heightCm, weightKg } : null;
  return {
    ageYears,
    bmi: b === null ? null : { value: Math.round(b * 10) / 10, class: bmiClass(b) },
    healthyWeight: p.heightCm !== null ? healthyWeightRange(p.heightCm) : null,
    bmrKcal: person ? Math.round(bmr(person)) : null,
    tdeeKcal: person && p.activity ? Math.round(tdee(person, p.activity)) : null,
    target: person && p.activity ? calorieTarget(person, p.activity, p.kgPerWeek) : null,
    proteinG: weightKg !== null ? proteinTarget(weightKg) : null,
    missing,
  };
}
