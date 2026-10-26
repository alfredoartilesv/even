import { useCallback, useEffect, useState } from "react";
import type { SqlDriver } from "../../../db/driver";
import { listTags } from "../mealPrep";
import { TagChips } from "../../../ui/common";
import { PageHeader, SubTabs, type Choice } from "../../../ui/layout";
import { HistoryView } from "../../food/ui/HistoryView";
import { SavedView } from "../../food/ui/SavedView";
import { TodayView } from "../../food/ui/TodayView";
import { RecipesView } from "./RecipesView";
import { ShoppingView } from "./ShoppingView";
import { StockView } from "./StockView";

export type MealPrepView = "log" | "history" | "saved" | "stock" | "recipes" | "shopping";

export const MEAL_PREP_VIEWS: Choice<MealPrepView>[] = [
  { id: "log", label: "Log food" },
  { id: "history", label: "History" },
  { id: "saved", label: "Saved meals" },
  { id: "stock", label: "Stock" },
  { id: "recipes", label: "Recipes" },
  { id: "shopping", label: "Shopping" },
];

interface Props {
  db: SqlDriver;
  /** Owned by the app shell, so the Dashboard's "Log food" opens the log. */
  view: MealPrepView;
  onView: (view: MealPrepView) => void;
  /** Bumped after changes elsewhere (sync, chat). */
  version: number;
  /** After any write here, so the Dashboard reloads. */
  onChanged: () => void;
}

/**
 * The third tab: everything about eating. Log what you eat (today, past days, saved meals), and
 * the meal prep: what is in stock and what to defrost, recipes, and the shopping list.
 */
export function MealPrepScreen({ db, view, onView, version, onChanged }: Props) {
  const [tags, setTags] = useState<string[]>([]);
  const [tag, setTag] = useState<string | null>(null);
  // Bumped after any write so the other views reload when opened.
  const [local, setLocal] = useState(0);
  const changed = () => {
    setLocal((v) => v + 1);
    onChanged();
  };
  const v = version + local;

  const loadTags = useCallback(async () => {
    const t = (await listTags(db)).map((r) => r.tag);
    setTags(t);
    setTag((cur) => (cur && !t.includes(cur) ? null : cur));
  }, [db]);

  useEffect(() => {
    void loadTags();
  }, [loadTags, v]);

  return (
    <section>
      <PageHeader title="Meal prep" />
      <SubTabs items={MEAL_PREP_VIEWS} value={view} onChange={onView} label="Meal prep views" />
      {(view === "stock" || view === "recipes") && <TagChips tags={tags} value={tag} onChange={setTag} />}
      {view === "log" && <TodayView db={db} version={v} onChanged={changed} />}
      {view === "history" && <HistoryView db={db} version={v} onChanged={changed} />}
      {view === "saved" && <SavedView db={db} version={v} onChanged={changed} />}
      {view === "stock" && <StockView db={db} tag={tag} version={v} />}
      {view === "recipes" && <RecipesView db={db} tag={tag} allTags={tags} version={v} onChanged={changed} />}
      {view === "shopping" && <ShoppingView db={db} version={v} />}
    </section>
  );
}
