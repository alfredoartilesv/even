import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Capacitor } from "@capacitor/core";
import { Share } from "@capacitor/share";
import type { SqlDriver } from "../../../db/driver";
import {
  addShoppingItem,
  clearShopping,
  formatQuantity,
  listAsText,
  listShopping,
  removeShoppingItem,
  setShoppingChecked,
  type ShoppingItem,
} from "../shopping";
import { MsgLine, numOrNull, type Msg } from "../../../ui/common";

interface Props {
  db: SqlDriver;
  version: number;
}

export function ShoppingView({ db, version }: Props) {
  const [items, setItems] = useState<ShoppingItem[]>([]);
  const [name, setName] = useState("");
  const [qty, setQty] = useState("");
  const [unit, setUnit] = useState("");
  const [msg, setMsg] = useState<Msg>(null);

  const load = useCallback(async () => setItems(await listShopping(db)), [db]);
  useEffect(() => {
    void load();
  }, [load, version]);

  async function add(e: FormEvent) {
    e.preventDefault();
    try {
      const q = numOrNull(qty);
      if (q !== null && Number.isNaN(q)) throw new Error("Quantity must be a number");
      await addShoppingItem(db, { name, quantity: q, unit });
      setName("");
      setQty("");
      setUnit("");
      setMsg(null);
      await load();
    } catch (err) {
      setMsg({ kind: "error", text: (err as Error).message });
    }
  }

  async function share() {
    const text = listAsText(items);
    if (!text) return setMsg({ kind: "error", text: "Nothing left to buy." });
    try {
      if (Capacitor.isNativePlatform()) await Share.share({ title: "Shopping list", text });
      else {
        await navigator.clipboard.writeText(text);
        setMsg({ kind: "ok", text: "Copied to the clipboard." });
      }
    } catch (err) {
      setMsg({ kind: "error", text: (err as Error).message });
    }
  }

  const open = items.filter((i) => !i.checked).length;

  return (
    <div>
      <form className="ingredient" onSubmit={add}>
        <input aria-label="Item" placeholder="Item" value={name} onChange={(e) => setName(e.target.value)} />
        <input aria-label="Quantity" placeholder="Qty" inputMode="decimal" value={qty} onChange={(e) => setQty(e.target.value)} />
        <input aria-label="Unit" placeholder="Unit" value={unit} onChange={(e) => setUnit(e.target.value)} />
        <button type="submit">Add</button>
      </form>
      <MsgLine msg={msg} />

      <ul className="checklist">
        {items.map((i) => (
          <li key={i.id} className={i.checked ? "done" : ""}>
            <label>
              <input
                type="checkbox"
                checked={i.checked}
                onChange={(e) => void setShoppingChecked(db, i.id, e.target.checked).then(load)}
              />
              <span>{i.name}</span>
              <span className="muted">{formatQuantity(i.quantity, i.unit)}</span>
            </label>
            <button className="secondary" aria-label={`Remove ${i.name}`} onClick={() => void removeShoppingItem(db, i.id).then(load)}>
              ×
            </button>
          </li>
        ))}
      </ul>
      {!items.length && <p className="muted">The list is empty. Add items here, or from recipes in Recipes.</p>}

      {items.length > 0 && (
        <div className="actions">
          <button onClick={share} disabled={!open}>
            {Capacitor.isNativePlatform() ? "Share list" : "Copy list"}
          </button>
          <button className="secondary" disabled={open === items.length} onClick={() => void clearShopping(db).then(load)}>
            Clear ticked
          </button>
          <button
            className="secondary danger"
            onClick={() => {
              if (confirm("Empty the whole shopping list?")) void clearShopping(db, { all: true }).then(load);
            }}
          >
            Clear all
          </button>
        </div>
      )}
    </div>
  );
}
