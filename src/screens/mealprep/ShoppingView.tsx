import { useCallback, useEffect, useState, type FormEvent } from "react";
import { isNative, shareText } from "../../platform/device";
import type { SqlDriver } from "../../db/driver";
import {
  addShoppingItem,
  clearShopping,
  formatQuantity,
  listAsText,
  listShopping,
  removeShoppingItem,
  setShoppingChecked,
  type ShoppingItem,
} from "../../domain/mealprep/shopping";
import { failed, MsgLine, numOrNull, type Msg } from "../../ui/common";
import { Icon } from "../../ui/icons";
import { SectionHeader } from "../../ui/layout";
import { SpendingView } from "./SpendingView";
import { UnitSelect } from "./UnitSelect";

interface Props {
  db: SqlDriver;
  version: number;
  onChanged: () => void;
  /** Opens Recipes, to add a recipe's ingredients to the list. */
  onRecipes: () => void;
}

/**
 * The supermarket in one place, in the order it happens: the list (add, tick off in the shop,
 * share), then what it cost (logging the shop clears the ticked items), then the month's spending.
 */
export function ShoppingView({ db, version, onChanged, onRecipes }: Props) {
  const [items, setItems] = useState<ShoppingItem[]>([]);
  const [name, setName] = useState("");
  const [qty, setQty] = useState("");
  const [unit, setUnit] = useState("");
  const [msg, setMsg] = useState<Msg>(null);
  // Bumped on every list change, so the spending form below sees how many items are ticked.
  const [listVersion, setListVersion] = useState(0);

  const load = useCallback(async () => setItems(await listShopping(db)), [db]);
  useEffect(() => {
    void load();
  }, [load, version]);

  const changed = async () => {
    await load();
    setListVersion((v) => v + 1);
  };

  async function add(e: FormEvent) {
    e.preventDefault();
    try {
      const q = numOrNull(qty.replace(",", "."));
      if (q !== null && Number.isNaN(q)) throw new Error("Quantity must be a number");
      await addShoppingItem(db, { name, quantity: q, unit });
      setName("");
      setQty("");
      setUnit("");
      setMsg(null);
      await changed();
    } catch (err) {
      setMsg(failed(err, "mealprep"));
    }
  }

  async function share() {
    const text = listAsText(items);
    if (!text) return setMsg({ kind: "error", text: "Nothing left to buy." });
    try {
      if ((await shareText("Shopping list", text)) === "copied") setMsg({ kind: "ok", text: "Copied to the clipboard." });
    } catch (err) {
      setMsg(failed(err, "mealprep"));
    }
  }

  const open = items.filter((i) => !i.checked);
  const ticked = items.length - open.length;

  return (
    <div className="wide-grid">
      <section className="span-6">
        <SectionHeader title="Shopping list" action="Add from recipes" onAction={onRecipes} />
        {items.length > 0 && (
          <div className="basket">
            <span className="small">
              <strong>
                {ticked} of {items.length}
              </strong>{" "}
              in the basket{open.length === 0 ? ", everything is in" : ""}
            </span>
            <span className="basket-track" aria-hidden>
              <span style={{ width: `${(ticked / items.length) * 100}%` }} />
            </span>
          </div>
        )}
        <form className="ingredient" onSubmit={add}>
          <input aria-label="Item" placeholder="Add an item" value={name} onChange={(e) => setName(e.target.value)} />
          <input aria-label="Quantity" placeholder="Qty" inputMode="decimal" value={qty} onChange={(e) => setQty(e.target.value)} />
          <UnitSelect value={unit} onChange={setUnit} />
          <button type="submit" aria-label="Add item">
            <Icon name="plus" size={18} />
          </button>
        </form>
        <MsgLine msg={msg} />

        {items.length > 0 ? (
          <ul className="checklist">
            {items.map((i) => (
              <li key={i.id} className={i.checked ? "done" : ""}>
                <label>
                  <input type="checkbox" checked={i.checked} onChange={(e) => void setShoppingChecked(db, i.id, e.target.checked).then(changed)} />
                  <span>{i.name}</span>
                  <span className="muted">{formatQuantity(i.quantity, i.unit)}</span>
                </label>
                <button className="icon-button ghost" aria-label={`Remove ${i.name}`} onClick={() => void removeShoppingItem(db, i.id).then(changed)}>
                  <Icon name="trash" size={18} />
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted small">The list is empty. Add items above, or pick recipes and how many batches you will cook in Recipes.</p>
        )}

        {items.length > 0 && (
          <div className="actions">
            <button className="secondary" onClick={share} disabled={!open.length}>
              {isNative ? "Share list" : "Copy list"}
            </button>
            <button className="secondary" disabled={!ticked} onClick={() => void clearShopping(db).then(changed)}>
              Clear ticked
            </button>
            <button
              className="secondary danger"
              onClick={() => {
                if (confirm("Empty the whole shopping list?")) void clearShopping(db, { all: true }).then(changed);
              }}
            >
              Clear all
            </button>
          </div>
        )}
      </section>

      <SpendingView db={db} version={version + listVersion} onChanged={onChanged} />
    </div>
  );
}
