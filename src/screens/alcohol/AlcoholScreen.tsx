import { useState } from "react";
import type { SqlDriver } from "../../db/driver";
import { PageHeader } from "../../ui/layout";
import { AlcoholView } from "./AlcoholView";

/** The fourth tab: drinks logged, their calories, cost and what they do to the scale. */
export function AlcoholScreen({ db, version, onChanged }: { db: SqlDriver; version: number; onChanged: () => void }) {
  // The favourites are a page of their own on a phone, with the way back to Alcohol.
  const [managing, setManaging] = useState(false);
  return (
    <section>
      <PageHeader title={managing ? "Favourites" : "Alcohol"} onBack={managing ? () => setManaging(false) : undefined} backLabel="Alcohol" />
      <AlcoholView db={db} version={version} onChanged={onChanged} managing={managing} onManage={setManaging} />
    </section>
  );
}
