import { useState } from "react";
import type { SqlDriver } from "../../db/driver";
import { logDrink, saveDrinkType, servingKcal, type DrinkType } from "../../domain/alcohol/alcohol";
import { alcoholGrams, standardDrinks } from "../../core/health";
import { fmtMoney, timeZone } from "../../ui/common";
import { ChipGroup, MoneyInput, Stepper, Switch } from "../../ui/controls";
import { Icon } from "../../ui/icons";

/** The kinds of drink the add panel starts from (handoff 0.7, Drinks): a usual size and strength each. */
const KINDS = [
  { id: "beer", label: "Beer", name: "Beer", volumeMl: 330, abvPercent: 5 },
  { id: "wine", label: "Wine", name: "Glass of wine", volumeMl: 150, abvPercent: 12.5 },
  { id: "spirit", label: "Spirit", name: "Spirit", volumeMl: 40, abvPercent: 40 },
  { id: "cocktail", label: "Cocktail", name: "Cocktail", volumeMl: 200, abvPercent: 12 },
  { id: "cider", label: "Cider", name: "Cider", volumeMl: 330, abvPercent: 4.5 },
] as const;
type Kind = (typeof KINDS)[number]["id"];

export interface Draft {
  /** A favourite being added: its own size, strength and kcal; the price can change for this one. */
  type: DrinkType | null;
  kind: Kind;
  name: string;
  volumeMl: number;
  abvPercent: number;
  price: number;
  count: number;
  favourite: boolean;
}

export const draftFrom = (t: DrinkType | null): Draft =>
  t
    ? { type: t, kind: "beer", name: t.name, volumeMl: t.volumeMl, abvPercent: t.abvPercent, price: t.price ?? 0, count: 1, favourite: true }
    : { type: null, kind: "beer", name: "Beer", volumeMl: 330, abvPercent: 5, price: 3.5, count: 1, favourite: false };

const one = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 1 });

/**
 * The add panel: a favourite with its usual price filled in (change it for this one), or another
 * drink from a kind, a name, a price and how many, kept as a favourite if wanted.
 */
export function AddDrink({
  db,
  draft,
  setDraft,
  currency,
  atMs,
  dayLabel,
  onLogged,
  onClose,
}: {
  db: SqlDriver;
  draft: Draft;
  setDraft: (d: Draft) => void;
  currency: string;
  /** When it was drunk: undefined for now. */
  atMs: () => number | undefined;
  /** " for Thu, Nov 5" when logging an earlier day. */
  dayLabel: string;
  onLogged: (ids: string[], text: string) => void;
  onClose: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const total = draft.price * draft.count;
  const kcal = servingKcal({ volumeMl: draft.volumeMl, abvPercent: draft.abvPercent, calories: draft.type?.calories ?? null });

  async function add() {
    setBusy(true);
    try {
      const typeId = draft.type
        ? draft.type.id
        : draft.favourite
          ? await saveDrinkType(db, {
              name: draft.name.trim(),
              volumeMl: draft.volumeMl,
              abvPercent: draft.abvPercent,
              calories: null,
              price: draft.price || null,
            })
          : null;
      const ids = await logDrink(db, {
        typeId,
        name: draft.name.trim(),
        volumeMl: draft.volumeMl,
        abvPercent: draft.abvPercent,
        price: draft.price || null,
        count: draft.count,
        atMs: atMs(),
        timeZone: timeZone(),
      });
      onLogged(
        ids,
        `Added ${draft.count} ${draft.name.trim()}${dayLabel} · ${fmtMoney(total, currency)}${!draft.type && draft.favourite ? " · saved as a favourite" : ""}`,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not add it");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card add-drink" aria-labelledby="add-drink">
      <div className="add-drink-head">
        <h2 id="add-drink">{draft.type ? `Add ${draft.type.name}` : "Add another drink"}</h2>
        <button type="button" className="icon-button ghost" aria-label="Close" onClick={onClose}>
          <Icon name="close" size={20} />
        </button>
      </div>
      {!draft.type && (
        <ChipGroup
          label="Type of drink"
          value={draft.kind}
          onChange={(k) => {
            const p = KINDS.find((x) => x.id === k)!;
            setDraft({ ...draft, kind: k, name: p.name, volumeMl: p.volumeMl, abvPercent: p.abvPercent });
          }}
          options={KINDS.map((k) => ({ id: k.id, label: k.label }))}
        />
      )}
      {!draft.type && (
        <label>
          Name
          <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
        </label>
      )}
      <span className="muted small">
        {draft.volumeMl} ml · {draft.abvPercent}% · {kcal} kcal · {one(standardDrinks(alcoholGrams(draft.volumeMl, draft.abvPercent)))} standard
      </span>
      <div className="add-drink-steppers">
        <div className="stepper-field">
          <label className="muted small" htmlFor="add-drink-price">
            Price
          </label>
          <MoneyInput id="add-drink-price" label="Price" value={draft.price} onChange={(price) => setDraft({ ...draft, price })} currency={currency} />
        </div>
        <div className="stepper-field">
          <span className="muted small">How many</span>
          <Stepper label="How many" value={draft.count} onChange={(count) => setDraft({ ...draft, count })} min={1} max={20} />
        </div>
      </div>
      {!draft.type && (
        <Switch
          label="Save as favourite"
          description="Shows in Your drinks, one tap next time"
          checked={draft.favourite}
          onChange={(favourite) => setDraft({ ...draft, favourite })}
        />
      )}
      {error && <p className="error small">{error}</p>}
      <div className="add-drink-actions">
        <button type="button" disabled={busy || !draft.name.trim()} onClick={() => void add()}>
          Add drink{dayLabel} · {fmtMoney(total, currency)}
        </button>
        <button type="button" className="secondary" onClick={onClose}>
          Cancel
        </button>
      </div>
    </section>
  );
}
