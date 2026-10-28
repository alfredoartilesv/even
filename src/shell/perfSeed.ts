import type { SqlDriver } from "../db/driver";
import { getSetting, setSetting } from "../db/settings";
import { upsertSamples } from "../domain/metrics/samples";
import type { SampleInput } from "../domain/sync/types";

/**
 * Data for timing builds only (scripts/perf-device.mjs): about as much as a real phone after the
 * Garmin export import, so the emulator measures the database at its real size. Imported only when
 * the build sets VITE_PERF_SEED, so normal builds do not contain it. Runs once per install.
 */
const DAYS = 300;
const METRICS = 140;
const DONE = "perf.seeded";

export async function seedForPerf(db: SqlDriver): Promise<void> {
  if (await getSetting(db, DONE)) return;
  const today = Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate());
  const names = ["daily_steps", "daily_totalKilocalories", "daily_activeKilocalories", ...Array.from({ length: METRICS - 3 }, (_, i) => `perf_metric_${i}`)];
  const samples: SampleInput[] = [];
  for (let d = 0; d < DAYS; d++) {
    const day = new Date(today - d * 86_400_000).toISOString().slice(0, 10);
    for (const [i, metric] of names.entries()) {
      samples.push({
        source: "garmin_export",
        device: "Garmin",
        externalId: `${day}#0`,
        metric,
        startMs: Date.parse(`${day}T00:00:00Z`),
        endMs: Date.parse(`${day}T00:00:00Z`) + 86_400_000,
        offsetMin: 60,
        valueNum: metric === "daily_steps" ? 6000 + ((d * 7919) % 8000) : (d * 31 + i * 17) % 3000,
        raw: { day, metric, note: "perf seed" },
      });
    }
  }
  await upsertSamples(db, samples);
  await setSetting(db, DONE, String(samples.length));
}
