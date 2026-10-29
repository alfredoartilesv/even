/**
 * The chat box while dictating: what was typed before the microphone was tapped stays, and the
 * recognizer's running text follows it (each update replaces the previous one, it does not add).
 */
export function withDictation(typed: string, heard: string): string {
  const spoken = heard.replace(/\s+/g, " ").trim();
  if (!spoken) return typed;
  const before = typed.replace(/\s+$/, "");
  if (!before) return spoken.charAt(0).toUpperCase() + spoken.slice(1);
  return `${before} ${spoken}`;
}

/** The recognizer's language: the phone's (navigator.language), "es-ES" style; English when unknown. */
export function dictationLanguage(navigatorLanguage: string | undefined): string {
  const l = (navigatorLanguage ?? "").trim();
  return /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/i.test(l) ? l : "en-US";
}

/** Shown when listening stopped with an error (recognizer codes from Android, iOS and the browser). */
export function dictationError(code: string | undefined): string | null {
  if (!code) return null;
  // Android SpeechRecognizer numbers: 1 network timeout, 2 network, 6 speech timeout, 7 no match, 9 permissions.
  if (code === "9" || /permission|not-allowed|insufficient/i.test(code)) return "Allow the microphone for Even in the phone's settings to dictate.";
  if (code === "6" || code === "7" || /no.?match|no-speech|speech.?timeout|aborted/i.test(code)) return null; // nothing heard: not worth a message
  if (code === "1" || code === "2" || /network/i.test(code)) return "Dictation needs a connection, or the offline language pack for this language.";
  return "Dictation stopped. Try again.";
}
