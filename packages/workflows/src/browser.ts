/**
 * AI Repeat — app-owned browser management.
 * Only Chromium builds owned by the app (Playwright cache) are used.
 * NEVER points at the user's installed Chrome/Edge profile.
 */
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { chromium, type BrowserContext } from "playwright-core";

export interface LaunchOptions {
  headless?: boolean;
  viewport?: { width: number; height: number };
  /** App-owned userDataDir for persistent (login-capable) profiles. */
  userDataDir?: string;
  slowMo?: number;
}

/**
 * Resolves a Playwright-managed Chromium executable from the local
 * ms-playwright cache. Returns null when no browser is installed — callers
 * must surface an actionable install hint instead of pretending to run.
 */
export function resolveChromiumExecutable(): string | null {
  const candidates: string[] = [];
  const roots = [process.env.PLAYWRIGHT_BROWSERS_PATH, path.join(process.env.LOCALAPPDATA ?? "", "ms-playwright")].filter(
    (r): r is string => Boolean(r),
  );
  for (const root of roots) {
    if (!existsSync(root)) continue;
    let dirs: string[] = [];
    try {
      dirs = readdirSync(root);
    } catch {
      continue;
    }
    const chromiumDirs = dirs
      .filter((d) => d.startsWith("chromium-") && !d.includes("headless"))
      .sort((a, b) => Number(b.split("-")[1]) - Number(a.split("-")[1]));
    for (const d of chromiumDirs) {
      const exe = path.join(root, d, "chrome-win", "chrome.exe");
      if (existsSync(exe)) candidates.push(exe);
      const exe2 = path.join(root, d, "chrome-win64", "chrome.exe");
      if (existsSync(exe2)) candidates.push(exe2);
    }
  }
  return candidates[0] ?? null;
}

export class BrowserUnavailableError extends Error {
  constructor() {
    super(
      "BROWSER_UNAVAILABLE: متصفح Chromium الخاص بالتطبيق مش متسطب. شغّل `npx playwright install chromium` مرة واحدة فقط (بيحتاج ~150MB).",
    );
    this.name = "BrowserUnavailableError";
  }
}

/**
 * In-process profile leasing: a mutex chain keyed by userDataDir.
 * Each lease's `released` promise becomes the next caller's precondition,
 * so a second lease on the same profile waits for release — never opens
 * the same profile twice (S06).
 */
const leaseTails = new Map<string, Promise<void>>();

export interface LeasedContext {
  context: BrowserContext;
  release: () => Promise<void>;
}

export async function leasePersistentContext(
  userDataDir: string,
  opts: LaunchOptions & { executablePath: string },
): Promise<LeasedContext> {
  const key = path.resolve(userDataDir).toLowerCase();
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const prev = leaseTails.get(key) ?? Promise.resolve();
  // Reserve our slot synchronously so same-tick callers queue behind us.
  leaseTails.set(key, released);
  try {
    const context = await prev.then(() =>
      chromium.launchPersistentContext(userDataDir, {
        executablePath: opts.executablePath,
        headless: opts.headless ?? false,
        viewport: opts.viewport ?? { width: 1280, height: 800 },
        slowMo: opts.slowMo,
      }),
    );
    return {
      context,
      release: async () => {
        await context.close().catch(() => {});
        release();
      },
    };
  } catch (err) {
    // Don't deadlock the next caller if launch failed.
    if (leaseTails.get(key) === released) leaseTails.delete(key);
    release();
    throw err;
  }
}

export async function launchEphemeralContext(opts: LaunchOptions & { executablePath: string }): Promise<BrowserContext> {
  // Ephemeral isolated context: fresh cookies/storage per run (test S06 cross-profile rule).
  const browser = await chromium.launch({
    executablePath: opts.executablePath,
    headless: opts.headless ?? true,
    slowMo: opts.slowMo,
  });
  const context = await browser.newContext({
    viewport: opts.viewport ?? { width: 1280, height: 800 },
  });
  return context;
}
