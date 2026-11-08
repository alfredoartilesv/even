import { useState, type FormEvent } from "react";
import { fmtHeight, fmtWeight, heightStepCm, weightStepKg, type HeightUnit, type WeightUnit } from "../../core/units";
import type { SqlDriver } from "../../db/driver";
import { claudeKeyVerifier } from "../../domain/chat/client";
import { connectClaude } from "../../domain/chat/connect";
import type { SyncSession } from "../../domain/cloudsync/session";
import { addMeasurement } from "../../domain/journal/entries";
import { finishFirstRun, FIRST_TARGETS, saveFirstTargets, type FirstTargets } from "../../domain/settings/onboarding";
import { loadProfile, saveProfile } from "../../domain/settings/profile";
import type { SecretStore } from "../../domain/settings/secrets";
import { deviceFetch } from "../../platform/device";
import { failed, MsgLine, timeZone, today, type Msg } from "../../ui/common";
import { SecretInput, Stepper, Switch } from "../../ui/controls";
import { PageHeader, Segmented } from "../../ui/layout";
import { Logo } from "../../ui/logo";
import { GarminSync } from "../settings/ConnectionSettings";

interface Props {
  db: SqlDriver;
  secrets: SecretStore;
  isNative: boolean;
  session: SyncSession | null;
  /** After a key is saved, so the shell reads the connections again (and shows Coach). */
  onChanged: () => void;
  /** Garmin connected: the first sync starts while the owner fills in the rest. */
  onConnected: () => void;
  /** Done (or skipped): Today opens. */
  onDone: () => void;
}

type Step = "connect" | 1 | 2 | 3;

const STEPS = ["Connect", "About you", "Targets"];

/**
 * First run, once per install (domain/settings/onboarding.ts): Connect (Garmin, and Coach if the
 * owner wants it), then Setup in three steps: units, height and weight; daily targets; a summary
 * that opens Today. Everything here can be changed later in You, and every step can be skipped.
 */
export function FirstRun({ db, secrets, isNative, session, onChanged, onConnected, onDone }: Props) {
  const [step, setStep] = useState<Step>("connect");
  const [heightUnit, setHeightUnit] = useState<HeightUnit>("cm");
  const [weightUnit, setWeightUnit] = useState<WeightUnit>("kg");
  const [heightCm, setHeightCm] = useState(175);
  const [weightKg, setWeightKg] = useState(75);
  const [targets, setTargets] = useState<FirstTargets>(FIRST_TARGETS);
  const [msg, setMsg] = useState<Msg>(null);
  const [saving, setSaving] = useState(false);

  async function finish() {
    setSaving(true);
    try {
      const day = today();
      const profile = await loadProfile(db);
      await saveProfile(db, { ...profile, heightCm: Math.round(heightCm), heightUnit, weightUnit }, day);
      await addMeasurement(db, { kind: "weight", value: Number(weightKg.toFixed(1)), unit: "kg", timeZone: timeZone() });
      await saveFirstTargets(db, targets, day);
      await finishFirstRun(db);
      onChanged();
      setStep(3);
    } catch (err) {
      setMsg(failed(err, "firstrun"));
    } finally {
      setSaving(false);
    }
  }

  async function skip() {
    await finishFirstRun(db);
    onDone();
  }

  if (step === "connect") {
    return (
      <main className="shell start-page" data-area="today">
        <div className="start-head">
          <PageHeader
            title="Let’s connect your data"
            subtitle="Takes about a minute. You can change everything later in You."
            leading={<Logo size={44} decorative />}
          />
          <StepNav at={0} />
        </div>
        <GarminSync db={db} secrets={secrets} isNative={isNative} session={session} onChanged={onChanged} onConnected={onConnected} />
        <CoachCard db={db} secrets={secrets} onChanged={onChanged} />
        <section className="card start-rules" aria-labelledby="rules">
          <h2 id="rules">Your data, your rules</h2>
          <ul>
            <li>Everything is stored on this device and encrypted.</li>
            <li>Nothing goes to Claude unless you turn Coach on and choose what to share.</li>
            <li>You can back it up, export it or delete it all at any time.</li>
          </ul>
        </section>
        <div className="start-actions">
          <button type="button" onClick={() => setStep(1)}>
            Continue
          </button>
          <button type="button" className="link" onClick={() => void skip()}>
            Skip for now, work offline
          </button>
        </div>
      </main>
    );
  }

  const titles = ["About you", "Your daily targets", "You’re all set"];
  const subs = ["Pick your units and tell us your height and weight.", "Start gentle. You can change these any time.", "Everything is set up."];
  return (
    <main className="shell start-page" data-area="today">
      <div className="start-head">
        <PageHeader title={titles[step - 1]} subtitle={subs[step - 1]} leading={<Logo size={44} decorative />} />
      </div>
      <div className="start-bars" role="progressbar" aria-valuemin={1} aria-valuemax={3} aria-valuenow={step} aria-label="Setup progress">
        {[1, 2, 3].map((i) => (
          <span key={i} className={i <= step ? "on" : ""} />
        ))}
      </div>

      {step === 1 && (
        <section className="card stack" aria-label="About you">
          <div className="start-row">
            <span className="grow">Height</span>
            <Segmented
              items={[
                { id: "cm", label: "cm" },
                { id: "ftin", label: "ft + in" },
              ]}
              value={heightUnit}
              onChange={setHeightUnit}
              label="Height unit"
            />
          </div>
          <Stepper
            label="Height"
            value={heightCm}
            onChange={setHeightCm}
            min={120}
            max={230}
            step={heightStepCm(heightUnit)}
            format={(n) => fmtHeight(n, heightUnit)}
          />
          <div className="start-row">
            <span className="grow">Weight</span>
            <Segmented
              items={[
                { id: "kg", label: "kg" },
                { id: "lb", label: "lb" },
              ]}
              value={weightUnit}
              onChange={setWeightUnit}
              label="Weight unit"
            />
          </div>
          <Stepper
            label="Weight"
            value={weightKg}
            onChange={setWeightKg}
            min={30}
            max={300}
            step={weightStepKg(weightUnit)}
            format={(n) => fmtWeight(n, weightUnit)}
          />
          <p className="muted small">These units become the default everywhere. Height and weight are used for energy estimates and stay on this device.</p>
        </section>
      )}

      {step === 2 && (
        <section className="card stack" aria-label="Daily targets">
          <TargetRow label="Calories" note="per day">
            <Stepper
              label="Calories"
              value={targets.kcal}
              onChange={(kcal) => setTargets({ ...targets, kcal })}
              min={1200}
              max={5000}
              step={50}
              format={(n) => `${n.toLocaleString()} kcal`}
            />
          </TargetRow>
          <TargetRow label="Protein" note="per day">
            <Stepper
              label="Protein"
              value={targets.proteinG}
              onChange={(proteinG) => setTargets({ ...targets, proteinG })}
              min={40}
              max={300}
              step={5}
              format={(n) => `${n} g`}
            />
          </TargetRow>
          <TargetRow label="Drinks" note="per week, at most (0 for no limit)">
            <Stepper
              label="Drinks per week"
              value={targets.drinksPerWeek}
              onChange={(drinksPerWeek) => setTargets({ ...targets, drinksPerWeek })}
              min={0}
              max={40}
              format={(n) => (n === 1 ? "1 drink" : `${n} drinks`)}
            />
          </TargetRow>
          <p className="muted small">Gentle starting points. Change them any time in You, Targets.</p>
        </section>
      )}

      {step === 3 && (
        <section className="card stack start-done" aria-label="All set">
          <ul>
            <li>
              {fmtHeight(heightCm, heightUnit)} · {fmtWeight(weightKg, weightUnit)}
            </li>
            <li>
              {targets.kcal.toLocaleString()} kcal · {targets.proteinG} g protein
              {targets.drinksPerWeek > 0 ? ` · up to ${targets.drinksPerWeek} drinks a week` : ""}
            </li>
            <li>Your data stays on this device</li>
          </ul>
          <button type="button" onClick={onDone}>
            Open Today
          </button>
        </section>
      )}

      <MsgLine msg={msg} />
      {step !== 3 && (
        <div className="start-actions">
          <button type="button" className="secondary" onClick={() => setStep(step === 1 ? "connect" : 1)}>
            Back
          </button>
          <button type="button" disabled={saving} onClick={() => (step === 1 ? setStep(2) : void finish())}>
            {step === 2 ? (saving ? "Saving…" : "Finish") : "Next"}
          </button>
        </div>
      )}
    </main>
  );
}

function StepNav({ at }: { at: number }) {
  return (
    <ol className="start-steps" aria-label="Setup steps">
      {STEPS.map((s, i) => (
        <li key={s} aria-current={i === at ? "step" : undefined} className={i === at ? "on" : ""}>
          <span aria-hidden>{i + 1}</span>
          {s}
        </li>
      ))}
    </ol>
  );
}

function TargetRow({ label, note, children }: { label: string; note: string; children: React.ReactNode }) {
  return (
    <div className="start-row">
      <span className="grow">
        <strong>{label}</strong>
        <span className="muted small"> {note}</span>
      </span>
      {children}
    </div>
  );
}

/** Coach is optional: off, it stays out of the app. On, the key is checked with Claude and kept in secure storage. */
function CoachCard({ db, secrets, onChanged }: { db: SqlDriver; secrets: SecretStore; onChanged: () => void }) {
  const [on, setOn] = useState(false);
  const [key, setKey] = useState("");
  const [checking, setChecking] = useState(false);
  const [msg, setMsg] = useState<Msg>(null);

  async function connect(e: FormEvent) {
    e.preventDefault();
    setChecking(true);
    try {
      const res = await connectClaude(db, secrets, key, claudeKeyVerifier(deviceFetch({ connectTimeoutMs: 15_000, readTimeoutMs: 20_000 })));
      if (!res.ok) return setMsg({ kind: "error", text: res.message });
      setKey("");
      setMsg({ kind: "ok", text: "Claude accepted the key. Coach is on." });
      onChanged();
    } catch (err) {
      setMsg(failed(err, "firstrun.claude"));
    } finally {
      setChecking(false);
    }
  }

  return (
    <section className="card stack" aria-label="Coach">
      <Switch
        label="Coach, optional"
        description="Chat with your data using your own Claude API key. Skip it and Coach stays out of the app; you can turn it on later in You."
        checked={on}
        onChange={setOn}
      />
      {on && (
        <form onSubmit={connect} className="stack">
          <label>
            Claude API key
            <SecretInput value={key} onChange={setKey} noun="key" placeholder="sk-ant-…" autoComplete="off" required />
          </label>
          <span className="muted small">Stored in your phone’s secure storage. Nothing is sent until you allow it.</span>
          <button type="submit" className="secondary" disabled={checking || !key.trim()}>
            {checking ? "Checking with Claude…" : "Check and save the key"}
          </button>
        </form>
      )}
      <MsgLine msg={msg} />
    </section>
  );
}
