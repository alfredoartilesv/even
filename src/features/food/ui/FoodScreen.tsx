import { useState } from "react";
import type { SqlDriver } from "../../../db/driver";
import { HistoryView } from "./HistoryView";
import { SavedView } from "./SavedView";
import { TodayView } from "./TodayView";

interface Props {
  db: SqlDriver;
}

type View = "today" | "history" | "saved";

export function FoodScreen({ db }: Props) {
  const [view, setView] = useState<View>("today");
  // Bumped after any write so the other views reload when opened.
  const [version, setVersion] = useState(0);
  const changed = () => setVersion((v) => v + 1);

  return (
    <section>
      <nav className="tabs sub">
        {(["today", "history", "saved"] as const).map((v) => (
          <button key={v} className={view === v ? "active" : ""} onClick={() => setView(v)}>
            {{ today: "Calories", history: "History", saved: "Saved" }[v]}
          </button>
        ))}
      </nav>
      {view === "today" && <TodayView db={db} version={version} onChanged={changed} />}
      {view === "history" && <HistoryView db={db} version={version} onChanged={changed} />}
      {view === "saved" && <SavedView db={db} version={version} onChanged={changed} />}
    </section>
  );
}
