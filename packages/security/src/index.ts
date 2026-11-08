/**
 * AI Repeat — security core: domain allowlist, file path sandbox,
 * secret redaction, action fingerprinting. These checks run in code,
 * independently of the LLM and independently of workflow JSON trust.
 */
import { createHash } from "node:crypto";
import path from "node:path";
import { REDACTED_SECRET, type RiskTier } from "@ai-repeat/contracts";

/* --------------------------- Domain allowlisting --------------------------- */

function normalizeHost(host: string): string {
  return host.trim().toLowerCase().replace(/^\[|\]$/g, "");
}

export class DomainAllowlist {
  /** entries may be bare hostnames ("localhost") or "example.com". Ports are ignored for matching. */
  constructor(private readonly entries: readonly string[]) {
    this.hosts = new Set(
      entries
        .map((e) => {
          try {
            const u = new URL(e.includes("://") ? e : `http://${e}`);
            return normalizeHost(u.hostname);
          } catch {
            return normalizeHost(e);
          }
        })
        .filter(Boolean),
    );
  }
  private readonly hosts: Set<string>;

  allows(url: string): boolean {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return false;
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
    const host = normalizeHost(parsed.hostname);
    if (host === "") return false;
    if (this.hosts.has(host)) return true;
    // A subdomain matches only if an entry explicitly covers it via a leading dot.
    for (const entry of this.hosts) {
      if (entry.startsWith("*.") && host.endsWith(entry.slice(1))) return true;
    }
    return false;
  }

  get hostsList(): string[] {
    return [...this.hosts];
  }
}

export function classifyNavigationViolation(
  url: string,
  allowlist: DomainAllowlist,
): { blocked: true; reason: string } | { blocked: false } {
  if (allowlist.allows(url)) return { blocked: false };
  let host = url;
  try {
    host = new URL(url).hostname;
  } catch {
    /* keep raw */
  }
  return {
    blocked: true,
    reason: `Domain not approved: ${host}. Allowed domains: ${allowlist.hostsList.join(", ")}`,
  };
}

/* ------------------------------ Path sandboxing ---------------------------- */

/**
 * Resolves `target` inside `workspaceRoot` and refuses traversal outside it,
 * including UNC/device paths and absolute escapes.
 */
export function safeJoinWithin(workspaceRoot: string, target: string): { ok: true; path: string } | { ok: false; reason: string } {
  if (target.trim() === "") return { ok: false, reason: "Empty path" };
  if (/^[a-zA-Z]:[\\/]/.test(target) || target.startsWith("\\\\") || path.isAbsolute(target)) {
    // Absolute paths are allowed only if they are already inside the workspace.
    const resolved = path.resolve(target);
    return insideRoot(workspaceRoot, resolved);
  }
  const resolved = path.resolve(workspaceRoot, target);
  return insideRoot(workspaceRoot, resolved);
}

function insideRoot(workspaceRoot: string, resolved: string): { ok: true; path: string } | { ok: false; reason: string } {
  const rootAbs = path.resolve(workspaceRoot) + path.sep;
  const norm = path.normalize(resolved);
  if (norm === path.resolve(workspaceRoot)) return { ok: true, path: norm };
  if (norm.startsWith(rootAbs)) return { ok: true, path: norm };
  return { ok: false, reason: `Path escapes approved workspace: ${norm}` };
}

/** Blocks obviously dangerous/double-extension filenames in downloaded or exported artifacts. */
export function sanitizeFilename(name: string): string {
  const base = path.basename(name).replace(/[\u0000-\u001f<>:"|?*]/g, "_").trim();
  if (!base || base === "." || base === "..") return "artifact";
  return base;
}

/* ------------------------------- Redaction -------------------------------- */

const SENSITIVE_KEY_PATTERN =
  /(password|passwd|pass\b|pwd|secret|token|api[_-]?key|authorization|auth|cookie|session|otp|one[-_]?time|card|cvv|cvc|pin|credential)/i;

export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_PATTERN.test(key);
}

/**
 * Redacts sensitive values from arbitrary log/event structures.
 * Also scrubs obvious bearer tokens and email+password pairs in strings.
 */
export function redactValue(value: unknown, depth = 0): unknown {
  if (depth > 8) return "[depth-limit]";
  if (typeof value === "string") return redactString(value);
  if (Array.isArray(value)) return value.slice(0, 100).map((v) => redactValue(v, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (isSensitiveKey(k)) {
        out[k] = REDACTED_SECRET;
      } else if (typeof v === "string" && looksLikeUrlWithSecret(v)) {
        out[k] = redactString(v);
      } else {
        out[k] = redactValue(v, depth + 1);
      }
    }
    return out;
  }
  return value;
}

const BEARER_RE = /(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi;
const KEYVALUE_SECRET_RE =
  /((?:password|passwd|token|api[_-]?key|secret|otp|authorization)\s*[:=]\s*)([^\s&"']{4,})/gi;
const URL_CREDS_RE = /(\w)(:\/\/)([^@/\s:]+):([^@/\s]+)@/g;

export function redactString(input: string): string {
  return input
    .replace(BEARER_RE, "$1" + REDACTED_SECRET)
    .replace(KEYVALUE_SECRET_RE, (_m, p1: string) => `${p1}${REDACTED_SECRET}`)
    .replace(URL_CREDS_RE, (_m, user: string, sep: string) => `${user}${sep}${REDACTED_SECRET}:${REDACTED_SECRET}@`);
}

function looksLikeUrlWithSecret(v: string): boolean {
  return /:\/\/[^@/\s:]+:[^@/\s]+@/.test(v);
}

/** Values captured from these input types are never stored or sent to a model. */
export const NEVER_RECORD_SELECTORS = [
  "input[type=password]",
  "input[type=hidden]",
  "input[autocomplete=cc-number]",
  "input[autocomplete=cc-cvc]",
  "input[autocomplete=one-time-code]",
  "input[name*=otp i]",
  "input[name*=password i]",
];

export function isSecretInputElement(el: {
  inputType?: string | null;
  autocomplete?: string | null;
  name?: string | null;
  id?: string | null;
}): boolean {
  const t = (el.inputType ?? "").toLowerCase();
  const ac = (el.autocomplete ?? "").toLowerCase();
  const nm = `${el.name ?? ""} ${el.id ?? ""}`.toLowerCase();
  if (t === "password" || t === "hidden") return true;
  if (ac.startsWith("cc-") || ac === "one-time-code" || ac === "current-password" || ac === "new-password") return true;
  if (/(otp|one[-_]?time|passcode|password|cvv|cvc|card-?number)/.test(nm)) return true;
  return false;
}

/* --------------------------- Fingerprinting/approvals ---------------------- */

/**
 * Stable fingerprint binding an approval to the exact action arguments.
 * Retries or mutations that change any bound field produce a different
 * fingerprint and MUST require a fresh approval (test S05).
 */
export function actionFingerprint(parts: {
  taskId: string;
  workflowId: string;
  stepId: string;
  action: string;
  url?: string;
  locator?: unknown;
  value?: unknown;
  path?: string;
}): string {
  const h = createHash("sha256");
  h.update(parts.taskId);
  h.update("\u0000");
  h.update(parts.workflowId);
  h.update("\u0000");
  h.update(parts.stepId);
  h.update("\u0000");
  h.update(parts.action);
  h.update("\u0000");
  h.update(parts.url ?? "");
  h.update("\u0000");
  h.update(JSON.stringify(parts.locator ?? null));
  h.update("\u0000");
  h.update(String(parts.value ?? ""));
  h.update("\u0000");
  h.update(parts.path ?? "");
  return h.digest("hex");
}

/* --------------------------------- Policy --------------------------------- */

export interface RiskPolicy {
  /** read + local_write may auto-run when the workflow policy allows; external_write and high_impact always need approval. */
  autoApproveTiers: readonly RiskTier[];
}

export const DEFAULT_RISK_POLICY: RiskPolicy = {
  autoApproveTiers: ["read", "local_write"],
};

export function needsApproval(risk: RiskTier, workflowAutoApproves: boolean, policy: RiskPolicy = DEFAULT_RISK_POLICY): boolean {
  if (!policy.autoApproveTiers.includes(risk)) return true;
  if (risk === "read") return !(workflowAutoApproves && policy.autoApproveTiers.includes("read"));
  if (risk === "local_write") return !(workflowAutoApproves && policy.autoApproveTiers.includes("local_write"));
  return true;
}

/* ------------------------- Prompt-injection neutrality --------------------- */

/**
 * Wraps untrusted page content before it can be shown to any model or logged.
 * Content is data; it never gains tool or instruction privileges.
 */
export function markUntrusted(source: string, text: string): string {
  const trimmed = text.length > 4000 ? text.slice(0, 4000) + `… [truncated ${text.length - 4000} chars]` : text;
  return `<untrusted-content source="${redactString(source)}">\n${redactString(trimmed)}\n</untrusted-content>`;
}
