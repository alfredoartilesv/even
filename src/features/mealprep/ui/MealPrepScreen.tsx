import { useCallback, useEffect, useState } from "react";
import type { SqlDriver } from "../../../db/driver";
import { listTags } from "../mealPrep";
import { TagChips } from "../../../ui/common";
import { RecipesView } from "./RecipesView";
import { ShoppingView } from "./ShoppingView";
import { StockView } from "./StockView";

interface Props {
  db: SqlDriver;
}

type View = "stock" | "recipes" | "shopping";

export function MealPrepScreen({ db }: Props) {
  const [view, setView] = useState<View>("stock");
  const [tags, setTags] = useState<string[]>([]);
  const [tag, setTag] = useState<string | null>(null);
  const [version, setVersion] = useState(0);

  const loadTags = useCallback(async () => {
    const t = (await listTags(db)).map((r) => r.tag);
    setTags(t);
    setTag((cur) => (cur && !t.includes(cur) ? null : cur));
  }, [db]);

  useEffect(() => {
    void loadTags();
  }, [loadTags, version]);

  return (
    <section>
      <nav className="tabs sub">
        {(["stock", "recipes", "shopping"] as const).map((v) => (
          <button key={v} className={view === v ? "active" : ""} onClick={() => setView(v)}>
            {{ stock: "Stock", recipes: "Recipes", shopping: "Shopping" }[v]}
          </button>
        ))}
      </nav>
      {view !== "shopping" && <TagChips tags={tags} value={tag} onChange={setTag} />}
      {view === "stock" && <StockView db={db} tag={tag} version={version} />}
      {view === "recipes" && <RecipesView db={db} tag={tag} allTags={tags} version={version} onChanged={() => setVersion((v) => v + 1)} />}
      {view === "shopping" && <ShoppingView db={db} version={version} />}
    </section>
  );
}
