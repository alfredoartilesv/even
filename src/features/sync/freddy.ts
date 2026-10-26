import { addDays, localDay } from "../../core/tz";
import { parseListMetrics, parseQueryMetrics, type MetricInfo } from "./freddyText";
import type { CatalogEntry, SampleInput, Source, SyncResult } from "./types";
import { createLogger } from "../../core/log";

const log = createLogger("sync.freddy");

/**
 * Anything that can call a freddy MCP tool and hand back its text output.
 * The real implementation wraps an MCP client (Streamable HTTP); tests use a fake.
 */
export interface ToolCaller {
  callTool(name: string, args: Record<string, unknown>): Promise<string>;
}

export interface FreddyOptions {
  caller: ToolCaller;
  /** Used until the first response tells us the account timezone. */
  timeZone?: string;
  /** Days the plan lets us read. FREE plan = 7. */
  windowDays?: number;
  /** Explicit metric names. Default: discover with list_metrics and keep the daily/summary ones. */
  metrics?: string[];
  now?: () => number;
}

/** High-volume or raw-only metric families we do not mirror by default. */
const EXCLUDE = [/^epoch_/, /^respiration_/, /^moveIQ_/, /_samples$/];
const INCLUDE = [/^daily_/, /^dailyBodyBattery_/, /^sleep_/, /^pulseOx_/, /^stress_/, /^body_/, /^userMetrics_/, /^activity_/];
const MAX_METRICS_PER_CALL = 50; // query_metrics accepts at most 50 names

export function defaultMetricFilter(all: MetricInfo[]): string[] {
  return all.map((m) => m.name).filter((n) => INCLUDE.some((r) => r.test(n)) && !EXCLUDE.some((r) => r.test(n)));
}

export class FreddySource implements Source {
  readonly id = "freddy";
  private readonly opts: Required<Omit<FreddyOptions, "metrics">> & Pick<FreddyOptions, "metrics">;

  constructor(opts: FreddyOptions) {
    this.opts = {
      timeZone: "Europe/Madrid",
      windowDays: 7,
      now: Date.now,
      ...opts,
    };
  }

  async fetchSince(cursor: string | null): Promise<SyncResult> {
    const { caller, windowDays, now } = this.opts;
    const warnings: string[] = [];
    let tz = this.opts.timeZone;

    const today = localDay(now(), tz);
    const windowStart = addDays(today, -(windowDays - 1));

    let start = windowStart;
    if (cursor) {
      if (cursor > windowStart) {
        start = cursor;
      } else if (cursor < windowStart) {
        warnings.push(
          `Gap: last sync covered up to ${cursor}, but the plan only allows the last ${windowDays} days. ` +
            `${addDays(cursor, 1)} to ${addDays(windowStart, -1)} could not be fetched.`,
        );
      }
    }

    log.debug("window", { start, end: today, firstSync: !cursor });
    let names = this.opts.metrics;
    let catalog: CatalogEntry[] | undefined;
    if (!names) {
      const listed = parseListMetrics(await caller.callTool("list_metrics", {}));
      names = defaultMetricFilter(listed);
      catalog = listed.map((m) => ({
        metric: m.name,
        unit: m.unit,
        device: m.device,
        firstDay: m.from,
        lastDay: m.to,
        records: m.records,
      }));
    }
    log.debug("metrics selected", { metrics: names.length, discovered: catalog?.length ?? null });
    if (names.length === 0) {
      warnings.push("No metrics selected (list_metrics returned nothing usable).");
    }

    const samples: SampleInput[] = [];
    for (let i = 0; i < names.length; i += MAX_METRICS_PER_CALL) {
      const chunk = names.slice(i, i + MAX_METRICS_PER_CALL);
      const text = await caller.callTool("query_metrics", { metrics: chunk, start, end: today });
      const parsed = parseQueryMetrics(text, tz, this.id);
      if (parsed.timeZone) tz = parsed.timeZone;
      samples.push(...parsed.samples);
      log.debug("chunk parsed", { chunk: i / MAX_METRICS_PER_CALL + 1, metrics: chunk.length, samples: parsed.samples.length, skipped: parsed.skipped.length });
      if (parsed.skipped.length > 0) {
        warnings.push(`${parsed.skipped.length} line(s) not understood, e.g. "${parsed.skipped[0]}"`);
      }
    }

    // Re-fetch yesterday next time: it may have been incomplete at the last read.
    return { samples, catalog, nextCursor: addDays(today, -1), warnings };
  }
}
