import { parseGarminExport } from "./garmin";
import { readGarminZip } from "./garminImport";

/** Unpacks and parses a Garmin export off the main thread: a 77 MB ZIP froze the screen for seconds. */
const ctx = self as unknown as { onmessage: ((e: MessageEvent<{ bytes: Uint8Array; timeZone: string }>) => void) | null; postMessage(m: unknown): void };

ctx.onmessage = (e) => {
  try {
    ctx.postMessage({ ok: true, parsed: parseGarminExport(readGarminZip(e.data.bytes), { timeZone: e.data.timeZone }) });
  } catch (err) {
    ctx.postMessage({ ok: false, message: err instanceof Error ? err.message : String(err) });
  }
};
