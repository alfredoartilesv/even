import { SpeechRecognition } from "@capgo/capacitor-speech-recognition";
import type { PluginListenerHandle } from "@capacitor/core";
import { createLogger } from "../core/log";
import { isNative } from "./device";

const log = createLogger("platform.speech");

/**
 * Dictation for the chat box: speech to text, nothing more. On the phone it is the system
 * recognizer (Android's SpeechRecognizer, iOS Speech), on-device when the phone has the language
 * pack; the audio is never sent to Claude, only the text the owner then sends. In the browser it
 * is the Web Speech API where it exists (Chrome), otherwise unavailable.
 */
export interface Dictation {
  available(): Promise<boolean>;
  /**
   * Start listening. onText gets the whole text heard so far (it replaces the previous call's
   * text), onEnd fires once when listening stops, by silence, stop() or an error. Resolves false
   * when the microphone permission was refused.
   */
  start(opts: { language: string; onText: (text: string) => void; onEnd: (error?: string) => void }): Promise<boolean>;
  stop(): Promise<void>;
}

const native: Dictation = {
  async available() {
    try {
      return (await SpeechRecognition.available()).available;
    } catch (err) {
      log.warn("availability check failed", { err });
      return false;
    }
  },
  async start({ language, onText, onEnd }) {
    let { speechRecognition } = await SpeechRecognition.checkPermissions();
    if (speechRecognition !== "granted") ({ speechRecognition } = await SpeechRecognition.requestPermissions());
    if (speechRecognition !== "granted") {
      log.info("microphone permission refused", { state: speechRecognition });
      return false;
    }
    await SpeechRecognition.removeAllListeners();
    const handles: PluginListenerHandle[] = [];
    let ended = false;
    const end = (error?: string) => {
      if (ended) return;
      ended = true;
      for (const h of handles) void h.remove();
      onEnd(error);
    };
    handles.push(
      await SpeechRecognition.addListener("partialResults", (e) => {
        const t = e.accumulatedText ?? e.matches?.[0];
        if (t) onText(t);
      }),
      await SpeechRecognition.addListener("listeningState", (e) => {
        if (e.state === "stopped" || e.status === "stopped") end();
      }),
      await SpeechRecognition.addListener("error", (e) => {
        log.warn("recognition error", { code: e.code });
        end(e.code);
      }),
    );
    try {
      // partialResults: start() returns at once and the text arrives through the listener.
      await SpeechRecognition.start({ language, partialResults: true, popup: false, addPunctuation: true, maxResults: 1 });
      log.debug("listening", { language });
      return true;
    } catch (err) {
      log.warn("start failed", { err });
      end("start_failed");
      return true;
    }
  },
  async stop() {
    await SpeechRecognition.stop().catch((err) => log.warn("stop failed", { err }));
  },
};

/** The browser's recognizer (Chrome prefixes it). Typed loosely: not every TS DOM lib has it. */
interface WebRecognition {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onend: (() => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  start(): void;
  stop(): void;
}
type WebRecognitionCtor = new () => WebRecognition;
const WebCtor =
  (globalThis as { SpeechRecognition?: WebRecognitionCtor; webkitSpeechRecognition?: WebRecognitionCtor }).SpeechRecognition ??
  (globalThis as { webkitSpeechRecognition?: WebRecognitionCtor }).webkitSpeechRecognition;

let current: WebRecognition | null = null;

const web: Dictation = {
  async available() {
    return Boolean(WebCtor);
  },
  async start({ language, onText, onEnd }) {
    if (!WebCtor) return false;
    const r = new WebCtor();
    r.lang = language;
    r.interimResults = true;
    r.continuous = true;
    let error: string | undefined;
    r.onresult = (e) => onText(Array.from(e.results, (res) => res[0]?.transcript ?? "").join(""));
    r.onerror = (e) => {
      error = e.error;
      log.warn("recognition error", { code: e.error });
    };
    r.onend = () => {
      current = null;
      onEnd(error);
    };
    current = r;
    r.start();
    return error !== "not-allowed";
  },
  async stop() {
    current?.stop();
  },
};

export const dictation: Dictation = isNative ? native : web;
