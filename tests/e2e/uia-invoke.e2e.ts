/**
 * Phase-5 STEP 2 E2E: InvokePattern execution measured on real Notepad —
 * invoke the "Add New Tab" button and observe the tab count increase via a
 * fresh read-only inspection. Measured through UIA itself, no screenshots.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, execSync, type ChildProcess } from "node:child_process";
import { inspectWindow, invokeControlByIndex, listWindows } from "../../services/agent/src/uia.js";

let notepad: ChildProcess | undefined;

beforeAll(async () => {
  notepad = spawn("notepad.exe", [], { stdio: "ignore" });
  await new Promise((r) => setTimeout(r, 1500));
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

function findNotepad() {
  return listWindows().find((w) => w.processName.toLowerCase().includes("notepad"));
}

const tabItemCount = (controls: Array<{ controlType: string; name: string }>) =>
  controls.filter((c) => /tabitem/i.test(c.controlType)).length;

describe("UIA InvokePattern (Phase-5 step 2, measured)", () => {
  it("invokes the Add-Tab button and the tab count measurably increases", async () => {
    const win = findNotepad();
    expect(win).toBeTruthy();
    const before = inspectWindow(win!.hwnd);
    expect(before.ok).toBe(true);
    if (!before.ok) return;

    const addTab = before.controls.findIndex((c) => /button/i.test(c.controlType) && /add new tab/i.test(c.name));
    if (addTab === -1) {
      console.log("[uia-invoke] Add New Tab button not found (localized build) — skipping measure");
      return;
    }
    const beforeTabs = tabItemCount(before.controls);

    const result = invokeControlByIndex(win!.hwnd, addTab);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.invoked).toContain("Button");

    await new Promise((r) => setTimeout(r, 1200));
    const after = inspectWindow(win!.hwnd);
    expect(after.ok).toBe(true);
    if (!after.ok) return;
    expect(tabItemCount(after.controls)).toBeGreaterThan(beforeTabs);
  }, 60_000);

  it("refuses non-invocable controls with a clear reason", () => {
    const win = findNotepad();
    expect(win).toBeTruthy();
    const dump = inspectWindow(win!.hwnd);
    if (!dump.ok) return;
    const pane = dump.controls.findIndex((c) => /pane/i.test(c.controlType));
    if (pane === -1) return;
    const r = invokeControlByIndex(win!.hwnd, pane);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("UIA_NOT_INVOKABLE");
  }, 60_000);
});
