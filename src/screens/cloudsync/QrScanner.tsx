import { useEffect, useRef, useState } from "react";
import { CameraError, scanQr, type CameraProblem } from "../../platform/qrScan";

// What to do next, in the owner's words, for each way the camera can fail.
const PROBLEM: Record<CameraProblem, string> = {
  denied: "Even may not use the camera. Allow it in the phone's or browser's settings for this app, or type the code instead.",
  "no-camera": "No camera was found on this device. Type the code instead.",
  unsupported: "This browser cannot use the camera here. Type the code instead.",
  failed: "The camera did not start. Close other apps that may be using it and try again, or type the code instead.",
};

interface Props {
  /** Takes a scanned text and says whether it was the code wanted; scanning stops on true. */
  accept: (text: string) => boolean;
  onCancel: () => void;
  /** Shown under the viewfinder while it looks. */
  hint: string;
}

/** A live camera viewfinder that reads QR codes. The camera is off again as soon as this unmounts. */
export function QrScanner({ accept, onCancel, hint }: Props) {
  const video = useRef<HTMLVideoElement>(null);
  const [problem, setProblem] = useState<CameraProblem | null>(null);
  const [wrong, setWrong] = useState(false);
  const acceptRef = useRef(accept);
  acceptRef.current = accept;

  useEffect(() => {
    const el = video.current;
    if (!el) return;
    const ctl = new AbortController();
    let lastWrong = "";
    scanQr(
      el,
      (text) => {
        const ok = acceptRef.current(text);
        if (!ok && text !== lastWrong) {
          lastWrong = text;
          setWrong(true);
        }
        return ok;
      },
      ctl.signal,
    ).catch((err) => setProblem(err instanceof CameraError ? err.problem : "failed"));
    return () => ctl.abort();
  }, []);

  return (
    <div className="stack">
      {problem ? (
        <p className="error small" role="alert">
          {PROBLEM[problem]}
        </p>
      ) : (
        <>
          <div className="qr-viewfinder">
            <video ref={video} muted playsInline aria-label="Camera view" />
            <span className="qr-frame" aria-hidden="true" />
          </div>
          <p className="muted small" aria-live="polite">
            {wrong ? "That is not an Even pairing code. Point the camera at the code on the new device." : hint}
          </p>
        </>
      )}
      <button type="button" className="secondary" onClick={onCancel}>
        {problem ? "Type the code instead" : "Cancel"}
      </button>
    </div>
  );
}
