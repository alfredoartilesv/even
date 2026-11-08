import type { SqlDriver } from "../../db/driver";
import { deviceId } from "../../db/settings";
import { getNutritionTargets, setNutritionTarget, type Nutrient } from "../food/food";
import { insertGoal, type GoalInput } from "../journal/journal";
import { deleteGoal, listGoals, type Goal } from "./goals";

/**
 * You > Targets (handoff 0.7): the six everyday targets as numbers to step up and down, saved as
 * they change. Calories and macros are the food log's daily targets; steps a day and drinks a week
 * are goals like any other, so they also show with their progress among the goals.
 */
export type TargetKey = "kcal" | "protein" | "carbs" | "fat" | "steps" | "drinks";

export type DailyTargets = Record<TargetKey, number | null>;

const NUTRIENT: Partial<Record<TargetKey, Nutrient>> = { kcal: "calories", protein: "proteinG", carbs: "carbsG", fat: "fatG" };

const isSteps = (g: Goal) => g.metric === "daily_steps" && g.period === "day" && g.comparator === ">=";
const isDrinks = (g: Goal) => g.targetKind === "drink" && g.metric === "drinks" && g.period === "week" && g.comparator === "<=";

export async function loadTargets(db: SqlDriver, today: string): Promise<DailyTargets> {
  const [n, goals] = await Promise.all([getNutritionTargets(db), listGoals(db, today)]);
  const last = (f: (g: Goal) => boolean) => goals.filter(f).at(-1)?.targetNum ?? null;
  return { kcal: n.calories, protein: n.proteinG, carbs: n.carbsG, fat: n.fatG, steps: last(isSteps), drinks: last(isDrinks) };
}

/** Set one target (null removes it). A steps or drinks goal is replaced by a new one from today. */
export async function setTarget(db: SqlDriver, key: TargetKey, value: number | null, today: string, nowMs: number = Date.now()): Promise<void> {
  const nutrient = NUTRIENT[key];
  if (nutrient) return setNutritionTarget(db, nutrient, value, today, nowMs);
  const goals = await listGoals(db, today);
  const old = goals.filter(key === "steps" ? isSteps : isDrinks);
  if (old.length && old.at(-1)!.targetNum === value) return;
  for (const g of old) await deleteGoal(db, g.id, nowMs);
  if (value === null) return;
  const input: GoalInput =
    key === "steps"
      ? {
          title: `${value.toLocaleString("en")} steps a day`,
          targetKind: "sample",
          metric: "daily_steps",
          comparator: ">=",
          targetNum: value,
          unit: "steps",
          period: "day",
          startDay: today,
        }
      : {
          title: `At most ${value} drinks a week`,
          targetKind: "drink",
          metric: "drinks",
          comparator: "<=",
          targetNum: value,
          unit: "drinks",
          period: "week",
          startDay: today,
        };
  await insertGoal(db, input, { deviceId: await deviceId(db, nowMs), createdBy: "user", now: nowMs });
}
