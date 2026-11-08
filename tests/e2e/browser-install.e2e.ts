/**
 * First-run Chromium installer tests — no real network.
 * A local HTTP server plays the CDN mirror serving a real (tiny) zip built
 * with PowerShell Compress-Archive; PLAYWRIGHT_BROWSERS_PATH points at a
 * temp dir so the real cache is untouched.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync, existsSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { ChromiumInstaller, CHROMIUM_INFO, chromiumCacheDir, chromiumTargetExe } from "../../services/agent/src/browser-install.js";

let httpServer: Server;
let mirrorBase: string;
let sandbox: string;
let zipBytes: Buffer;

beforeAll(async () => {
  sandbox = mkdtempSync(path.join(tmpdir(), "ai-repeat-pwinst-"));
  process.env.PLAYWRIGHT_BROWSERS_PATH = path.join(sandbox, "ms-playwright");

  // Build a real zip with the expected layout via PowerShell (OS-bundled).
  const staging = path.join(sandbox, "staging", "chrome-win64");
  mkdirSync(staging, { recursive: true });
  writeFileSync(path.join(staging, "chrome.exe"), "MZ-fake-chrome");
  const zipPath = path.join(sandbox, "chrome-win64.zip");
  const ps = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", `Compress-Archive -Path '${path.join(sandbox, "staging", "*")}' -DestinationPath '${zipPath}' -Force`],
    { timeout: 60_000, encoding: "utf8" },
  );
  if (ps.status !== 0 || !existsSync(zipPath)) throw new Error(`Compress-Archive failed: ${ps.stderr}`);
  zipBytes = readFileSync(zipPath);

  httpServer = createServer((req, res) => {
    const correctPath = `/builds/cft/${CHROMIUM_INFO.browserVersion}/win64/chrome-win64.zip`;
    if (req.url === correctPath) {
      res.writeHead(200, { "Content-Type": "application/zip", "Content-Length": zipBytes.length });
      res.end(zipBytes);
      return;
    }
    res.writeHead(404, { "Content-Type": "text/plain" }).end("not found");
  });
  await new Promise<void>((r) => httpServer.listen(0, "127.0.0.1", r));
  const addr = httpServer.address();
  if (typeof addr !== "object" || !addr) throw new Error("mirror failed to bind");
  mirrorBase = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => httpServer.close(() => r()));
  rmSync(sandbox, { recursive: true, force: true });
  delete process.env.PLAYWRIGHT_BROWSERS_PATH;
});

describe("Chromium first-run installer", () => {
  it("exposes the pinned playwright metadata", () => {
    expect(CHROMIUM_INFO.revision).toMatch(/^\d+$/);
    expect(CHROMIUM_INFO.browserVersion).toMatch(/^\d+\./);
  });

  it("downloads, extracts and places chrome.exe at the expected cache path", async () => {
    const installer = new ChromiumInstaller();
    const progress: Array<{ receivedBytes: number; percent?: number }> = [];
    const result = await installer.install((p) => progress.push(p), mirrorBase);

    expect(result.ok).toBe(true);
    expect(result.executablePath).toBe(chromiumTargetExe());
    expect(existsSync(chromiumTargetExe())).toBe(true);
    expect(progress.length).toBeGreaterThan(0);
    expect(progress.at(-1)?.receivedBytes).toBe(zipBytes.length);
    // The standard cache dir was used (PLAYWRIGHT_BROWSERS_PATH override).
    expect(chromiumTargetExe().startsWith(chromiumCacheDir())).toBe(true);
  });

  it("reports already-installed on a second run without re-downloading", async () => {
    const installer = new ChromiumInstaller();
    let downloads = 0;
    const result = await installer.install(() => downloads++, mirrorBase);
    expect(result.ok).toBe(true);
    expect(result.executablePath).toBe(chromiumTargetExe());
    expect(downloads).toBe(0); // short-circuit, no network call
  });

  it("fails honestly on a 404 mirror instead of hanging or faking success", async () => {
    // Fresh cache dir so the already-installed short-circuit doesn't apply.
    process.env.PLAYWRIGHT_BROWSERS_PATH = path.join(sandbox, "empty-cache");
    try {
      const installer = new ChromiumInstaller();
      const result = await installer.install(() => {}, `${mirrorBase}/missing`);
      expect(result.ok).toBe(false);
      expect(String(result.error)).toContain("DOWNLOAD_FAILED");
    } finally {
      delete process.env.PLAYWRIGHT_BROWSERS_PATH;
    }
  });
});
