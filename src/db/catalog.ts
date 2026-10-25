import type { CatalogEntry } from "../sources/types";
import type { SqlDriver } from "./driver";

export type MetricCategory = "sleep" | "recovery" | "activity" | "heart" | "stress" | "body" | "nutrition" | "other";
export type DailyAgg = "avg" | "sum" | "min" | "max" | "last";

/** First guess at how to show a metric, from its name. The user can change it later. */
export function classifyMetric(metric: string): { category: MetricCategory; dailyAgg: DailyAgg } {
  const n = metric.toLowerCase();
  if (n.startsWith("sleep_")) return { category: "sleep", dailyAgg: "last" };
  if (n.startsWith("dailybodybattery_") || n.includes("hrv")) return { category: "recovery", dailyAgg: "last" };
  if (n.startsWith("stress_") || n.includes("stress")) return { category: "stress", dailyAgg: "avg" };
  if (n.includes("heartrate") || n.startsWith("pulseox_")) return { category: "heart", dailyAgg: "avg" };
  if (n.startsWith("body_") || n.startsWith("usermetrics_")) return { category: "body", dailyAgg: "last" };
  if (n.startsWith("nutrition_") || n.startsWith("food_") || n.startsWith("drink_")) return { category: "nutrition", dailyAgg: "sum" };
  if (n.startsWith("daily_") || n.startsWith("activity_") || n.includes("steps")) return { category: "activity", dailyAgg: "sum" };
  return { category: "other", dailyAgg: "avg" };
}

/**
 * Record what the source says it has. Facts from the source are refreshed;
 * the user's display choices (label, category, daily_agg, pinned, ...) are never overwritten.
 */
export async function upsertCatalog(
  db: SqlDriver,
  source: string,
  entries: CatalogEntry[],
  nowMs: number = Date.now(),
): Promise<void> {
  for (const e of entries) {
    const guess = classifyMetric(e.metric);
    await db.run(
      `INSERT INTO metric_catalog
         (source, metric, unit, device, first_day, last_day, records, category, daily_agg, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (source, metric) DO UPDATE SET
         unit = COALESCE(excluded.unit, metric_catalog.unit),
         device = COALESCE(excluded.device, metric_catalog.device),
         first_day = excluded.first_day,
         last_day = excluded.last_day,
         records = excluded.records,
         updated_at = excluded.updated_at`,
      [
        source,
        e.metric,
        e.unit ?? null,
        e.device ?? null,
        e.firstDay ?? null,
        e.lastDay ?? null,
        e.records ?? null,
        guess.category,
        guess.dailyAgg,
        nowMs,
      ],
    );
  }
}
