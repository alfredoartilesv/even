import { useCallback, useEffect, useRef, useState } from "react";
import type { SqlDriver } from "../../db/driver";
import { listTags } from "../../domain/mealprep/mealPrep";
import { TagChips, today } from "../../ui/common";
import { PageHeader, Segmented, SubTabs, type Choice } from "../../ui/layout";
import { HistoryView } from "../food/HistoryView";
import { SavedView } from "../food/SavedView";
import { DayView } from "../food/DayView";
import { RecipesView } from "./RecipesView";
import { ShoppingView } from "./ShoppingView";
import { PlanView } from "./PlanView";
import { StockView } from "./StockView";

export type MealPrepView = "log" | "history" | "saved" | "plan" | "stock" | "recipes" | "shopping";

export type MealPrepGroup = "food" | "prep";

export const MEAL_PREP_GROUPS: (Choice<MealPrepGroup> & { views: Choice<MealPrepView>[] })[] = [
  {
    id: "food",
    label: "Food log",
    views: [
      { id: "log", label: "Log" },
      { id: "history", label: "History" },
      { id: "saved", label: "Saved meals" },
    ],
  },
  {
    id: "prep",
    label: "Meal prep",
    views: [
      { id: "plan", label: "Plan" },
      { id: "stock", label: "Stock" },
      { id: "recipes", label: "Recipes" },
      { id: "shopping", label: "Shopping" },
    ],
  },
];

/** Every view, food log first. */
export const MEAL_PREP_VIEWS: Choice<MealPrepView>[] = MEAL_PREP_GROUPS.flatMap((g) => g.views);

const groupOf = (v: MealPrepView): MealPrepGroup => MEAL_PREP_GROUPS.find((g) => g.views.some((x) => x.id === v))!.id;

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
 * The third tab: everything about eating, in two groups. Food log: a day's log (today, or any past
 * day), the history by week, saved meals. Meal prep, in the order it happens: recipes (cook, or
 * put on the shopping list), shopping (the list, what it cost, the month's spending), stock
 * (what to defrost, eat) and, first, the plan: which tupper each day and what to cook next. The views link to each other along the way.
 */
export function MealPrepScreen({ db, view, onView, version, onChanged }: Props) {
  const [tags, setTags] = useState<string[]>([]);
  const [tag, setTag] = useState<string | null>(null);
  // The day open in the food log. Kept here so History can open a day in the log.
  const [foodDay, setFoodDay] = useState(today);
  // Bumped after any write so the other views reload when opened.
  const [local, setLocal] = useState(0);
  const changed = () => {
    setLocal((v) => v + 1);
    onChanged();
  };
  const v = version + local;
  const group = groupOf(view);
  // Switching group goes back to the view last open in it.
  const last = useRef<Record<MealPrepGroup, MealPrepView>>({ food: "log", prep: "plan" });
  last.current[group] = view;
  const views = MEAL_PREP_GROUPS.find((g) => g.id === group)!.views;

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
      <Segmented items={MEAL_PREP_GROUPS} value={group} onChange={(g) => onView(last.current[g])} label="Food log or meal prep" />
      <SubTabs items={views} value={view} onChange={onView} label={group === "food" ? "Food log views" : "Meal prep views"} />
      {(view === "stock" || view === "recipes") && <TagChips tags={tags} value={tag} onChange={setTag} />}
      {view === "log" && <DayView db={db} version={v} onChanged={changed} day={foodDay} onDay={setFoodDay} onStock={() => onView("stock")} />}
      {view === "history" && (
        <HistoryView
          db={db}
          version={v}
          onOpenDay={(d) => {
            setFoodDay(d);
            onView("log");
          }}
        />
      )}
      {view === "saved" && <SavedView db={db} version={v} onChanged={changed} />}
      {view === "plan" && <PlanView db={db} version={v} onChanged={changed} onRecipes={() => onView("recipes")} onShopping={() => onView("shopping")} />}
      {view === "stock" && <StockView db={db} tag={tag} version={v} onChanged={changed} onRecipes={() => onView("recipes")} onPlan={() => onView("plan")} />}
      {view === "recipes" && (
        <RecipesView db={db} tag={tag} allTags={tags} version={v} onChanged={changed} onShopping={() => onView("shopping")} onStock={() => onView("stock")} />
      )}
      {view === "shopping" && <ShoppingView db={db} version={v} onChanged={changed} onRecipes={() => onView("recipes")} />}
    </section>
  );
}
