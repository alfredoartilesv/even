import { unzipSync } from "fflate";
import { createLogger } from "../../core/log";
import type { SqlDriver } from "../../db/driver";
import { withTransaction } from "../../db/tx";
import { upsertCatalog } from "../metrics/catalog";
import { upsertSamples } from "../metrics/samples";
import { GARMIN_EXPORT_SOURCE, garminKind, parseGarminExport, type GarminFile, type GarminImport } from "./garmin";

/**
 * Read a Garmin export ZIP and store it. fflate runs in Node and in the WebView: the app imports the
 * ZIP from Settings > Connections, and scripts/garmin-import.ts does the same on the PC.
 */

const log = createLogger("import.garmin");

/** Unpack only the JSON files the parser reads (the export also holds ~80 MB of FIT files and images). */
export function readGarminZip(bytes: Uint8Array): GarminFile[] {
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(bytes, { filter: (f) => garminKind(f.name) !== null });
  } catch {
    throw new Error("This is not a readable ZIP file");
  }
  const files: GarminFile[] = [];
  const decoder = new TextDecoder();
  for (const [path, data] of Object.entries(entries)) {
    try {
      files.push({ path, json: JSON.parse(decoder.decode(data)) });
    } catch {
      log.warn("unreadable JSON in the export, skipped", { kind: garminKind(path) });
    }
  }
  if (files.length === 0) throw new Error("No Garmin Connect data found. Is this the ZIP Garmin emailed (with a DI_CONNECT folder)?");
  return files;
}

/**
 * Store a parsed export: samples (idempotent upsert, so importing the same ZIP twice changes
 * nothing) and catalog rows (their daily aggregation defaults come from classifyMetric).
 * One transaction. Returns the number of samples written.
 */
export async function storeGarminImport(
  db: SqlDriver,
  parsed: GarminImport,
  nowMs: number = Date.now(),
  onProgress?: (saved: number, total: number) => void,
): Promise<number> {
  const done = log.time("garmin export stored", "info");
  const written = await withTransaction(db, async () => {
    const n = await upsertSamples(db, parsed.samples, nowMs, undefined, onProgress);
    await upsertCatalog(db, GARMIN_EXPORT_SOURCE, parsed.catalog, nowMs);
    return n;
  });
  done({ samples: written, metrics: parsed.catalog.length });
  return written;
}

export async function importGarminZip(db: SqlDriver, bytes: Uint8Array, opts: { timeZone: string; nowMs?: number }): Promise<{ written: number; parsed: GarminImport }> {
  const parsed = parseGarminExport(readGarminZip(bytes), { timeZone: opts.timeZone });
  const written = await storeGarminImport(db, parsed, opts.nowMs);
  return { written, parsed };
}

/** Largest ZIP the phone reads in one go (it is held in memory while the JSON files are unpacked). */
export const MAX_ZIP_BYTES = 1024 * 1024 * 1024;

export interface ExportCoverage {
  readings: number;
  from: string | null;
  to: string | null;
}

/** What the Garmin export import has stored so far: readings, first and last day. */
export async function garminExportCoverage(db: SqlDriver): Promise<ExportCoverage> {
  const [r] = await db.all<{ n: number; f: string | null; t: string | null }>(
    "SELECT COUNT(*) AS n, MIN(local_day) AS f, MAX(local_day) AS t FROM health_samples WHERE source = ?",
    [GARMIN_EXPORT_SOURCE],
  );
  return { readings: r.n, from: r.f, to: r.t };
}
