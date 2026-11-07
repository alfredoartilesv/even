import test from "node:test";
import assert from "node:assert/strict";
import { listGoals } from "../src/domain/me/goals";
import { loadTargets, setTarget } from "../src/domain/me/targets";
import { finishFirstRun, needsFirstRun, saveFirstTargets } from "../src/domain/settings/onboarding";
import { memorySecretStore } from "../src/domain/settings/secrets";
import { migratedDb } from "./helpers";

const TODAY = "2026-11-07";

test("targets: calories and macros are the food log's targets, steps and drinks one live goal each, replaced on change", async () => {
  const { db } = await migratedDb();
  assert.deepEqual(await loadTargets(db, TODAY), { kcal: null, protein: null, carbs: null, fat: null, steps: null, drinks: null });
  await setTarget(db, "kcal", 2100, TODAY, 1);
  await setTarget(db, "steps", 9000, TODAY, 2);
  await setTarget(db, "steps", 10000, TODAY, 3);
  await setTarget(db, "drinks", 7, TODAY, 4);
  assert.deepEqual(await loadTargets(db, TODAY), { kcal: 2100, protein: null, carbs: null, fat: null, steps: 10000, drinks: 7 });
  const goals = await listGoals(db, TODAY);
  assert.equal(goals.filter((g) => g.metric === "daily_steps").length, 1, "the old steps goal is gone");
  await setTarget(db, "drinks", null, TODAY, 5);
  assert.equal((await loadTargets(db, TODAY)).drinks, null);
});

test("first run: a fresh install needs it, finishing it or saving its targets is remembered", async () => {
  const { db } = await migratedDb();
  const secrets = memorySecretStore();
  assert.equal(await needsFirstRun(db, secrets), true);
  await saveFirstTargets(db, { kcal: 2300, proteinG: 150, drinksPerWeek: 10 }, TODAY, 1);
  assert.deepEqual(await loadTargets(db, TODAY), { kcal: 2300, protein: 150, carbs: null, fat: null, steps: null, drinks: 10 });
  await finishFirstRun(db, 2);
  assert.equal(await needsFirstRun(db, secrets), false);
});
