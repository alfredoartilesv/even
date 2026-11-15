import type { SqlDriver } from "../../db/driver";
import { deleteFood, deleteSavedMeal, logTimeFor, relogFood, saveEntryAsMeal, updateFood, type FoodEntry } from "../../domain/food/food";
import { localDateTimeToMs } from "../../core/tz";
import { failed, timeZone, type Msg } from "../../ui/common";
import { parseDraft, type MealDraft } from "./components";

/**
 * The EntryList handlers. "Again" logs the entry once more on `day` (now when it is today, the
 * slot's usual time on a past day); an edit with a day and time moves the entry there.
 */
export function entryActions(db: SqlDriver, reload: () => void, setMsg: (m: Msg) => void, day: string) {
  const run = async (fn: () => Promise<unknown>, ok: string) => {
    try {
      await fn();
      setMsg({ kind: "ok", text: ok });
      reload();
      return true;
    } catch (err) {
      setMsg(failed(err, "food"));
      return false;
    }
  };
  return {
    onAgain: (e: FoodEntry) =>
      void run(
        () => relogFood(db, e.id, { timeZone: timeZone(), atMs: logTimeFor(day, e.meal === "prep" ? null : e.meal, timeZone()) }),
        `Logged ${e.name} again.`,
      ),
    onSave: (e: FoodEntry) =>
      // The star toggles: a starred meal always shows in Eat again, unstarring takes it out.
      e.savedMealId
        ? void run(() => deleteSavedMeal(db, e.savedMealId!), `Unstarred ${e.name}. Meals already logged stay.`)
        : void run(() => saveEntryAsMeal(db, e.id), `Starred ${e.name}. It now shows in Eat again.`),
    onUpdate: (e: FoodEntry, d: MealDraft) =>
      run(
        () => {
          const tz = timeZone();
          const at = !e.fromPrep && d.day && d.time ? localDateTimeToMs(d.day, d.time, tz).ms : undefined;
          return updateFood(db, e.id, { ...parseDraft(d), atMs: at, timeZone: tz });
        },
        d.day && d.day !== e.localDay ? "Updated and moved." : "Updated.",
      ),
    onDelete: (e: FoodEntry) => {
      const extra = e.fromPrep ? " The meal prep portion goes back into stock." : "";
      if (confirm(`Delete ${e.name}?${extra}`)) void run(() => deleteFood(db, e.id), "Deleted.");
    },
  };
}
