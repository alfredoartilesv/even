import type { SqlDriver } from "../../../db/driver";
import { PageHeader } from "../../../ui/layout";
import { AlcoholView } from "./AlcoholView";

/** The fourth tab: drinks logged, their calories, cost and what they do to the scale. */
export function AlcoholScreen({ db, version, onChanged }: { db: SqlDriver; version: number; onChanged: () => void }) {
  return (
    <section>
      <PageHeader title="Alcohol" />
      <AlcoholView db={db} version={version} onChanged={onChanged} />
    </section>
  );
}
