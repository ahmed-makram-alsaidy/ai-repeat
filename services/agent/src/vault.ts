/**
 * AI Repeat — OS-backed secret storage.
 * Windows: DPAPI (CurrentUser scope) through PowerShell — the secret is
 * encrypted to the logged-in user and only decryptable by this user account.
 * The raw key never touches the SQLite DB, settings.json, logs, or the UI.
 *
 * Non-Windows/dev fallback: base64 marker file (explicitly flagged insecure).
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

const INSECURE_MARKER = "INSECURE-DEV-FALLBACK:";

export class SecretVault {
  constructor(private readonly vaultDir: string) {}

  private fileFor(ref: string): string {
    // ref is a handle like "zai-default"; sanitized to a filename.
    const safe = ref.replace(/[^a-zA-Z0-9_-]/g, "");
    if (!safe || safe !== ref) throw new Error("INVALID_SECRET_REF");
    return path.join(this.vaultDir, `secret-${safe}.bin`);
  }

  /** Missing/empty ref is an expected state (no key configured) — not an error. */
  getSecret(ref: string): string | undefined {
    if (!ref) return undefined;
    try {
      return this.readSecret(ref);
    } catch (err) {
      if (err instanceof Error && err.message === "INVALID_SECRET_REF") return undefined;
      throw err;
    }
  }

  private readSecret(ref: string): string | undefined {
    const file = this.fileFor(ref);
    if (!existsSync(file)) return undefined;
    const raw = readFileSync(file, "utf8");
    if (raw.startsWith("DPAPI:")) {
      return this.dpapiUnprotect(raw.slice("DPAPI:".length));
    }
    if (raw.startsWith(INSECURE_MARKER)) {
      return Buffer.from(raw.slice(INSECURE_MARKER.length), "base64").toString("utf8");
    }
    return undefined;
  }

  setSecret(ref: string, value: string): void {
    if (process.platform === "win32") {
      const b64 = this.dpapiProtect(value);
      writeFileSync(this.fileFor(ref), `DPAPI:${b64}`, "utf8");
      return;
    }
    writeFileSync(this.fileFor(ref), INSECURE_MARKER + Buffer.from(value, "utf8").toString("base64"), "utf8");
  }

  deleteSecret(ref: string): boolean {
    const file = this.fileFor(ref);
    if (!existsSync(file)) return false;
    writeFileSync(file, ""); // zero content before unlink so the plaintext copy is not trivially recoverable
    unlinkSync(file);
    return true;
  }

  private dpapiProtect(plain: string): string {
    const script = [
      "$ErrorActionPreference='Stop'",
      "Add-Type -AssemblyName System.Security",
      "$in=[Console]::In.ReadToEnd()",
      "$b=[Text.Encoding]::UTF8.GetBytes($in.TrimEnd())",
      "$p=[Security.Cryptography.ProtectedData]::Protect($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)",
      "[Convert]::ToBase64String($p)",
    ].join("; ");
    const res = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      input: plain,
      encoding: "utf8",
      timeout: 20_000,
    });
    if (res.status !== 0 || !res.stdout.trim()) {
      throw new Error(`DPAPI_PROTECT_FAILED: ${(res.stderr || res.stdout || "").slice(0, 200)}`);
    }
    return res.stdout.trim();
  }

  private dpapiUnprotect(b64: string): string {
    const script = [
      "$ErrorActionPreference='Stop'",
      "Add-Type -AssemblyName System.Security",
      "$in=[Console]::In.ReadToEnd()",
      "$b=[Convert]::FromBase64String($in.Trim())",
      "$p=[Security.Cryptography.ProtectedData]::Unprotect($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)",
      "[Text.Encoding]::UTF8.GetString($p)",
    ].join("; ");
    const res = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      input: b64,
      encoding: "utf8",
      timeout: 20_000,
    });
    if (res.status !== 0) {
      throw new Error(`DPAPI_UNPROTECT_FAILED: ${(res.stderr || "").slice(0, 200)}`);
    }
    // PowerShell appends a trailing newline; strip it (API keys have no meaningful trailing whitespace).
    return res.stdout.trimEnd();
  }
}
