import { useCallback, useEffect, useState } from "react";
import type { SqlDriver } from "../../db/driver";
import { listTags } from "../../domain/mealprep/mealPrep";
import { TagChips } from "../../ui/common";
import { PageHeader, SubTabs, type Choice } from "../../ui/layout";
import { RecipesView } from "./RecipesView";
import { ShoppingView } from "./ShoppingView";
import { PlanView } from "./PlanView";
import { StockView } from "./StockView";

export type MealPrepView = "plan" | "stock" | "recipes" | "shopping";

/** In the order meal prep happens, the plan first. The food log moved to Food and drinks (FoodScreen). */
export const MEAL_PREP_VIEWS: Choice<MealPrepView>[] = [
  { id: "plan", label: "Plan" },
  { id: "stock", label: "Stock" },
  { id: "recipes", label: "Recipes" },
  { id: "shopping", label: "Shopping" },
];

interface Props {
  db: SqlDriver;
  /** Owned by the app shell, so Today and Food open the stock. */
  view: MealPrepView;
  onView: (view: MealPrepView) => void;
  /** Bumped after changes elsewhere (sync, chat). */
  version: number;
  /** After any write here, so the Dashboard reloads. */
  onChanged: () => void;
}

/**
 * Meal prep, in the order it happens: the plan (which tupper each day and what to cook next),
 * stock (what to defrost, eat), recipes (cook, or put on the shopping list) and shopping (the
 * list, what it cost, the month's spending). The views link to each other along the way.
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
      {view === "plan" && <PlanView db={db} version={v} onChanged={changed} onRecipes={() => onView("recipes")} onShopping={() => onView("shopping")} />}
      {view === "stock" && <StockView db={db} tag={tag} version={v} onChanged={changed} onRecipes={() => onView("recipes")} onPlan={() => onView("plan")} />}
      {view === "recipes" && (
        <RecipesView db={db} tag={tag} allTags={tags} version={v} onChanged={changed} onShopping={() => onView("shopping")} onStock={() => onView("stock")} />
      )}
      {view === "shopping" && <ShoppingView db={db} version={v} onChanged={changed} onRecipes={() => onView("recipes")} />}
    </section>
  );
}
