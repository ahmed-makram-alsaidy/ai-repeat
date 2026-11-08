/**
 * STT engine tests — whisper-local runs against a REAL whisper.cpp fake:
 * a tiny PowerShell "binary" is not possible, so we exercise the runner via
 * its guard paths (missing binary/model/oversize) with real file checks, and
 * the whisper-output parser as a pure unit (the actual CLI integration needs
 * the founder's binary — documented in IMPLEMENTATION_STATUS).
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { transcribeWithWhisper, SttConfig } from "../services/agent/src/stt.js";

import { extractTextFromWhisperOutput } from "../services/agent/src/stt.js";

describe("whisper-local STT engine", () => {
  it("fails honestly when binary or model paths are wrong", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "ai-repeat-stt-"));
    const audio = Buffer.from("RIFF0000WAVE");
    const missing: SttConfig = { binPath: path.join(dir, "nope.exe"), modelPath: path.join(dir, "m.bin") };
    expect(transcribeWithWhisper(audio, missing).error).toContain("STT_NOT_CONFIGURED");

    writeFileSync(path.join(dir, "m.bin"), "fake-model");
    const missingModel: SttConfig = { binPath: path.join(dir, "fake.cmd"), modelPath: path.join(dir, "nope.bin") };
    expect(transcribeWithWhisper(audio, missingModel).error).toContain("STT_NOT_CONFIGURED");
  });

  it("refuses non-.exe binaries (no shell spawn hazards)", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "ai-repeat-stt2-"));
    const bin = path.join(dir, "fake.cmd");
    writeFileSync(bin, "@echo off\r\necho hi\r\n", "utf8");
    const model = path.join(dir, "m.bin");
    writeFileSync(model, "fake-model");
    const result = transcribeWithWhisper(Buffer.from("RIFF0000WAVE"), { binPath: bin, modelPath: model }, 30_000);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("STT_INVALID_BIN");
  });

  it("parses Arabic transcript from whisper-style output (pure parser)", () => {
    const raw = [
      "whisper_print_system_info: test",
      "[00:00:00.000 --> 00:00:01.200]  افتح لوحة المنتجات",
      "[00:00:01.200 --> 00:00:02.500]  وطلّعلي الناقص صور",
    ].join("\n");
    const text = extractTextFromWhisperOutput(raw);
    expect(text).toContain("افتح لوحة المنتجات");
    expect(text).toContain("وطلّعلي الناقص صور");
    expect(text).not.toContain("[00:00");
    expect(text).not.toContain("system_info");
  });

  it("rejects empty and oversized audio", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "ai-repeat-stt3-"));
    const cfg: SttConfig = { binPath: path.join(dir, "x.cmd"), modelPath: path.join(dir, "m.bin") };
    expect(transcribeWithWhisper(Buffer.alloc(0), cfg).error).toContain("STT_EMPTY");
    expect(transcribeWithWhisper(Buffer.alloc(30 * 1024 * 1024), cfg).error).toContain("STT_TOO_LARGE");
  });
});
