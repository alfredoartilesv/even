import { useState } from "react";
import type { SqlDriver } from "../../db/driver";
import { today } from "../../ui/common";
import { PageHeader, SubTabs, type Choice } from "../../ui/layout";
import { AlcoholView } from "../alcohol/AlcoholView";
import { DayView } from "./DayView";
import { HistoryView } from "./HistoryView";
import { SavedView } from "./SavedView";

export type FoodView = "log" | "drinks" | "history" | "saved";

export const FOOD_VIEWS: Choice<FoodView>[] = [
  { id: "log", label: "Log" },
  { id: "drinks", label: "Drinks" },
  { id: "history", label: "History" },
  { id: "saved", label: "Saved meals" },
];

interface Props {
  db: SqlDriver;
  /** Owned by the shell, so Today and Add open the log or the drinks. */
  view: FoodView;
  onView: (view: FoodView) => void;
  version: number;
  onChanged: () => void;
  /** Meal prep's stock, from the log's "eat a portion". */
  onStock: () => void;
}

/**
 * Food and drinks: everything eaten and drunk. The day's log (today, or any past day), the
 * drinks with their favourites and cost, the history by week, and saved meals. Before 0.7 these
 * were the Meal prep tab's food log and the Alcohol tab.
 */
export function FoodScreen({ db, view, onView, version, onChanged, onStock }: Props) {
  // The day open in the log, kept here so History can open a day in it.
  const [day, setDay] = useState(today);
  // The drink favourites are a page of their own on a phone, with the way back to Drinks.
  const [managing, setManaging] = useState(false);
  const [local, setLocal] = useState(0);
  const changed = () => {
    setLocal((v) => v + 1);
    onChanged();
  };
  const v = version + local;

  return (
    <section>
      <PageHeader
        title={managing && view === "drinks" ? "Favourite drinks" : "Food and drinks"}
        onBack={managing && view === "drinks" ? () => setManaging(false) : undefined}
        backLabel="Drinks"
      />
      {!(managing && view === "drinks") && <SubTabs items={FOOD_VIEWS} value={view} onChange={onView} label="Food and drinks views" />}
      {view === "log" && <DayView db={db} version={v} onChanged={changed} day={day} onDay={setDay} onStock={onStock} />}
      {view === "drinks" && <AlcoholView db={db} version={v} onChanged={changed} managing={managing} onManage={setManaging} />}
      {view === "history" && (
        <HistoryView
          db={db}
          version={v}
          onOpenDay={(d) => {
            setDay(d);
            onView("log");
          }}
        />
      )}
      {view === "saved" && <SavedView db={db} version={v} onChanged={changed} />}
    </section>
  );
}
