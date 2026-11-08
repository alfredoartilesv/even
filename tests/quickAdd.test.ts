import test from "node:test";
import assert from "node:assert/strict";
import type { DrinkType } from "../src/domain/alcohol/alcohol";
import { parseQuickAdd } from "../src/domain/food/quickAdd";
import type { Candidate } from "../src/domain/food/suggest";

const food = (name: string, uses = 1): Candidate => ({
  key: `name:${name}`,
  savedMealId: null,
  lastEntryId: `e-${name}`,
  name,
  calories: 100,
  photoId: null,
  uses,
  lastMs: 0,
  slots: {},
  defaultMeal: null,
  loggedToday: false,
});
const drink = (name: string, uses = 1): DrinkType => ({
  id: name,
  name,
  volumeMl: 330,
  abvPercent: 5,
  calories: null,
  price: 3,
  createdBy: "user",
  uses,
  lastMs: null,
});
const known = {
  foods: [food("Scrambled eggs", 4), food("Toast"), food("Coffee with milk", 9)],
  drinks: [drink("Beer 33 cl", 5), drink("Red wine")],
};

test("quick add: each part of a meal finds the food logged before, with its count", () => {
  const lines = parseQuickAdd("2 eggs, toast and a coffee", known);
  assert.deepEqual(
    lines.map((l) => (l.kind === "food" ? [l.candidate.name, l.count] : l.kind)),
    [
      ["Scrambled eggs", 2],
      ["Toast", 1],
      ["Coffee with milk", 1],
    ],
  );
});

test("quick add: a drink by name or by its kind, a weight is not taken for food or drink, and what it does not know stays as text", () => {
  assert.deepEqual(parseQuickAdd("82.1 kg", known), [{ kind: "unknown", part: "82.1 kg" }]);
  const [beer] = parseQuickAdd("Beer 330 ml", known);
  assert.equal(beer.kind === "drink" && beer.type.name, "Beer 33 cl");
  const [two] = parseQuickAdd("two glasses of wine", known);
  assert.ok(two.kind === "drink" && two.type.name === "Red wine" && two.count === 2);
  assert.deepEqual(parseQuickAdd("dragon fruit", known), [{ kind: "unknown", part: "dragon fruit" }]);
});
