import type { SqlDriver } from "../../db/driver";
import { deviceId, getSetting, setSetting } from "../../db/settings";
import { setNutritionTarget } from "../food/food";
import { insertGoal } from "../journal/journal";
import { loadProfile } from "./profile";
import { loadClaudeKey, loadGarminKey, type SecretStore } from "./secrets";

/**
 * First run (screens/start/FirstRun): Connect, then About you and Targets, once per install. An
 * install that already has a profile or a key never sees it, so phones set up before 0.7 skip it.
 * Device-local: app_settings syncs only the profile.
 */
export const FIRST_RUN_KEY = "onboarding.done";

export async function needsFirstRun(db: SqlDriver, secrets: SecretStore): Promise<boolean> {
  if ((await getSetting(db, FIRST_RUN_KEY)) !== null) return false;
  const [profile, garmin, claude] = await Promise.all([loadProfile(db), loadGarminKey(secrets), loadClaudeKey(secrets)]);
  return !profile.name && profile.heightCm === null && !profile.birthDate && !garmin && !claude;
}

export async function finishFirstRun(db: SqlDriver, nowMs: number = Date.now()): Promise<void> {
  await setSetting(db, FIRST_RUN_KEY, String(nowMs), nowMs);
}

export interface FirstTargets {
  kcal: number;
  proteinG: number;
  /** Standard drinks a week, at most; 0 sets no limit. */
  drinksPerWeek: number;
}

/** Gentle starting points the Targets step opens with. */
export const FIRST_TARGETS: FirstTargets = { kcal: 2300, proteinG: 150, drinksPerWeek: 10 };

/**
 * The Targets step's three numbers as goals: the daily calorie and protein targets (as the food
 * log sets them) and a weekly limit of standard drinks. Each can be changed later in You > Targets.
 */
export async function saveFirstTargets(db: SqlDriver, t: FirstTargets, today: string, nowMs: number = Date.now()): Promise<void> {
  await setNutritionTarget(db, "calories", t.kcal, today, nowMs);
  await setNutritionTarget(db, "proteinG", t.proteinG, today, nowMs);
  if (t.drinksPerWeek > 0) {
    await insertGoal(
      db,
      {
        title: `At most ${t.drinksPerWeek} drinks a week`,
        targetKind: "drink",
        metric: "drinks",
        comparator: "<=",
        targetNum: t.drinksPerWeek,
        unit: "drinks",
        period: "week",
        startDay: today,
      },
      { deviceId: await deviceId(db, nowMs), createdBy: "user", now: nowMs },
    );
  }
}
