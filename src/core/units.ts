/**
 * Heights and weights in the owner's units (profile heightUnit, weightUnit). Data is always
 * stored in cm and kg; these only change what is shown and what a stepper moves by. Pure.
 */

export type HeightUnit = "cm" | "ftin";
export type WeightUnit = "kg" | "lb";

export const LB_PER_KG = 2.20462;
const CM_PER_IN = 2.54;

export function fmtHeight(cm: number, unit: HeightUnit): string {
  if (unit === "cm") return `${Math.round(cm)} cm`;
  const inches = Math.round(cm / CM_PER_IN);
  return `${Math.floor(inches / 12)} ft ${inches % 12} in`;
}

export function fmtWeight(kg: number, unit: WeightUnit): string {
  return unit === "kg" ? `${kg.toFixed(1)} kg` : `${(kg * LB_PER_KG).toFixed(1)} lb`;
}

/** One step of a height stepper, in cm: a centimetre, or an inch. */
export const heightStepCm = (unit: HeightUnit) => (unit === "cm" ? 1 : CM_PER_IN);

/** One step of a weight stepper, in kg: 0.1 kg, or 0.2 lb. */
export const weightStepKg = (unit: WeightUnit) => (unit === "kg" ? 0.1 : 0.2 / LB_PER_KG);
