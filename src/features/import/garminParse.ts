import { createLogger } from "../../core/log";
import { parseGarminExport, type GarminImport } from "./garmin";
import { readGarminZip } from "./garminImport";

const log = createLogger("import.garmin");

/** Unpack and parse a Garmin export ZIP in a worker, so the screen keeps moving; on the main thread where there are no workers. */
export async function parseGarminZip(bytes: Uint8Array, timeZone: string): Promise<GarminImport> {
  const done = log.time("garmin export parsed", "info");
  if (typeof Worker === "undefined") {
    const parsed = parseGarminExport(readGarminZip(bytes), { timeZone });
    done({ samples: parsed.samples.length, worker: false });
    return parsed;
  }
  const worker = new Worker(new URL("./garminWorker.ts", import.meta.url), { type: "module" });
  try {
    const parsed = await new Promise<GarminImport>((resolve, reject) => {
      worker.onmessage = (e: MessageEvent<{ ok: true; parsed: GarminImport } | { ok: false; message: string }>) =>
        e.data.ok ? resolve(e.data.parsed) : reject(new Error(e.data.message));
      worker.onerror = (e) => reject(new Error(e.message || "The export could not be read"));
      // Moved, not copied: the bytes are not needed here again.
      worker.postMessage({ bytes, timeZone }, [bytes.buffer]);
    });
    done({ samples: parsed.samples.length, worker: true });
    return parsed;
  } finally {
    worker.terminate();
  }
}
