/**
 * AI Repeat — first-run Chromium installer (explicit user consent).
 *
 * Customer machines don't ship the ~150MB browser. The UI asks for consent,
 * then this module downloads the exact Chrome-for-Testing build pinned by our
 * playwright-core version (builds/cft/<browserVersion>/win64/chrome-win64.zip)
 * from the playwright CDN into the standard ms-playwright cache layout —
 * the same directory our resolver already scans.
 *
 * No CAPTCHA/bot-detection bypass concerns: this is a plain public CDN file.
 */
import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
// Inlined at build time so the packaged sidecar knows the pinned version.
import browsersJson from "../../../node_modules/playwright-core/browsers.json" with { type: "json" };

const DEFAULT_CFT_MIRROR = "https://cdn.playwright.dev";
const MAX_DOWNLOAD_BYTES = 600 * 1024 * 1024;

export const CHROMIUM_INFO: { revision: string; browserVersion: string } = (() => {
  const meta = browsersJson as { browsers: Array<{ name: string; revision: string; browserVersion: string }> };
  const c = meta.browsers.find((b) => b.name === "chromium");
  if (!c) throw new Error("PLAYWRIGHT_METADATA_MISSING: browsers.json لا يحتوي chromium");
  return { revision: c.revision, browserVersion: c.browserVersion };
})();

export function chromiumCacheDir(): string {
  return (
    process.env.PLAYWRIGHT_BROWSERS_PATH ||
    path.join(process.env.LOCALAPPDATA ?? process.cwd(), "ms-playwright")
  );
}

export function chromiumTargetDir(): string {
  return path.join(chromiumCacheDir(), `chromium-${CHROMIUM_INFO.revision}`);
}

export function chromiumTargetExe(): string {
  return path.join(chromiumTargetDir(), "chrome-win64", "chrome.exe");
}

export interface InstallProgress {
  receivedBytes: number;
  totalBytes?: number;
  percent?: number;
}

export interface InstallResult {
  ok: boolean;
  executablePath?: string;
  error?: string;
}

export class ChromiumInstaller {
  private installing = false;

  get busy(): boolean {
    return this.installing;
  }

  get alreadyInstalled(): boolean {
    return existsSync(chromiumTargetExe());
  }

  /**
   * Downloads and extracts Chromium. `mirrorBase` is overridable for tests.
   * Progress is throttled to one callback per ~2MB.
   */
  async install(
    onProgress: (p: InstallProgress) => void,
    mirrorBase: string = process.env.AI_REPEAT_CFT_MIRROR ?? DEFAULT_CFT_MIRROR,
  ): Promise<InstallResult> {
    if (this.installing) return { ok: false, error: "INSTALL_IN_PROGRESS: فيه تنزيل شغّال بالفعل" };
    this.installing = true;
    const dir = chromiumTargetDir();
    const exe = chromiumTargetExe();
    // Expand-Archive only accepts the .zip extension — keep the temp file valid.
    const zipPath = `${dir}.download.zip`;
    try {
      // A partially-extracted dir from a previous failed run must be cleaned.
      if (existsSync(dir) && !existsSync(exe)) rmSync(dir, { recursive: true, force: true });
      if (existsSync(exe)) return { ok: true, executablePath: exe };

      mkdirSync(chromiumCacheDir(), { recursive: true });
      rmSync(zipPath, { force: true });
      const url = `${mirrorBase.replace(/\/+$/, "")}/builds/cft/${CHROMIUM_INFO.browserVersion}/win64/chrome-win64.zip`;

      const res = await fetch(url, { redirect: "follow" });
      if (!res.ok || !res.body) {
        return { ok: false, error: `DOWNLOAD_FAILED: HTTP ${res.status} من ${new URL(url).host}` };
      }
      const total = Number(res.headers.get("content-length") ?? 0) || undefined;

      let received = 0;
      let lastReported = 0;
      const counter = new Transform({
        transform(chunk: Buffer, _enc, cb) {
          received += chunk.length;
          if (received > MAX_DOWNLOAD_BYTES) {
            cb(new Error("DOWNLOAD_TOO_LARGE: الملف أكبر من الحد المتوقع"), undefined);
            return;
          }
          if (received - lastReported >= 2 * 1024 * 1024) {
            lastReported = received;
            onProgress({
              receivedBytes: received,
              totalBytes: total,
              percent: total ? Math.round((received / total) * 100) : undefined,
            });
          }
          cb(null, chunk);
        },
      });
      await pipeline(Readable.fromWeb(res.body as import("node:stream/web").ReadableStream), counter, createWriteStream(zipPath));
      onProgress({ receivedBytes: received, totalBytes: total, percent: total ? Math.round((received / total) * 100) : 100 });

      // ZIP magic-byte check — catches truncated/corrupted downloads before extraction.
      const head = readFileSync(zipPath).subarray(0, 4);
      if (head[0] !== 0x50 || head[1] !== 0x4b) {
        return { ok: false, error: "DOWNLOAD_CORRUPTED: الملف المحمّل مش ZIP صالح — جرب تاني." };
      }

      // Windows-first extraction with the OS-bundled PowerShell.
      const extract = spawnSync(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${dir}' -Force`],
        { timeout: 10 * 60_000, encoding: "utf8" },
      );
      if (extract.status !== 0 || !existsSync(exe)) {
        return {
          ok: false,
          error: `EXTRACT_FAILED: ${(extract.stderr || extract.stdout || "").slice(0, 200)}`,
        };
      }
      return { ok: true, executablePath: exe };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    } finally {
      rmSync(zipPath, { force: true });
      this.installing = false;
    }
  }
}
