/**
 * AI Repeat — voice support (FR-06, feature-flagged).
 * Push-to-talk only: nothing records or listens until the user presses the
 * button. STT uses the window's Web Speech engine when available (honest
 * capability check — the UI disables itself when it isn't). TTS uses the
 * OS speech synthesis (Windows ships local Arabic voices) for task summaries.
 * No always-on listening anywhere.
 */

export interface SpeechResultItem {
  transcript: string;
}
export interface SpeechResultList {
  length: number;
  [index: number]: { isFinal: boolean; 0: SpeechResultItem; length: number };
}
export interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((ev: { resultIndex: number; results: SpeechResultList }) => void) | null;
  onerror: ((ev: { error: string }) => void) | null;
  onend: (() => void) | null;
}

declare global {
  interface Window {
    SpeechRecognition?: new () => SpeechRecognitionLike;
    webkitSpeechRecognition?: new () => SpeechRecognitionLike;
  }
}

export function speechRecognitionAvailable(): boolean {
  return typeof window !== "undefined" && ("SpeechRecognition" in window || "webkitSpeechRecognition" in window);
}

export function createRecognizer(opts: {
  lang?: string;
  onFinal: (transcript: string) => void;
  onInterim?: (transcript: string) => void;
  onEnd: () => void;
  onError: (code: string) => void;
}): SpeechRecognitionLike | null {
  if (!speechRecognitionAvailable()) return null;
  const Ctor = window.SpeechRecognition ?? window.webkitSpeechRecognition!;
  const rec = new Ctor();
  rec.lang = opts.lang ?? "ar-EG";
  rec.continuous = true;
  rec.interimResults = true;
  rec.onresult = (ev) => {
    let interim = "";
    for (let i = ev.resultIndex; i < ev.results.length; i++) {
      const res = ev.results[i]!;
      const text = res[0]?.transcript ?? "";
      if (res.isFinal) opts.onFinal(text.trim());
      else interim += text;
    }
    if (interim) opts.onInterim?.(interim.trim());
  };
  rec.onerror = (ev) => opts.onError(ev.error);
  rec.onend = () => opts.onEnd();
  return rec;
}

export function ttsAvailable(): boolean {
  return typeof window !== "undefined" && "speechSynthesis" in window;
}

/** Pure + testable: the spoken line for a task transition (Arabic). */
export function buildTaskSummaryText(state: string, workflowName: string, verificationPassed?: boolean): string {
  switch (state) {
    case "completed":
      return verificationPassed === false
        ? `المهمة ${workflowName} خلصت بس التحقق مأكدش النتيجة — راجع التفاصيل.`
        : `المهمة ${workflowName} اكتملت بنجاح والتحققات عدّت.`;
    case "failed":
      return `المهمة ${workflowName} فشلت — راجع التفاصيل.`;
    case "cancelled":
      return `المهمة ${workflowName} اتلغت.`;
    case "awaiting_approval":
      return `المهمة ${workflowName} محتاجة موافقتك.`;
    default:
      return "";
  }
}

/** Speaks with an Arabic voice when one is installed; returns false when TTS is unavailable. */
export function speak(text: string, lang = "ar-EG"): boolean {
  if (!ttsAvailable() || !text) return false;
  const synth = window.speechSynthesis;
  const voices = synth.getVoices();
  const arabic = voices.find((v) => v.lang?.toLowerCase().startsWith("ar"));
  const utter = new SpeechSynthesisUtterance(text);
  utter.lang = arabic?.lang ?? lang;
  if (arabic) utter.voice = arabic;
  synth.cancel();
  synth.speak(utter);
  return true;
}

/** Voice preference flags (UI-only, localStorage — never sent anywhere). */
export const voiceFlags = {
  sttEnabled: (): boolean => localStorage.getItem("voice.stt") === "1",
  setSttEnabled: (on: boolean): void => localStorage.setItem("voice.stt", on ? "1" : "0"),
  ttsEnabled: (): boolean => localStorage.getItem("voice.tts") === "1",
  setTtsEnabled: (on: boolean): void => localStorage.setItem("voice.tts", on ? "1" : "0"),
};
