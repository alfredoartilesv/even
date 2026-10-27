// zod/mini: the Dashboard loads the profile at start-up, and full zod was a sixth of that code.
import { z } from "zod/mini";
import {
  ACTIVITY_FACTORS,
  ageOn,
  bmi,
  bmiClass,
  bmr,
  calorieTarget,
  healthyWeightRange,
  proteinTarget,
  tdee,
  type ActivityLevel,
  type BmiClass,
  type Sex,
} from "../../core/health";
import { createLogger } from "../../core/log";
import type { SqlDriver } from "../../db/driver";
import { getSetting, setSetting } from "../../db/settings";
import { SPORT_IDS } from "../me/sports";

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
const HEIGHT = "Height must be between 120 and 230 cm";
export const profileSchema = z.object({
  name: z._default(z.nullable(z.string().check(z.trim(), z.maxLength(60))), null),
  birthDate: z._default(z.nullable(z.string().check(z.regex(DAY, "Birth date must be a date"))), null),
  sex: z._default(z.nullable(z.enum(["male", "female"])), null),
  heightCm: z._default(z.nullable(z.number().check(z.minimum(120, HEIGHT), z.maximum(230, HEIGHT))), null),
  activity: z._default(z.nullable(z.enum(ACTIVITY_LEVELS as [ActivityLevel, ...ActivityLevel[]])), null),
  /** Wanted weight change per week, negative to lose. */
  kgPerWeek: z._default(z.number().check(z.minimum(-1, "At most 1 kg a week"), z.maximum(1, "At most 1 kg a week")), 0),
  /** Sports the owner calls theirs, in their order; shown first on the Me tab. */
  sports: z._default(z.array(z.enum(SPORT_IDS)).check(z.maxLength(SPORT_IDS.length)), []),
});

export type Profile = z.infer<typeof profileSchema>;

export const EMPTY_PROFILE: Profile = profileSchema.parse({});

/**
 * Reads started while one is still running share it: at start-up the Dashboard and its profile
 * picture both ask. Nothing is kept once it settles, so a read after a save sees the save.
 */
const reading = new WeakMap<SqlDriver, Promise<Profile>>();

export function loadProfile(db: SqlDriver): Promise<Profile> {
  let p = reading.get(db);
  if (!p) {
    p = readProfile(db).finally(() => reading.delete(db));
    reading.set(db, p);
  }
  return p;
}

async function readProfile(db: SqlDriver): Promise<Profile> {
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
  log.info("profile saved", {
    fields: Object.entries(p)
      .filter(([, v]) => v !== null)
      .map(([k]) => k),
  });
  return p;
}

/** The profile picture: a small JPEG data URL, its own setting so the profile JSON stays small. */
export const PHOTO_KEY = "profile.photo";
const MAX_PHOTO_CHARS = 200_000;

export async function loadProfilePhoto(db: SqlDriver): Promise<string | null> {
  const v = await getSetting(db, PHOTO_KEY);
  return v && v.startsWith("data:image/jpeg;base64,") ? v : null;
}

/** What the round picture needs: the photo, or the name for its initials. */
export async function loadIdentity(db: SqlDriver): Promise<{ photo: string | null; name: string | null }> {
  const [photo, p] = await Promise.all([loadProfilePhoto(db), loadProfile(db)]);
  return { photo, name: p.name };
}

/** Stores a JPEG data URL (the screen downscales it first); empty or null removes the picture. */
export async function saveProfilePhoto(db: SqlDriver, dataUrl: string | null, nowMs: number = Date.now()): Promise<void> {
  if (dataUrl && !dataUrl.startsWith("data:image/jpeg;base64,")) throw new Error("The picture must be a JPEG image");
  if (dataUrl && dataUrl.length > MAX_PHOTO_CHARS) throw new Error("The picture is too large");
  await setSetting(db, PHOTO_KEY, dataUrl ?? "", nowMs);
  log.info(dataUrl ? "profile picture saved" : "profile picture removed", { kb: dataUrl ? Math.round(dataUrl.length / 1024) : 0 });
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
  const person =
    ageYears !== null && p.sex && p.heightCm !== null && weightKg !== null ? { sex: p.sex as Sex, ageYears, heightCm: p.heightCm, weightKg } : null;
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
