import type { GoalInput } from "../journal/journal";
import type { Goal } from "./goals";
import { fmtDuration } from "./workouts";

/**
 * Ready-made goals the owner fills with one number, and how goal values read. Metric names are
 * the ones the Garmin sync and the Garmin import use (daily_steps, sleep_durationInSeconds,
 * body_weightInGrams). Pure.
 */

export interface GoalTemplate {
  id: string;
  label: string;
  /** What the one number means, in the unit the owner thinks in. */
  ask: string;
  defaultValue: number;
  min: number;
  max: number;
  build(value: number, startDay: string): GoalInput;
}

const fmt = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 1 });

export const GOAL_TEMPLATES: GoalTemplate[] = [
  {
    id: "steps",
    label: "Steps a day",
    ask: "Steps",
    defaultValue: 10000,
    min: 1000,
    max: 50000,
    build: (v, startDay) => ({ title: `${fmt(v)} steps a day`, targetKind: "sample", metric: "daily_steps", comparator: ">=", targetNum: v, unit: "steps", period: "day", startDay }),
  },
  {
    id: "sleep",
    label: "Sleep a night",
    ask: "Hours",
    defaultValue: 7.5,
    min: 4,
    max: 12,
    build: (v, startDay) => ({ title: `Sleep ${fmt(v)} h a night`, targetKind: "sample", metric: "sleep_durationInSeconds", comparator: ">=", targetNum: Math.round(v * 3600), unit: "seconds", period: "day", startDay }),
  },
  {
    id: "protein",
    label: "Protein a day",
    ask: "Grams",
    defaultValue: 120,
    min: 20,
    max: 400,
    build: (v, startDay) => ({ title: `${fmt(v)} g protein a day`, targetKind: "food", metric: "protein_g", comparator: ">=", targetNum: v, unit: "g", period: "day", startDay }),
  },
  {
    id: "alcohol",
    label: "Alcohol limit a week",
    ask: "Grams of alcohol (a beer is about 13)",
    defaultValue: 70,
    min: 0,
    max: 500,
    build: (v, startDay) => ({ title: `At most ${fmt(v)} g alcohol a week`, targetKind: "drink", metric: "alcohol_g", comparator: "<=", targetNum: v, unit: "g", period: "week", startDay }),
  },
  {
    id: "weight",
    label: "Target weight",
    ask: "Kilograms",
    defaultValue: 80,
    min: 30,
    max: 300,
    build: (v, startDay) => ({ title: `Weigh ${fmt(v)} kg or less`, targetKind: "sample", metric: "body_weightInGrams", comparator: "<=", targetNum: Math.round(v * 1000), unit: "grams", period: "week", startDay }),
  },
];

/** A goal's number as the owner reads it: hours for seconds, kg for body weight, grouped thousands. */
export function fmtGoalValue(g: Pick<Goal, "metric" | "unit">, v: number): string {
  const unit = (g.unit ?? "").toLowerCase();
  if (unit === "seconds" || unit === "s") return fmtDuration(v);
  if ((unit === "grams" || unit === "g") && g.metric?.startsWith("body_")) return `${(v / 1000).toFixed(1)} kg`;
  if (unit === "meters" || unit === "m") return v >= 1000 ? `${fmt(v / 1000)} km` : `${Math.round(v)} m`;
  const n = Math.abs(v) >= 100 ? Math.round(v).toLocaleString() : fmt(v);
  return unit && unit !== "steps" ? `${n} ${g.unit}` : unit === "steps" ? `${n} steps` : n;
}
