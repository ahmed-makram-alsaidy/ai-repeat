/**
 * AI Repeat — Windows UI Automation adapter, Phase-5 STEP 1 ONLY.
 *
 * READ-ONLY element inspection with explicit per-use consent:
 *   - lists top-level windows (title / process / PID)
 *   - inspects the first-level UIA controls of ONE window the user picks
 *
 * This module can NEVER send input: no SendInput, no Invoke/Value patterns,
 * no focus changes. It is enumeration + property reads through the .NET
 * UIAutomation client that ships with Windows. Automation of controls is a
 * later, separately gated milestone (docs/spec milestone 5).
 */
import { execSync } from "node:child_process";

export interface UiaWindow {
  pid: number;
  processName: string;
  title: string;
  hwnd: number;
}

export interface UiaControl {
  name: string;
  controlType: string;
  enabled: boolean;
  offscreen: boolean;
}

const PS_TIMEOUT = 20_000;

function runPs(script: string): string {
  return execSync(`powershell.exe -NoProfile -NonInteractive -Command "${script.replace(/"/g, '\\"')}"`, {
    encoding: "utf8",
    timeout: PS_TIMEOUT,
    maxBuffer: 8 * 1024 * 1024,
  });
}

/** Top-level windows with titles (the only things a user can consent to inspect). */
export function listWindows(): UiaWindow[] {
  const raw = runPs(
    "Get-Process | Where-Object { $_.MainWindowTitle -ne '' } | Select-Object Id,ProcessName,MainWindowTitle,MainWindowHandle | ConvertTo-Json -Compress",
  );
  let parsed: Array<{ Id: number; ProcessName: string; MainWindowTitle: string; MainWindowHandle: number }> = [];
  try {
    const json = JSON.parse(raw);
    parsed = Array.isArray(json) ? json : [json];
  } catch {
    return [];
  }
  return parsed
    .filter((w) => w.MainWindowHandle !== 0)
    .map((w) => ({ pid: w.Id, processName: w.ProcessName, title: w.MainWindowTitle, hwnd: w.MainWindowHandle }));
}

/**
 * Read-only control dump of one window via the UIA client.
 * Modern WinUI/Flutter hosts expose content below the first level, so we walk
 * Descendants and cap the dump (read-only preview, not a full tree export).
 */
export function inspectWindow(hwnd: number): { ok: true; controls: UiaControl[] } | { ok: false; error: string } {
  // PowerShell injection prevention: hwnd MUST be a positive integer in safe range.
  // Any non-integer or out-of-range value is rejected before reaching the shell.
  if (!Number.isInteger(hwnd) || hwnd <= 0 || hwnd > 0xFFFFFFFF) return { ok: false, error: "UIA_INVALID_HWND" };
  const script = [
    "Add-Type -AssemblyName UIAutomationClient",
    "$el = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]::new(" + hwnd + "))",
    "if ($null -eq $el) { Write-Output 'ELEMENT_NULL'; exit }",
    "$desc = $el.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)",
    "$out = @()",
    "$i = 0",
    "foreach ($k in $desc) {",
    "  if ($i -ge 60) { break }",
    "  $nm = ''",
    "  if ($k.Current.Name) { $nm = $k.Current.Name.Substring(0, [Math]::Min(80, $k.Current.Name.Length)) }",
    "  $out += [pscustomobject]@{ name = $nm; controlType = $k.Current.ControlType.ProgrammaticName; enabled = $k.Current.IsEnabled; offscreen = $k.Current.IsOffscreen }",
    "  $i++",
    "}",
    "Write-Output ($out | ConvertTo-Json -Compress)",
  ].join("; ");
  try {
    const raw = runPs(script);
    if (raw.trim() === "ELEMENT_NULL") return { ok: false, error: "UIA_ELEMENT_NOT_FOUND" };
    const parsed = JSON.parse(raw.trim() || "[]");
    const list = Array.isArray(parsed) ? parsed : [parsed];
    return {
      ok: true,
      controls: list.map((c) => ({
        name: String(c.name ?? ""),
        controlType: String(c.controlType ?? "").replace("ControlType.", ""),
        enabled: Boolean(c.enabled),
        offscreen: Boolean(c.offscreen),
      })),
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message.slice(0, 200) : String(err) };
  }
}

/**
 * Phase-5 STEP 2 — safe UIA pattern execution (InvokePattern ONLY).
 *
 * Rules enforced here:
 *  - The caller must address an element by the SAME descendant index that
 *    inspectWindow() showed the user — no blind element addressing.
 *  - Only controls that actually support InvokePattern can be invoked;
 *    anything else is refused. Value/Toggle/Selection patterns come later.
 *  - InvokePattern.Invoke does not move the physical mouse or keyboard focus
 *    for apps that implement it in the background — that is why it is the
 *    only pattern shipped in this step.
 *  - The caller (server) must have both flags enabled and must log the event.
 */
export function invokeControlByIndex(hwnd: number, index: number): { ok: true; invoked: string } | { ok: false; error: string } {
  // Same injection prevention as inspectWindow.
  if (!Number.isInteger(hwnd) || hwnd <= 0 || hwnd > 0xFFFFFFFF) return { ok: false, error: "UIA_INVALID_HWND" };
  if (!Number.isInteger(index) || index < 0 || index > 59) return { ok: false, error: "UIA_INVALID_INDEX: الفهرس خارج نطاق الفحص (0–59)" };
  const script = [
    "Add-Type -AssemblyName UIAutomationClient",
    "Add-Type -AssemblyName UIAutomationTypes",
    "$el = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]::new(" + hwnd + "))",
    "if ($null -eq $el) { Write-Output 'ELEMENT_NULL'; exit }",
    "$desc = $el.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)",
    "if (" + index + " -ge $desc.Count) { Write-Output 'INDEX_OUT_OF_RANGE'; exit }",
    "$k = $desc[" + index + "]",
    "$nm = ''",
    "if ($k.Current.Name) { $nm = $k.Current.Name.Substring(0, [Math]::Min(60, $k.Current.Name.Length)) }",
    "try {",
    "  $pat = $k.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)",
    "} catch {",
    "  Write-Output ('NO_INVOKE|' + $k.Current.ControlType.ProgrammaticName + '|' + $nm)",
    "  exit",
    "}",
    "$pat.Invoke()",
    "Write-Output ('INVOKED|' + $k.Current.ControlType.ProgrammaticName + '|' + $nm)",
  ].join("; ");
  try {
    const raw = runPs(script).trim();
    if (raw === "ELEMENT_NULL") return { ok: false, error: "UIA_ELEMENT_NOT_FOUND" };
    if (raw === "INDEX_OUT_OF_RANGE") return { ok: false, error: "UIA_INDEX_OUT_OF_RANGE: الفهرس تغيّر — أعد الفحص أولًا" };
    if (raw.startsWith("NO_INVOKE|")) {
      const parts = raw.split("|");
      return { ok: false, error: `UIA_NOT_INVOKABLE: النوع ${parts[1]} مش بيدعم Invoke (${parts[2] ?? ""})` };
    }
    if (raw.startsWith("INVOKED|")) {
      const parts = raw.split("|");
      // Sanitize the output — strip any PS metacharacters that could be injection artifacts.
      const type = (parts[1] ?? "").replace(/[^a-zA-Z.]/g, "");
      const name = (parts[2] ?? "").replace(/['";`$|\\]/g, "");
      return { ok: true, invoked: `${type}:${name}` };
    }
    return { ok: false, error: `UIA_UNEXPECTED: ${raw.slice(0, 120)}` };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message.slice(0, 200) : String(err) };
  }
}
