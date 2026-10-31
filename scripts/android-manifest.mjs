/**
 * Changes to the generated AndroidManifest.xml, as pure functions (tests/chatV03.test.ts).
 * Applied by scripts/android-harden.mjs after every `cap add` / `cap sync`.
 */

const QUERY_MARK = "android.speech.RecognitionService";
const QUERY = `    <queries>
        <intent>
            <action android:name="${QUERY_MARK}" />
        </intent>
    </queries>
`;

/**
 * Package visibility (Android 11+): an app sees the system's speech recognition service only if
 * its manifest asks for it, otherwise SpeechRecognizer says recognition is unavailable and the
 * chat's microphone button never shows. Idempotent. RECORD_AUDIO itself comes from the plugin's
 * own manifest, merged at build time.
 */
export function addRecognitionQuery(manifest) {
  if (manifest.includes(QUERY_MARK)) return manifest;
  if (!/<\/manifest>/.test(manifest)) throw new Error("AndroidManifest.xml has no </manifest>");
  return manifest.replace(/<\/manifest>/, `${QUERY}</manifest>`);
}

const CAMERA_MARK = "android.permission.CAMERA";
const CAMERA = `    <uses-permission android:name="${CAMERA_MARK}" />
    <uses-feature android:name="android.hardware.camera" android:required="false" />
`;

/**
 * The pairing QR scanner reads the camera through the WebView (getUserMedia). Capacitor's WebView
 * asks the owner for the camera on the first scan, but only for a permission the manifest declares.
 * The camera is optional, so the app still installs on a device without one. Idempotent.
 */
export function addCameraPermission(manifest) {
  if (manifest.includes(CAMERA_MARK)) return manifest;
  if (!/<\/manifest>/.test(manifest)) throw new Error("AndroidManifest.xml has no </manifest>");
  return manifest.replace(/<\/manifest>/, `${CAMERA}</manifest>`);
}
