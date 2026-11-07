import { useEffect, useState } from "react";
import { fmtHeight, fmtWeight, heightStepCm, weightStepKg, type HeightUnit, type WeightUnit } from "../../core/units";
import type { SqlDriver } from "../../db/driver";
import type { Weight } from "../../domain/alcohol/alcohol";
import { addMeasurement } from "../../domain/journal/entries";
import { saveProfile, type Profile } from "../../domain/settings/profile";
import { failed, MsgLine, timeZone, today, type Msg } from "../../ui/common";
import { Stepper } from "../../ui/controls";
import { Segmented } from "../../ui/layout";

/**
 * You > Profile, Height and weight (handoff 0.7): the units read everywhere (saved at once), the
 * height (saved a moment after the last step) and a weigh-in for today (saved with its button,
 * since every weigh-in is a measurement of its own). Data stays in cm and kg.
 */
export function BodyUnits({ db, saved, weight, onSaved }: { db: SqlDriver; saved: Profile; weight: Weight | null; onSaved: (p: Profile) => void }) {
  const [height, setHeight] = useState(saved.heightCm ?? 175);
  const [kg, setKg] = useState(weight?.kg ?? 75);
  const [msg, setMsg] = useState<Msg>(null);
  useEffect(() => setHeight(saved.heightCm ?? 175), [saved.heightCm]);
  useEffect(() => setKg(weight?.kg ?? 75), [weight?.kg]);

  const save = async (patch: Partial<Profile>, text: string) => {
    try {
      onSaved(await saveProfile(db, { ...saved, ...patch }, today()));
      setMsg({ kind: "ok", text });
    } catch (err) {
      setMsg(failed(err, "settings.units"));
    }
  };

  // The height is saved a moment after the last tap, so stepping 170 to 178 writes once.
  useEffect(() => {
    if (height === saved.heightCm || (saved.heightCm === null && height === 175)) return;
    const t = setTimeout(() => void save({ heightCm: Math.round(height) }, "Height saved."), 700);
    return () => clearTimeout(t);
    // save reads the latest saved profile; only a new height should start the timer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [height]);

  return (
    <section className="card body-units" aria-labelledby="body-units">
      <h2 id="body-units">Height and weight</h2>
      <div className="body-row">
        <span className="grow">
          <strong>Height</strong>
        </span>
        <Segmented
          items={[
            { id: "cm", label: "cm" },
            { id: "ftin", label: "ft + in" },
          ]}
          value={saved.heightUnit}
          onChange={(u: HeightUnit) => void save({ heightUnit: u }, "Height unit saved.")}
          label="Height unit"
        />
      </div>
      <Stepper
        label="Height"
        value={height}
        onChange={setHeight}
        min={120}
        max={230}
        step={heightStepCm(saved.heightUnit)}
        format={(n) => fmtHeight(n, saved.heightUnit)}
      />
      <div className="body-row">
        <span className="grow">
          <strong>Weight</strong>
          <span className="muted small block">{weight ? `Last weigh-in ${fmtWeight(weight.kg, saved.weightUnit)}` : "No weigh-in yet"}</span>
        </span>
        <Segmented
          items={[
            { id: "kg", label: "kg" },
            { id: "lb", label: "lb" },
          ]}
          value={saved.weightUnit}
          onChange={(u: WeightUnit) => void save({ weightUnit: u }, "Weight unit saved.")}
          label="Weight unit"
        />
      </div>
      <div className="body-row">
        <Stepper
          label="Weight"
          value={kg}
          onChange={setKg}
          min={30}
          max={300}
          step={weightStepKg(saved.weightUnit)}
          format={(n) => fmtWeight(n, saved.weightUnit)}
        />
        <button
          type="button"
          className="secondary"
          disabled={weight !== null && Math.abs(kg - weight.kg) < 0.05}
          onClick={async () => {
            try {
              await addMeasurement(db, { kind: "weight", value: Number(kg.toFixed(1)), unit: "kg", timeZone: timeZone() });
              setMsg({ kind: "ok", text: "Weigh-in saved for today." });
              onSaved(saved);
            } catch (err) {
              setMsg(failed(err, "settings.weight"));
            }
          }}
        >
          Save weigh-in
        </button>
      </div>
      <p className="muted small">
        The units you pick here are the default everywhere: Today, Journal, charts, and what Coach tells you. Data is stored in cm and kg.
      </p>
      <MsgLine msg={msg} />
    </section>
  );
}
