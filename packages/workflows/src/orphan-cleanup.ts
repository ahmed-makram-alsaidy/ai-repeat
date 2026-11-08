/**
 * AI Repeat — orphaned browser cleanup (spec: graceful cleanup for orphaned
 * browser processes).
 *
 * The agent records the PID of every Chromium it launches into
 * `<dataDir>/browser-pids.json`. On boot, any PID from a previous session
 * that is still alive AND whose executable lives inside the app-owned
 * ms-playwright cache is killed. Third-party browsers are never touched:
 * only PIDs we recorded ourselves, double-checked against the known path.
 */
import { execSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

export interface BrowserPidEntry {
  pid: number;
  launchedAt: string;
}

const MS_PLAYWRIGHT_MARKERS = ["ms-playwright", "chromium-"];

export function pidFilePath(dataDir: string): string {
  return path.join(dataDir, "browser-pids.json");
}

function loadPids(dataDir: string): BrowserPidEntry[] {
  try {
    const parsed = JSON.parse(readFileSync(pidFilePath(dataDir), "utf8")) as BrowserPidEntry[];
    return Array.isArray(parsed) ? parsed.filter((e) => Number.isFinite(e?.pid)) : [];
  } catch {
    return [];
  }
}

function savePids(dataDir: string, entries: BrowserPidEntry[]): void {
  writeFileSync(pidFilePath(dataDir), JSON.stringify(entries, null, 2), "utf8");
}

/** Records a launched Chromium PID for orphan cleanup on the next boot. */
export function trackBrowserPid(dataDir: string, browser: unknown): void {
  try {
    // process() is real at runtime but not part of playwright's public typings.
    const pid = (browser as { process?: () => { pid?: number } | null })?.process?.()?.pid;
    if (!pid) return;
    const entries = loadPids(dataDir).filter((e) => e.pid !== pid);
    entries.push({ pid, launchedAt: new Date().toISOString() });
    savePids(dataDir, entries.slice(-50));
  } catch {
    /* tracking must never break launching */
  }
}

/** Removes a PID from tracking after a clean close. */
export function untrackBrowserPid(dataDir: string, pid: number | undefined): void {
  if (!pid) return;
  try {
    savePids(dataDir, loadPids(dataDir).filter((e) => e.pid !== pid));
  } catch {
    /* best effort */
  }
}

function processExePath(pid: number): string | null {
  try {
    const out = execSync(
      `powershell.exe -NoProfile -NonInteractive -Command "(Get-Process -Id ${pid} -ErrorAction Stop).Path"`,
      { encoding: "utf8", timeout: 15_000 },
    );
    return out.trim() || null;
  } catch {
    return null; // process gone
  }
}

/**
 * Kills Chromium processes recorded by PREVIOUS sessions of this app.
 * Safety: PID must be alive, its exe path must contain the playwright cache
 * markers, and it must not belong to the current session's launches.
 */
export function cleanupOrphanedBrowsers(dataDir: string, activePids: Set<number> = new Set()): { killed: number[]; skipped: number } {
  const entries = loadPids(dataDir);
  const killed: number[] = [];
  let skipped = 0;
  for (const entry of entries) {
    if (activePids.has(entry.pid)) {
      skipped++;
      continue;
    }
    const exe = processExePath(entry.pid);
    if (!exe) continue; // already dead — forget it below
    const lower = exe.toLowerCase();
    if (!MS_PLAYWRIGHT_MARKERS.every((m) => lower.includes(m))) {
      skipped++; // not our browser build anymore (reused pid) — never touch it
      continue;
    }
    try {
      execSync(`taskkill /PID ${entry.pid} /F`, { encoding: "utf8", timeout: 15_000 });
      killed.push(entry.pid);
    } catch {
      skipped++;
    }
  }
  savePids(
    dataDir,
    entries.filter((e) => !killed.includes(e.pid) && processExePath(e.pid) !== null),
  );
  return { killed, skipped };
}

/** Housekeeping: drop the tracking file entirely (used when empty). */
export function clearTrackingIfEmpty(dataDir: string): void {
  const f = pidFilePath(dataDir);
  if (existsSync(f) && loadPids(dataDir).length === 0) rmSync(f, { force: true });
}
