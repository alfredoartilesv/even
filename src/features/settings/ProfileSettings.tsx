import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { SqlDriver } from "../../db/driver";
import { googleSignIn, googleSignInAvailable, googleSignOut, googleWebClientId } from "../../platform/googleSignIn";
import { StatTile } from "../../ui/charts";
import { failed, fmtDay, MsgLine, numOrNull, today, type Msg } from "../../ui/common";
import { getOwner, releaseOwnership, type Owner } from "../account/account";
import { signInWithGoogle, signOutOfGoogle } from "../account/service";
import { latestWeight, type Weight } from "../alcohol/alcohol";
import { PhotoPicker } from "../me/ui/avatar";
import { ACTIVITY_LABEL, ACTIVITY_LEVELS, EMPTY_PROFILE, estimates, loadProfile, profileSchema, saveProfile, type Profile } from "./profile";

const BMI_WORD = { underweight: "underweight", healthy: "healthy range", overweight: "overweight", obese: "obese" } as const;

interface Draft {
  name: string;
  birthDate: string;
  sex: "" | "male" | "female";
  heightCm: string;
  activity: string;
  kgPerWeek: string;
}

const toDraft = (p: Profile): Draft => ({
  name: p.name ?? "",
  birthDate: p.birthDate ?? "",
  sex: p.sex ?? "",
  heightCm: p.heightCm === null ? "" : String(p.heightCm),
  activity: p.activity ?? "",
  kgPerWeek: String(p.kgPerWeek),
});

/** Bad numbers stay NaN so saveProfile refuses them with a message. */
const fromDraft = (d: Draft) => ({
  name: d.name.trim() || null,
  birthDate: d.birthDate || null,
  sex: d.sex || null,
  heightCm: numOrNull(d.heightCm),
  activity: d.activity || null,
  kgPerWeek: numOrNull(d.kgPerWeek) ?? 0,
});

function liveEstimates(draft: Draft, saved: Profile, weightKg: number | null) {
  const parsed = profileSchema.safeParse({ ...saved, ...fromDraft(draft) });
  try {
    return estimates(parsed.success ? parsed.data : saved, weightKg, today());
  } catch {
    // A birth date after today: show the saved figures until it is fixed.
    return estimates(saved, weightKg, today());
  }
}

/** Who owns the data (Google account) and the profile the energy and body estimates use. */
export function ProfileSettings({ db, onChanged }: { db: SqlDriver; onChanged: () => void }) {
  const [draft, setDraft] = useState<Draft>(toDraft(EMPTY_PROFILE));
  const [saved, setSaved] = useState<Profile>(EMPTY_PROFILE);
  const [weight, setWeight] = useState<Weight | null>(null);
  const [owner, setOwner] = useState<Owner | null>(null);
  const [msg, setMsg] = useState<Msg>(null);
  const [accountMsg, setAccountMsg] = useState<Msg>(null);
  const [confirmRelease, setConfirmRelease] = useState(false);

  const load = useCallback(async () => {
    const [p, w, o] = await Promise.all([loadProfile(db), latestWeight(db, today()), getOwner(db)]);
    setSaved(p);
    setDraft(toDraft(p));
    setWeight(w);
    setOwner(o);
  }, [db]);

  useEffect(() => {
    void load();
  }, [load]);

  async function save(e: FormEvent) {
    e.preventDefault();
    try {
      // Merge into the saved profile: fields set elsewhere (sports, on the Me tab) are kept.
      setSaved(await saveProfile(db, { ...saved, ...fromDraft(draft) }, today()));
      setMsg({ kind: "ok", text: "Profile saved." });
      onChanged();
    } catch (err) {
      setMsg(failed(err, "settings.profile"));
    }
  }

  async function signIn() {
    const res = await signInWithGoogle(db, { signIn: googleSignIn, webClientId: googleWebClientId! });
    if (res.status === "cancelled") return;
    if (res.status === "error") return setAccountMsg({ kind: "error", text: res.message });
    if (res.status === "other_owner") {
      return setAccountMsg({ kind: "error", text: `This phone's data belongs to ${res.ownerEmail ?? "another Google account"}. Sign in with that account.` });
    }
    setAccountMsg({ kind: "ok", text: res.status === "bound" ? "Signed in. This account now owns the data on this phone." : "Signed in." });
    await load();
  }

  const set = (patch: Partial<Draft>) => setDraft({ ...draft, ...patch });
  // Live estimates follow the form, so the owner sees the effect before saving; a half-typed
  // value the form would refuse falls back to the saved profile.
  const live = liveEstimates(draft, saved, weight?.kg ?? null);
  const kcal = (n: number | null) => (n === null ? null : Math.round(n).toLocaleString());

  return (
    <div>
      <h2>Account</h2>
      {owner ? (
        <div className="card">
          <div className="row">
            <div className="grow">
              <strong>{owner.name ?? owner.email ?? "Google account"}</strong>
              {owner.email && owner.name && <div className="muted small">{owner.email}</div>}
              <div className="muted small">
                Owns this phone's data since {fmtDay(new Date(owner.boundAtMs).toISOString().slice(0, 10))} · {owner.signedIn ? "signed in" : "signed out"}
              </div>
            </div>
          </div>
          <div className="actions">
            {owner.signedIn ? (
              <button
                className="secondary"
                onClick={async () => {
                  await signOutOfGoogle(db, { signOut: googleSignOut });
                  setAccountMsg({ kind: "ok", text: "Signed out. Your data stays on this phone." });
                  await load();
                }}
              >
                Sign out
              </button>
            ) : (
              googleSignInAvailable && <button onClick={signIn}>Sign in again</button>
            )}
            {confirmRelease ? (
              <>
                <button
                  className="secondary danger"
                  onClick={async () => {
                    await releaseOwnership(db);
                    setConfirmRelease(false);
                    setAccountMsg({ kind: "ok", text: "Released. The next account that signs in will own this phone's data." });
                    await load();
                  }}
                >
                  Release ownership
                </button>
                <button className="secondary" onClick={() => setConfirmRelease(false)}>
                  Keep
                </button>
              </>
            ) : (
              <button className="secondary danger" onClick={() => setConfirmRelease(true)}>
                Release…
              </button>
            )}
          </div>
          {confirmRelease && (
            <p className="warning small">
              Releasing unbinds this account. Nothing is deleted, but the next Google account that signs in becomes the owner of all
              the data here, and backups made under this account will not restore on a phone owned by another.
            </p>
          )}
        </div>
      ) : (
        <div className="stack tight">
          <p className="muted small">
            Optional. Signing in with Google ties this phone's data and backups to your account, so a backup only restores on a
            phone you own. No Google data is read beyond your name and email.
          </p>
          {googleSignInAvailable ? (
            <button onClick={signIn}>Sign in with Google</button>
          ) : (
            <p className="muted small">Google sign-in is available in the phone app built with a Google client id.</p>
          )}
        </div>
      )}
      <MsgLine msg={accountMsg} />

      <h2>About you</h2>
      <p className="muted small">
        Used for the calorie target, BMI and the energy figures, here and in the chat. Stays on this phone and in your backups. Every
        field is optional.
      </p>
      <PhotoPicker db={db} name={saved.name} onChanged={onChanged} />
      <form onSubmit={save} className="stack">
        <label>
          Name
          <input value={draft.name} onChange={(e) => set({ name: e.target.value })} autoComplete="given-name" maxLength={60} />
        </label>
        <div className="grid">
          <label>
            Birth date
            <input type="date" value={draft.birthDate} max={today()} onChange={(e) => set({ birthDate: e.target.value })} />
          </label>
          <label>
            Height cm
            <input inputMode="decimal" value={draft.heightCm} onChange={(e) => set({ heightCm: e.target.value })} placeholder="e.g. 178" />
          </label>
        </div>
        <fieldset>
          <legend className="small">Sex (for the energy formula)</legend>
          <div className="chips">
            {(["female", "male"] as const).map((s) => (
              <button type="button" key={s} className={draft.sex === s ? "chip active" : "chip"} aria-pressed={draft.sex === s} onClick={() => set({ sex: draft.sex === s ? "" : s })}>
                {s === "female" ? "Female" : "Male"}
              </button>
            ))}
          </div>
        </fieldset>
        <label>
          Activity level
          <select value={draft.activity} onChange={(e) => set({ activity: e.target.value })}>
            <option value="">Not set</option>
            {ACTIVITY_LEVELS.map((a) => (
              <option key={a} value={a}>
                {ACTIVITY_LABEL[a]}
              </option>
            ))}
          </select>
        </label>
        <label>
          Weight goal, kg per week
          <select value={draft.kgPerWeek} onChange={(e) => set({ kgPerWeek: e.target.value })}>
            {["-1", "-0.75", "-0.5", "-0.25", "0", "0.25", "0.5"].map((v) => (
              <option key={v} value={v}>
                {v === "0" ? "Keep my weight" : Number(v) < 0 ? `Lose ${-Number(v)} kg a week` : `Gain ${v} kg a week`}
              </option>
            ))}
          </select>
        </label>
        <button type="submit">Save profile</button>
        <MsgLine msg={msg} />
      </form>

      <h2>Your estimates</h2>
      <p className="muted small">
        {weight
          ? `Weight ${weight.kg.toFixed(1)} kg from ${weight.source === "manual" ? "your last weigh-in" : "your scale or watch"}, ${fmtDay(weight.day)}.`
          : "No weight yet: it comes from a synced weigh-in or one you log."}
        {live.missing.length > 0 && ` Missing for the energy figures: ${live.missing.join(", ")}.`}
      </p>
      <div className="viz-tiles">
        <StatTile label="Age" value={live.ageYears === null ? null : String(live.ageYears)} unit="years" />
        <StatTile label="BMI" value={live.bmi ? live.bmi.value.toFixed(1) : null} note={live.bmi ? BMI_WORD[live.bmi.class] : undefined} />
        <StatTile label="Basal (BMR)" value={kcal(live.bmrKcal)} unit="kcal" />
        <StatTile label="Daily energy" value={kcal(live.tdeeKcal)} unit="kcal" />
        <StatTile label="Calorie target" value={kcal(live.target?.kcal ?? null)} unit="kcal" note={live.target?.floored ? "held at BMR: the goal would need less" : undefined} />
        <StatTile label="Protein" value={live.proteinG === null ? null : String(live.proteinG)} unit="g a day" />
      </div>
      {live.healthyWeight && (
        <p className="muted small">
          Healthy weight for your height (BMI 18.5 to 24.9): {live.healthyWeight.minKg} to {live.healthyWeight.maxKg} kg. BMI does not tell fat from muscle.
        </p>
      )}
      <p className="muted small">
        Estimates (Mifflin-St Jeor, activity factor, 7,700 kcal per kg), usually within about 10%. Not medical advice. Set the calorie
        target you want to follow in Food.
      </p>
    </div>
  );
}
