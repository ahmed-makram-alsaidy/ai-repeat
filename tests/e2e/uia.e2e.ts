/**
 * Phase-5 STEP 1: read-only UIA inspection against a REAL window (Notepad).
 * No input is ever sent — enumeration + property reads only.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, execSync, type ChildProcess } from "node:child_process";
import { inspectWindow, listWindows } from "../../services/agent/src/uia.js";

let notepad: ChildProcess | undefined;

beforeAll(async () => {
  notepad = spawn("notepad.exe", [], { stdio: "ignore", detached: false });
  await new Promise((r) => setTimeout(r, 1500)); // let the window appear
});

afterAll(() => {
  if (notepad?.pid) {
    try {
      execSync(`taskkill /PID ${notepad.pid} /T /F`, { stdio: "ignore", timeout: 15_000 });
    } catch {
      /* already closed */
    }
  }
});

describe("UIA read-only inspection (Phase-5 step 1)", () => {
  it("lists top-level windows with titles", () => {
    const windows = listWindows();
    expect(Array.isArray(windows)).toBe(true);
    expect(windows.length).toBeGreaterThan(0);
    for (const w of windows) {
      expect(w.pid).toBeGreaterThan(0);
      expect(w.hwnd).toBeGreaterThan(0);
      expect(typeof w.title).toBe("string");
    }
    // Notepad appeared in the list.
    expect(windows.some((w) => w.processName.toLowerCase().includes("notepad"))).toBe(true);
  });

  it("inspects the notepad window and finds first-level controls (read-only)", () => {
    const win = listWindows().find((w) => w.processName.toLowerCase().includes("notepad"));
    expect(win).toBeTruthy();
    const result = inspectWindow(win!.hwnd);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.controls.length).toBeGreaterThan(0);
      // Notepad's classic layout includes a text area (Document/Edit) and a menu bar.
      const types = result.controls.map((c) => c.controlType.toLowerCase());
      expect(types.some((t) => t.includes("document") || t.includes("edit") || t.includes("text"))).toBe(true);
      // Every entry is a pure property read — nothing here can inject input.
      for (const c of result.controls) {
        expect(typeof c.name).toBe("string");
        expect(typeof c.enabled).toBe("boolean");
      }
    }
  });

  it("rejects invalid hwnd values", () => {
    const r = inspectWindow(0);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("UIA_INVALID_HWND");
    const r2 = inspectWindow(-5);
    expect(r2.ok).toBe(false);
  });
});
