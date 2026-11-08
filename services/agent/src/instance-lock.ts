/**
 * AI Repeat — single-instance guard.
 *
 * Two app instances on one dataDir corrupt each other (boot #2's stale-task
 * recovery fails boot #1's active runs). A lock file with the owning PID
 * prevents that: alive PID → second instance refuses to start with a clear
 * Arabic error; dead PID (crash) → stale lock, safe to take over.
 */
import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";

export class InstanceLockError extends Error {
  constructor(readonly ownerPid: number) {
    super(
      `INSTANCE_RUNNING: فيه نسخة تانية من AI Repeat شغالة على نفس البيانات (PID ${ownerPid}). " +
        "اقفلها الأول — التشغيل المزدوج بيبوظ قاعدة البيانات.`,
    );
    this.name = "InstanceLockError";
  }
}

export function lockFilePath(dataDir: string): string {
  return path.join(dataDir, "agent.lock");
}

function pidAlive(pid: number): boolean {
  try {
    const out = execSync(`powershell.exe -NoProfile -NonInteractive -Command "(Get-Process -Id ${pid} -ErrorAction Stop).Id"`, {
      encoding: "utf8",
      timeout: 10_000,
    });
    return out.trim() === String(pid);
  } catch {
    return false;
  }
}

/**
 * Acquires the instance lock. Throws InstanceLockError when another live
 * process owns it. Returns a release function (crash-safe: the stale lock is
 * detected by PID liveness on the next boot).
 */
export function acquireInstanceLock(dataDir: string): { release: () => void; ownerPid: number } {
  const file = lockFilePath(dataDir);
  if (existsSync(file)) {
    try {
      const owner = JSON.parse(readFileSync(file, "utf8")) as { pid: number };
      if (owner.pid && owner.pid !== process.pid && pidAlive(owner.pid)) {
        throw new InstanceLockError(owner.pid);
      }
      // Stale lock from a crashed session — take over.
      rmSync(file, { force: true });
    } catch (err) {
      if (err instanceof InstanceLockError) throw err;
      // Corrupt lock file — replace it.
      rmSync(file, { force: true });
    }
  }
  writeFileSync(file, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }), "utf8");
  return {
    ownerPid: process.pid,
    release: () => {
      try {
        const cur = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as { pid: number }) : null;
        if (cur?.pid === process.pid) rmSync(file, { force: true });
      } catch {
        /* best effort */
      }
    },
  };
}
