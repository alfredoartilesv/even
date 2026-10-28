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
