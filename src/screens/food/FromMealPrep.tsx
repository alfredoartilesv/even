import type { StockEntry } from "../../domain/mealprep/mealPrep";
import { plural } from "../../ui/common";
import { Icon } from "../../ui/icons";
import { SectionHeader } from "../../ui/layout";
import { DoneBar, QuickRow } from "./QuickRows";

/**
 * From your meal prep: the batches with portions in the fridge, in the same rows as Eat again.
 * The + eats one portion (it leaves stock and lands in the log); the check, or Undo, puts it back.
 */
export function FromMealPrep({
  stock,
  ateBatchId,
  onEat,
  onStock,
}: {
  stock: StockEntry[];
  /** The batch a portion was just eaten from, if any. */
  ateBatchId: string | null;
  /** Eat a portion, or put back the one just eaten from this batch. */
  onEat: (s: StockEntry) => void;
  onStock: () => void;
}) {
  const ate = stock.find((s) => s.batch.id === ateBatchId);
  return (
    <section className="from-prep">
      <SectionHeader title="From your meal prep" action="Stock" onAction={onStock} />
      <ul className="tap-list">
        {stock.map((s) => (
          <QuickRow
            key={s.batch.id}
            picture={
              <span className="tap-icon prep" aria-hidden>
                <Icon name="mealprep" size={22} />
              </span>
            }
            title={s.batch.name}
            done={s.batch.id === ateBatchId}
            label={`Eat a portion of ${s.batch.name}`}
            onTap={() => onEat(s)}
          >
            <span className="muted small block">
              {s.fridgeCount > 0 ? `${plural(s.fridgeCount, "portion")} in the fridge` : "None left in the fridge"}
              {s.freezerCount > 0 ? ` · ${s.freezerCount} frozen` : ""}
            </span>
          </QuickRow>
        ))}
      </ul>
      {ate && <DoneBar text={`Ate a portion of ${ate.batch.name} · ${ate.fridgeCount} left`} onUndo={() => onEat(ate)} />}
    </section>
  );
}
