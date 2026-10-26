/**
 * Stands in for src/platform/openDatabase.ts when the screens are captured (scripts/screens):
 * an in-memory sql.js database with the real migrations and a month of invented data, so every
 * screen has something to show. Never part of the app build.
 */
import initSqlJs from "sql.js";
import wasmUrl from "sql.js/dist/sql-wasm.wasm?url";
import type { SqlDriver, SqlValue } from "../../src/db/driver";
import { migrate } from "../../src/db/migrate";
import { migrations } from "../../src/db/migrations";
import { addDays, localDay } from "../../src/core/tz";
import { upsertCatalog } from "../../src/features/metrics/catalog";
import { upsertSamples } from "../../src/features/metrics/samples";
import { logFood, saveMeal, setCalorieGoal } from "../../src/features/food/food";
import { logDrink, saveDrinkType } from "../../src/features/alcohol/alcohol";
import { addMove, logBatch, saveMealPrep, DEFAULT_MEAL_PREP } from "../../src/features/mealprep/mealPrep";
import { insertGoal } from "../../src/features/journal/journal";
import { saveProfile } from "../../src/features/settings/profile";
import { appendMessage, createConversation } from "../../src/features/chat/store";
import { recordConsent } from "../../src/features/chat/consent";
import { deviceId } from "../../src/db/settings";
import { secretStore } from "../../src/platform/secureStore";

export const DB_NAME = "health";

let opening: Promise<{ db: SqlDriver; applied: number[] }> | null = null;

export function openDatabase(): Promise<{ db: SqlDriver; applied: number[] }> {
  opening ??= open();
  return opening;
}

/** Deterministic noise, so the screens look the same on every capture. */
function noise(seed: number) {
  let s = seed;
  return () => (s = (s * 16807) % 2147483647) / 2147483647;
}

async function open() {
  const SQL = await initSqlJs({ locateFile: () => wasmUrl });
  const raw = new SQL.Database();
  const db: SqlDriver = {
    async exec(sql) {
      raw.exec(sql);
    },
    async run(sql, params: SqlValue[] = []) {
      raw.run(sql, params as never);
    },
    async all<T>(sql: string, params: SqlValue[] = []) {
      const st = raw.prepare(sql);
      st.bind(params as never);
      const out: T[] = [];
      while (st.step()) out.push(st.getAsObject() as T);
      st.free();
      return out;
    },
  };
  const applied = await migrate(db, migrations);
  await seed(db);
  return { db, applied };
}

async function seed(db: SqlDriver) {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const now = Date.now();
  const today = localDay(now, tz);
  const r = noise(11);
  const dayStart = (d: string) => Date.parse(`${d}T00:00:00Z`);
  const H = 3_600_000;
  const dev = await deviceId(db);
  const stamp = { createdBy: "user" as const, deviceId: dev };

  await saveProfile(db, { name: "Alex Rivera", birthDate: "1990-04-12", sex: "male", heightCm: 178, activity: "moderate", kgPerWeek: -0.25, sports: ["running", "strength"] }, today);
  await setCalorieGoal(db, 2300, addDays(today, -40), now - 40 * 86_400_000);
  await insertGoal(db, { title: "10,000 steps a day", targetKind: "sample", metric: "daily_steps", comparator: ">=", targetNum: 10000, unit: "steps", period: "day", startDay: addDays(today, -30) }, stamp);

  // Synced days: steps, energy, resting heart rate, sleep; workouts every few days.
  await upsertCatalog(db, "freddy", ["daily_steps", "daily_totalKilocalories", "daily_activeKilocalories", "daily_restingHeartRateInBeatsPerMinute", "sleep_durationInSeconds", "activity_activityType", "activity_durationInSeconds", "activity_distanceInMeters", "activity_activeKilocalories"].map((metric) => ({ metric })), now);
  const samples = [];
  for (let i = 0; i < 45; i++) {
    const d = addDays(today, -i);
    const s = dayStart(d);
    const day = (metric: string, valueNum: number) => ({ source: "freddy", device: "Garmin Forerunner", externalId: `${d}#0`, metric, valueNum, startMs: s, endMs: s + 86_400_000, offsetMin: 0 });
    const active = Math.round(350 + r() * 600);
    samples.push(day("daily_steps", Math.round(5500 + r() * 9000)), day("daily_activeKilocalories", active), day("daily_totalKilocalories", 1750 + active), day("daily_restingHeartRateInBeatsPerMinute", Math.round(49 + r() * 6)), day("sleep_durationInSeconds", Math.round((6.3 + r() * 1.8) * 3600)));
    if (i % 3 === 1 || i % 7 === 5) {
      const run = i % 3 === 1;
      const at = { startMs: s + 7 * H, endMs: s + 8 * H };
      const w = (metric: string, v: number | string) => ({ ...day(metric, 0), ...at, ...(typeof v === "string" ? { valueNum: null, valueText: v } : { valueNum: v }) });
      samples.push(w("activity_activityType", run ? "RUNNING" : "STRENGTH_TRAINING"), w("activity_durationInSeconds", run ? Math.round(1800 + r() * 2400) : 2700), w("activity_activeKilocalories", Math.round(300 + r() * 300)));
      if (run) samples.push(w("activity_distanceInMeters", Math.round(5000 + r() * 7000)));
    }
  }
  await upsertSamples(db, samples as never);

  // Food: three meals most days for the last two weeks.
  const meals = [
    { name: "Greek yogurt, oats and berries", meal: "breakfast", calories: 420, proteinG: 28, carbsG: 55, fatG: 9, hour: 8 },
    { name: "Chicken rice bowl", meal: "lunch", calories: 720, proteinG: 48, carbsG: 85, fatG: 18, hour: 14 },
    { name: "Salmon, potatoes and greens", meal: "dinner", calories: 680, proteinG: 42, carbsG: 50, fatG: 30, hour: 21 },
  ] as const;
  for (let i = 0; i < 14; i++) {
    const d = addDays(today, -i);
    for (const m of meals) {
      if (i === 0 && m.hour > new Date().getHours()) continue;
      const f = 0.85 + r() * 0.3;
      await logFood(db, { name: m.name, meal: m.meal, calories: Math.round(m.calories * f), proteinG: Math.round(m.proteinG * f), carbsG: Math.round(m.carbsG * f), fatG: Math.round(m.fatG * f), atMs: dayStart(d) + m.hour * H, timeZone: tz });
    }
  }
  await saveMeal(db, { name: "Chicken rice bowl", meal: "lunch", calories: 720, proteinG: 48, carbsG: 85, fatG: 18 });
  await saveMeal(db, { name: "Greek yogurt, oats and berries", meal: "breakfast", calories: 420, proteinG: 28, carbsG: 55, fatG: 9 });

  // Meal prep: two recipes, two batches, some portions eaten.
  const chili = await saveMealPrep(db, { ...DEFAULT_MEAL_PREP, name: "Turkey chili", portions: 6, calories: 540, proteinG: 45, carbsG: 50, fatG: 14, tags: ["lunch"], ingredients: [{ name: "Turkey mince", quantity: 1000, unit: "g" }, { name: "Kidney beans", quantity: 2, unit: "cans" }, { name: "Chopped tomatoes", quantity: 2, unit: "cans" }] });
  const curry = await saveMealPrep(db, { ...DEFAULT_MEAL_PREP, name: "Lentil curry", portions: 5, calories: 480, proteinG: 24, carbsG: 62, fatG: 12, tags: ["dinner"], ingredients: [{ name: "Red lentils", quantity: 500, unit: "g" }, { name: "Coconut milk", quantity: 1, unit: "can" }] });
  const b1 = await logBatch(db, { mealPrepId: chili, cookedAtMs: now - 3 * 86_400_000, frozen: 2, timeZone: tz });
  await logBatch(db, { mealPrepId: curry, cookedAtMs: now - 1 * 86_400_000, frozen: 3, timeZone: tz });
  for (let i = 2; i >= 1; i--) await addMove(db, { batchId: b1, kind: "eat", portions: 1, atMs: now - i * 86_400_000 + 2 * H, timeZone: tz });

  // Drinks.
  const beer = await saveDrinkType(db, { name: "Beer 33 cl", volumeMl: 330, abvPercent: 5, calories: 145, price: 2.5 });
  const wine = await saveDrinkType(db, { name: "Red wine", volumeMl: 150, abvPercent: 13.5, calories: 125, price: 4 });
  await logDrink(db, { typeId: beer, count: 2, atMs: now - 2 * 86_400_000, timeZone: tz });
  await logDrink(db, { typeId: wine, count: 1, atMs: now - 5 * 86_400_000, timeZone: tz });
  await logDrink(db, { typeId: beer, count: 3, atMs: now - 6 * 86_400_000, timeZone: tz });

  // Claude: a dummy key (in the browser's memory store, never sent: the capture sends no message) and one conversation.
  await secretStore.set("anthropic.api_key", "sk-ant-demo-screens-not-a-real-key");
  await recordConsent(db, "claude.aggregates", true, dev, now);
  const conv = await createConversation(db, dev, { title: "How did I sleep this week?", now: now - H });
  await appendMessage(db, dev, { conversationId: conv, role: "user", content: [{ type: "text", text: "How did I sleep this week compared with last week?" }], now: now - H });
  await appendMessage(db, dev, {
    conversationId: conv,
    role: "assistant",
    content: [{ type: "text", text: "You averaged 7 h 12 min a night this week, 18 minutes more than last week. Your shortest night was Tuesday (6 h 25 min), after the evening run.\n\nResting heart rate held steady at 51 bpm, so the extra sleep looks like recovery rather than catching up." }],
    now: now - H + 20_000,
  });
}
