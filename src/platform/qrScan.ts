import { createLogger } from "../core/log";

const log = createLogger("qr.scan");

/** Why the camera could not be used, for a message the owner can act on. */
export type CameraProblem = "denied" | "no-camera" | "unsupported" | "failed";

export class CameraError extends Error {
  constructor(readonly problem: CameraProblem) {
    super(`Camera ${problem}`);
    this.name = "CameraError";
  }
}

// Not in TypeScript's DOM types yet. Chrome on Android (the WebView too) and on macOS has it;
// Chrome on Windows and Firefox do not, so jsQR reads the frames there.
interface Detector {
  detect(source: CanvasImageSource): Promise<{ rawValue: string }[]>;
}
interface DetectorClass {
  new (o: { formats: string[] }): Detector;
  getSupportedFormats(): Promise<string[]>;
}

type Decode = (video: HTMLVideoElement) => Promise<string | null>;

async function nativeDecoder(): Promise<Decode | null> {
  const D = (globalThis as { BarcodeDetector?: DetectorClass }).BarcodeDetector;
  if (!D) return null;
  try {
    if (!(await D.getSupportedFormats()).includes("qr_code")) return null;
  } catch {
    return null;
  }
  const d = new D({ formats: ["qr_code"] });
  return async (video) => (await d.detect(video))[0]?.rawValue ?? null;
}

async function jsQrDecoder(): Promise<Decode> {
  // Loaded only here: most opens of the app never scan anything.
  const { default: jsQR } = await import("jsqr");
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new CameraError("unsupported");
  return async (video) => {
    // A smaller frame reads as well for a code that fills the viewfinder, and much faster.
    const scale = Math.min(1, 640 / Math.max(video.videoWidth, video.videoHeight));
    canvas.width = Math.round(video.videoWidth * scale);
    canvas.height = Math.round(video.videoHeight * scale);
    if (!canvas.width || !canvas.height) return null;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
    return jsQR(img.data, img.width, img.height, { inversionAttempts: "attemptBoth" })?.data ?? null;
  };
}

function problemOf(err: unknown): CameraProblem {
  const name = err instanceof Error ? err.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") return "denied";
  if (name === "NotFoundError" || name === "OverconstrainedError") return "no-camera";
  return "failed";
}

/**
 * Shows the back camera in `video` and reads QR codes from it until `accept` takes one or `signal`
 * aborts; the camera is switched off either way. Rejects with a CameraError when there is no
 * camera to use. On Android the WebView asks for the camera permission the first time.
 */
export async function scanQr(video: HTMLVideoElement, accept: (text: string) => boolean, signal: AbortSignal): Promise<void> {
  if (!navigator.mediaDevices?.getUserMedia) throw new CameraError("unsupported");
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" } }, audio: false });
  } catch (err) {
    const problem = problemOf(err);
    log.warn("camera not opened", { problem });
    throw new CameraError(problem);
  }
  const stop = () => {
    for (const t of stream.getTracks()) t.stop();
    video.srcObject = null;
  };
  if (signal.aborted) return stop();
  signal.addEventListener("abort", stop, { once: true });
  try {
    video.srcObject = stream;
    video.muted = true;
    video.setAttribute("playsinline", "");
    await video.play();
    const decode = (await nativeDecoder()) ?? (await jsQrDecoder());
    const started = Date.now();
    while (!signal.aborted) {
      const text = video.readyState >= 2 ? await decode(video).catch(() => null) : null;
      if (text !== null && accept(text)) {
        log.info("code read", { ms: Date.now() - started });
        return;
      }
      await new Promise((r) => setTimeout(r, 150));
    }
  } catch (err) {
    if (signal.aborted) return;
    throw err instanceof CameraError ? err : new CameraError("failed");
  } finally {
    signal.removeEventListener("abort", stop);
    stop();
  }
}
