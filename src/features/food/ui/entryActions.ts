import type { SqlDriver } from "../../../db/driver";
import { deleteFood, relogFood, saveEntryAsMeal, updateFood, type FoodEntry } from "../food";
import { timeZone, type Msg } from "../../../ui/common";
import { parseDraft, type MealDraft } from "./components";

/** The EntryList handlers, shared by Today and History. */
export function entryActions(db: SqlDriver, reload: () => void, setMsg: (m: Msg) => void) {
  const run = async (fn: () => Promise<unknown>, ok: string) => {
    try {
      await fn();
      setMsg({ kind: "ok", text: ok });
      reload();
      return true;
    } catch (err) {
      setMsg({ kind: "error", text: (err as Error).message });
      return false;
    }
  };
  return {
    onAgain: (e: FoodEntry) => void run(() => relogFood(db, e.id, { timeZone: timeZone() }), `Logged ${e.name} again.`),
    onSave: (e: FoodEntry) =>
      e.savedMealId
        ? setMsg({ kind: "ok", text: `${e.name} is already saved. Change its photo or details in Saved.` })
        : void run(() => saveEntryAsMeal(db, e.id), `Saved ${e.name}. Add a photo in Saved.`),
    onUpdate: (e: FoodEntry, d: MealDraft) => run(() => updateFood(db, e.id, parseDraft(d)), "Updated."),
    onDelete: (e: FoodEntry) => {
      const extra = e.fromPrep ? " The meal prep portion goes back into stock." : "";
      if (confirm(`Delete ${e.name}?${extra}`)) void run(() => deleteFood(db, e.id), "Deleted.");
    },
  };
}
