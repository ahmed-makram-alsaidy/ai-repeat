/**
 * AI Repeat — STT engine abstraction (FR-06).
 *
 * Three engines, chosen in الإعدادات:
 *  - "web-speech"   : browser/WebView engine, zero install (default).
 *  - "whisper-local": a local whisper.cpp CLI the user installs themselves —
 *                     no automatic download, no bundled model, no telemetry.
 *                     Config: binary path + model path (+ optional args).
 *  - "none"         : voice input off.
 *
 * The transcribe endpoint never records by itself: the UI records with
 * MediaRecorder on an explicit press and uploads the blob.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export interface SttConfig {
  binPath?: string; // e.g. C:\\tools\\whisper.cpp\\main.exe (or whisper-cli.exe)
  modelPath?: string; // e.g. C:\\tools\\whisper.cpp\\models\\ggml-base.bin
  language?: string; // default "ar"
}

export interface TranscribeResult {
  ok: boolean;
  text?: string;
  error?: string;
}

const MAX_AUDIO_BYTES = 25 * 1024 * 1024; // generous cap for a push-to-talk clip

/** Pure + testable: pulls clean transcript lines out of whisper.cpp output. */
export function extractTextFromWhisperOutput(raw: string): string {
  // whisper.cpp prints segments like: [00:00:00.000 --> 00:00:02.400]  النص
  const lines = raw
    .split(/\r?\n/)
    .map((l) => l.replace(/^\s*\[\d{2}:\d{2}:\d{2}\.\d{3} --> \d{2}:\d{2}:\d{2}\.\d{3}\]\s*/, "").trim())
    .filter((l) => l && !/^\[/.test(l) && !/whisper_print_system_info|system_info|load_time/i.test(l));
  return lines.join(" ").trim();
}

/**
 * Runs the configured whisper.cpp CLI against a recorded audio blob.
 * WAV is passed through; other formats are rejected with a clear message
 * (the UI records audio/wav for this engine).
 */
export function transcribeWithWhisper(audio: Buffer, cfg: SttConfig, timeoutMs = 120_000): TranscribeResult {
  if (audio.length === 0) return { ok: false, error: "STT_EMPTY: التسجيل فاضي." };
  if (audio.length > MAX_AUDIO_BYTES) return { ok: false, error: "STT_TOO_LARGE: التسجيل أكبر من الحد." };
  if (!cfg.binPath || !existsSync(cfg.binPath)) {
    return { ok: false, error: "STT_NOT_CONFIGURED: مسار whisper.cpp غير صحيح — اضبطه من الإعدادات." };
  }
  if (!/\.(exe)$/i.test(cfg.binPath)) {
    // .cmd/.bat are refused: spawning them needs a shell (quoting hazards).
    return { ok: false, error: "STT_INVALID_BIN: محرك الـSTT لازم يكون ملف .exe (whisper.cpp)." };
  }
  if (!cfg.modelPath || !existsSync(cfg.modelPath)) {
    return { ok: false, error: "STT_NOT_CONFIGURED: مسار الموديل غير صحيح (ggml *.bin)." };
  }

  const tmp = mkdtempSync(path.join(tmpdir(), "ai-repeat-stt-"));
  const wavPath = path.join(tmp, "clip.wav");
  try {
    // MediaRecorder wav from the WebView is a RIFF wav — whisper.cpp reads it directly.
    writeFileSync(wavPath, audio);
    const args = ["-m", cfg.modelPath, "-f", wavPath, "-l", cfg.language ?? "ar", "-nt"];
    const res = spawnSync(cfg.binPath, args, { encoding: "utf8", timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 });
    if (res.error) {
      return { ok: false, error: `STT_RUN_FAILED: ${res.error.message.slice(0, 200)}` };
    }
    if (res.status !== 0) {
      return { ok: false, error: `STT_RUN_FAILED: ${(res.stderr || res.stdout || "").slice(0, 200)}` };
    }
    const text = extractTextFromWhisperOutput(res.stdout ?? "");
    if (!text) return { ok: false, error: "STT_EMPTY_RESULT: whisper رجع نص فاضي." };
    return { ok: true, text };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
