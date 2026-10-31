import type { SqlDriver } from "../../db/driver.js";
import { addDays, localDay } from "../../core/tz.js";
import { TOOLS_BY_NAME } from "./tools.js";

/**
 * What the assistant knows before the first question: the answers it would otherwise ask for in
 * its first tool rounds (which metrics exist, the profile and targets, goals, today's food and the
 * last week). One block in the conversation's first message instead of three or four extra
 * requests, each re-sending the whole prompt; later questions reuse it from the cached prefix.
 *
 * Only aggregate tools, so it needs no consent beyond claude.aggregates, which every chat needs.
 * Sent once per conversation (the history is append-only): a long chat keeps its first snapshot,
 * and the tools give fresh numbers.
 */
export const CONTEXT_TOOLS = ["list_metrics", "get_profile", "list_goals", "nutrition_summary", "workout_summary", "meal_prep_stock"] as const;

export interface ContextSnapshot {
  /** The [App] text block for the first message. */
  text: string;
  /** For the disclosure log: what was included, and the exact payload. */
  summary: string;
  payload: string;
}

export async function contextSnapshot(db: SqlDriver, nowMs: number, timeZone: string): Promise<ContextSnapshot> {
  const today = localDay(nowMs, timeZone);
  const week = { from: addDays(today, -6), to: today };
  const inputs: Record<(typeof CONTEXT_TOOLS)[number], unknown> = {
    list_metrics: {},
    get_profile: {},
    list_goals: {},
    nutrition_summary: { from: today, to: today },
    workout_summary: week,
    meal_prep_stock: {},
  };
  const parts: Record<string, unknown> = {};
  const included: string[] = [];
  for (const name of CONTEXT_TOOLS) {
    const tool = TOOLS_BY_NAME.get(name)!;
    try {
      const out = await tool.run(db, inputs[name]);
      parts[name === "nutrition_summary" ? "food_today" : name === "workout_summary" ? "workouts_last_7_days" : name] = out.result;
      included.push(name);
    } catch {
      // A part that cannot be read (an empty or older database) is left out; the tool is still there to call.
    }
  }
  const payload = JSON.stringify(parts);
  return {
    text: `[App] Snapshot of the owner's data when this chat started (same shape as the tools of the same name; call them for other dates or fresher numbers): ${payload}`,
    summary: `Chat context: ${included.join(", ")}`,
    payload,
  };
}
