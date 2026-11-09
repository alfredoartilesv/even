import test from "node:test";
import assert from "node:assert/strict";
import { loadDashboard } from "../src/domain/dashboard/dashboard";
import { addShoppingItem, listShopping, setShoppingChecked } from "../src/domain/mealprep/shopping";
import { addMonths, addTrip, deleteTrip, knownShops, listTrips, monthlySpending, monthRange, restoreTrip, spending } from "../src/domain/mealprep/spending";
import { migratedDb } from "./helpers";

const TZ = "Europe/Madrid";
const TODAY = "2026-10-26";
const NOW = Date.parse("2026-10-26T18:00:00Z"); // 19:00 in Madrid (CET)

test("shops: refuse a missing supermarket, amount or a future day, with a message safe to show", async () => {
  const { db } = await migratedDb();
  const add = (t: Parameters<typeof addTrip>[1]) => addTrip(db, t, "user", NOW);
  await assert.rejects(add({ shop: "  ", amount: 20, timeZone: TZ }), /Which supermarket/);
  await assert.rejects(add({ shop: "Mercadona", amount: null, timeZone: TZ }), /Enter what you paid/);
  await assert.rejects(add({ shop: "Mercadona", amount: 0, timeZone: TZ }), /Enter what you paid/);
  await assert.rejects(add({ shop: "Mercadona", amount: NaN, timeZone: TZ }), /Enter what you paid/);
  await assert.rejects(add({ shop: "Mercadona", amount: 20_000, timeZone: TZ }), /at most/);
  await assert.rejects(add({ shop: "Mercadona", amount: 20, day: "2026-10-27", timeZone: TZ }), /not happened yet/);
  assert.equal((await listTrips(db, "2000-01-01", TODAY)).length, 0, "nothing saved by a refused input");
});

test("shops: saved on the owner's day, listed newest first, summed per supermarket and month", async () => {
  const { db } = await migratedDb();
  const add = (t: Parameters<typeof addTrip>[1]) => addTrip(db, t, "user", NOW);
  await add({ shop: "Mercadona", amount: 54.321, day: "2026-10-03", timeZone: TZ });
  await add({ shop: " Lidl ", amount: 21.5, day: "2026-10-12", timeZone: TZ, notes: " fruit " });
  await add({ shop: "mercadona", amount: 30, timeZone: TZ });
  await add({ shop: "Carrefour", amount: 80, day: "2026-09-20", timeZone: TZ });

  const oct = await listTrips(db, "2026-10-01", "2026-10-31");
  assert.deepEqual(
    oct.map((t) => [t.shop, t.amount, t.day]),
    [
      ["mercadona", 30, TODAY],
      ["Lidl", 21.5, "2026-10-12"],
      ["Mercadona", 54.32, "2026-10-03"],
    ],
    "trimmed, rounded to cents, newest first",
  );
  assert.equal(oct[0].atMs, NOW, "today keeps the time it was logged");
  assert.equal(oct[1].atMs, Date.parse("2026-10-12T10:00:00Z"), "a past day is stored at noon local time (CEST)");
  assert.equal(oct[1].notes, "fruit");

  assert.deepEqual(
    await spending(db, "2026-10-01", "2026-10-31"),
    {
      total: 105.82,
      trips: 3,
      shops: [
        { shop: "mercadona", total: 84.32, trips: 2 },
        { shop: "Lidl", total: 21.5, trips: 1 },
      ],
    },
    "one line per supermarket whatever the case, in its latest spelling, biggest first",
  );

  assert.deepEqual(await knownShops(db), ["mercadona", "Lidl", "Carrefour"], "each supermarket once, most recent first");

  assert.deepEqual(await monthlySpending(db, "2026-10", 3), [
    { month: "2026-08", total: 0 },
    { month: "2026-09", total: 80 },
    { month: "2026-10", total: 105.82 },
  ]);

  await deleteTrip(db, oct[0].id, NOW);
  assert.equal((await spending(db, "2026-10-01", "2026-10-31")).total, 75.82);
  await restoreTrip(db, oct[0].id, NOW);
  assert.equal((await spending(db, "2026-10-01", "2026-10-31")).total, 105.82, "undo puts it back");
});

test("shops: logging one can clear the ticked shopping list items and counts them", async () => {
  const { db } = await migratedDb();
  for (const name of ["Rice", "Oats", "Eggs"]) await addShoppingItem(db, { name, quantity: null, unit: null }, NOW);
  const items = await listShopping(db);
  await setShoppingChecked(db, items.find((i) => i.name === "Rice")!.id, true, NOW);
  await setShoppingChecked(db, items.find((i) => i.name === "Eggs")!.id, true, NOW);

  await addTrip(db, { shop: "Mercadona", amount: 12, timeZone: TZ, clearTicked: true }, "user", NOW);
  assert.deepEqual(
    (await listShopping(db)).map((i) => i.name),
    ["Oats"],
    "only the ticked items go",
  );
  assert.equal((await listTrips(db, TODAY, TODAY))[0].items, 2);

  await addTrip(db, { shop: "Lidl", amount: 5, timeZone: TZ }, "user", NOW + 60_000);
  assert.equal((await listTrips(db, TODAY, TODAY))[0].items, null, "not from the list");
  assert.equal((await listShopping(db)).length, 1);
});

test("months: ranges, steps across years", () => {
  assert.deepEqual(monthRange("2026-02"), { from: "2026-02-01", to: "2026-02-28" });
  assert.deepEqual(monthRange("2028-02"), { from: "2028-02-01", to: "2028-02-29" });
  assert.equal(addMonths("2026-01", -1), "2025-12");
  assert.equal(addMonths("2026-11", 3), "2027-02");
});

test("dashboard: groceries paid in the span, in the app currency", async () => {
  const { db } = await migratedDb();
  await addTrip(db, { shop: "Mercadona", amount: 40, day: "2026-10-20", timeZone: TZ }, "user", NOW);
  await addTrip(db, { shop: "Lidl", amount: 15.5, day: "2026-10-22", timeZone: TZ }, "user", NOW);
  await addTrip(db, { shop: "Lidl", amount: 9, day: "2026-10-15", timeZone: TZ }, "user", NOW);

  const week = await loadDashboard(db, "week", "2026-10-22", TODAY);
  assert.deepEqual(week.groceries, { total: 55.5, trips: 2, currency: "EUR" }, "the seven days up to the 22nd, not the day before them");
  const day = await loadDashboard(db, "day", TODAY, TODAY);
  assert.deepEqual([day.groceries.total, day.groceries.trips], [0, 0]);
});
