import { UNIT_CHOICES } from "../../domain/mealprep/shopping";

/**
 * The unit of an amount, picked from a list (g, kg, ml, l, pcs, pack...) instead of typed, so the
 * same unit is spelled the same way and amounts merge on the shopping list. A unit saved before the
 * list existed stays selectable.
 */
export function UnitSelect({ value, onChange, label = "Unit" }: { value: string; onChange: (unit: string) => void; label?: string }) {
  const units: string[] = [...UNIT_CHOICES];
  if (value && !units.includes(value)) units.unshift(value);
  return (
    <select aria-label={label} value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">unit</option>
      {units.map((u) => (
        <option key={u} value={u}>
          {u}
        </option>
      ))}
    </select>
  );
}
