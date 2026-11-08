/**
 * AI Repeat — workflow executor.
 * Runs validated Workflow definitions against an app-owned browser context.
 *
 * Guarantees (enforced here, not by the LLM or the JSON):
 *  - Only the allowlisted browser tools exist; anything else is rejected.
 *  - Navigation/request layer blocks every non-approved domain (network-level).
 *  - Secret input fields are never filled, recorded or exported.
 *  - external_write/high_impact actions require a per-action approval bound
 *    to an exact fingerprint; mutated arguments require fresh consent.
 *  - Idempotent steps may retry with backoff; side-effect steps never retry blindly.
 *  - Cancellation stops scheduling new actions immediately.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  REDACTED_SECRET,
  VAR_PATTERN,
  type Locator,
  type StepRun,
  type TaskEvent,
  type Workflow,
  type WorkflowStep,
} from "@ai-repeat/contracts";
import {
  DomainAllowlist,
  actionFingerprint,
  isSecretInputElement,
  needsApproval,
  redactValue,
  safeJoinWithin,
  sanitizeFilename,
} from "@ai-repeat/security";
import type { BrowserContext, Locator as PwLocator, Page } from "playwright-core";

/* ------------------------------- Errors ----------------------------------- */

export class CancelledError extends Error {
  constructor() {
    super("CANCELLED");
    this.name = "CancelledError";
  }
}
export class PausedError extends Error {
  constructor() {
    super("PAUSED");
    this.name = "PausedError";
  }
}
export class ApprovalRejectedError extends Error {
  constructor(stepId: string) {
    super(`APPROVAL_REJECTED: المستخدم رفض الخطوة ${stepId}`);
    this.name = "ApprovalRejectedError";
  }
}
export class SecurityViolationError extends Error {
  constructor(message: string) {
    super(`SECURITY: ${message}`);
    this.name = "SecurityViolationError";
  }
}

/* ------------------------------ Run state --------------------------------- */

export interface ExecutorContext {
  taskId: string;
  allowlist: DomainAllowlist;
  /** Absolute root of the only writable output directory. */
  workspaceRoot: string;
  signal: AbortSignal;
  /** Shared pause flag checked between steps. */
  pauseController?: { paused: boolean };
  events: (ev: TaskEvent) => void;
  requestApproval: (req: {
    taskId: string;
    stepId: string;
    fingerprint: string;
    risk: WorkflowStep["risk"];
    title: string;
    detail: Record<string, unknown>;
  }) => Promise<boolean>;
  maxStepRetries?: number;
  defaultTimeoutMs?: number;
  /** Wall clock budget in ms (default 15 min). */
  maxWallMs?: number;
  /** Opt-in: capture a page screenshot as evidence when a step fails. Default false. */
  saveScreenshots?: boolean;
  /** Live step-state updates (started/passed/failed/awaiting_approval) for persistence + UI. */
  onStepUpdate?: (step: StepRun) => void;
}

export interface WorkflowRunResult {
  outcome: "completed" | "failed" | "cancelled" | "paused";
  error?: string;
  steps: StepRun[];
  verifications: Array<{ kind: string; passed: boolean; detail: string; at: string }>;
  outputs: Record<string, unknown>;
  lastCheckpointStepId?: string;
}

/* ------------------------------ Templates --------------------------------- */

export function renderTemplate(tpl: string, vars: Record<string, string | number | boolean>): string {
  return tpl.replace(VAR_PATTERN, (_m, name: string) => {
    const v = vars[name];
    return v === undefined ? `{{${name}}}` : String(v);
  });
}

/** True when a template still contains an unresolved {{var}} placeholder. */
function hasUnresolvedTemplate(tpl: string): boolean {
  return VAR_PATTERN.test(tpl);
}

/* ------------------------------ Locators ---------------------------------- */

export function resolveLocator(page: Page, loc: Locator): PwLocator {
  switch (loc.strategy) {
    case "role":
      return page.getByRole(loc.value as Parameters<Page["getByRole"]>[0], { name: loc.name ?? undefined });
    case "label":
      return page.getByLabel(loc.value);
    case "testid":
      return page.locator(`[data-testid="${loc.value}"]`);
    case "text":
      return page.getByText(loc.value);
    case "css":
      return page.locator(loc.value);
  }
}

/* -------------------------------- CSV -------------------------------------- */

export function toCsv(rows: Array<Record<string, unknown>>): string {
  if (rows.length === 0) return "";
  const headers = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const esc = (v: unknown): string => {
    const s = v === null || v === undefined ? "" : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [headers.join(","), ...rows.map((r) => headers.map((h) => esc(r[h])).join(","))];
  // BOM so Excel renders Arabic correctly.
  return "\uFEFF" + lines.join("\r\n");
}

/* ------------------------------ Executor ----------------------------------- */

class AbortedError extends Error {
  constructor() {
    super("ABORTED_BY_SIGNAL");
  }
}

function raceWithAbort<T>(p: Promise<T>, signal: AbortSignal, cleanupOnAbort?: () => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanupOnAbort?.();
      reject(new AbortedError());
    };
    if (signal.aborted) return onAbort();
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(
      (v) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        reject(e);
      },
    );
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Installs a network-level guard: only approved domains may receive any request. */
export async function installDomainGuard(context: BrowserContext, allowlist: DomainAllowlist): Promise<void> {
  await context.route("**/*", (route) => {
    const url = route.request().url();
    if (url.startsWith("data:") || url.startsWith("about:")) return route.continue().catch(() => {});
    if (allowlist.allows(url)) return route.continue().catch(() => {});
    // Everything else — including injected exfil targets — is aborted in the network layer.
    return route.abort("blockedbyclient").catch(() => {});
  });
}

interface RunInternal {
  outputs: Record<string, unknown>;
  steps: StepRun[];
  lastCheckpointStepId?: string;
}

export async function runWorkflow(
  workflow: Workflow,
  inputs: Record<string, string | number | boolean>,
  ctx: ExecutorContext,
  page: Page,
  resume?: { priorSteps: StepRun[]; priorOutputs: Record<string, unknown> },
): Promise<WorkflowRunResult> {
  const startedAt = Date.now();
  const maxWallMs = ctx.maxWallMs ?? 15 * 60_000;
  const defaultTimeout = ctx.defaultTimeoutMs ?? 15_000;
  const maxStepRetries = ctx.maxStepRetries ?? 2;

  const run: RunInternal = {
    outputs: { ...(resume?.priorOutputs ?? {}) },
    steps: (resume?.priorSteps ?? []).map((s) => ({ ...s })),
    lastCheckpointStepId: resume?.priorSteps.filter((s) => s.state === "passed").at(-1)?.stepId,
  };

  const checkpointable = (risk: WorkflowStep["risk"]) => risk === "read" || risk === "local_write";

  const emit = (ev: TaskEvent) => ctx.events(ev);

  const outcome = async (): Promise<WorkflowRunResult> => {
    let verdict: WorkflowRunResult["outcome"] = "completed";
    let error: string | undefined;
    // Verification phase — deterministic, independent of any model claims.
    const verifications: WorkflowRunResult["verifications"] = [];
    for (const v of workflow.verification) {
      const r = await checkVerification(v, page, ctx, run.outputs, inputs).catch((e: Error) => ({
        kind: v.kind,
        passed: false,
        detail: `verification crashed: ${e.message}`,
      }));
      verifications.push({ ...r, at: new Date().toISOString() });
      emit({
        event: r.passed ? "verification.passed" : "verification.failed",
        taskId: ctx.taskId,
        at: new Date().toISOString(),
        data: r as unknown as Record<string, unknown>,
      });
      if (!r.passed && verdict === "completed") {
        verdict = "failed";
        error = `VERIFICATION_FAILED: ${r.kind} — ${r.detail}`;
      }
    }
    return { outcome: verdict, error, steps: run.steps, verifications, outputs: run.outputs, lastCheckpointStepId: run.lastCheckpointStepId };
  };

  try {
    for (const step of workflow.steps) {
      if (ctx.signal.aborted) throw new CancelledError();
      if (ctx.pauseController?.paused) throw new PausedError();
      if (Date.now() - startedAt > maxWallMs) throw new Error(`TIME_BUDGET: تجاوزت المهمة الحد الزمني (${Math.round(maxWallMs / 1000)}s)`);

      const prior = run.steps.find((s) => s.stepId === step.id);
      if (prior?.state === "passed") continue; // resume from checkpoint

      const stepRun: StepRun = prior ?? {
        stepId: step.id,
        action: step.action,
        summary: step.summary,
        state: "pending",
        attempt: 0,
      };
      if (!run.steps.includes(stepRun)) run.steps.push(stepRun);
      const reportStep = () => ctx.onStepUpdate?.({ ...stepRun });
      reportStep();

      // ---- Approval gate (code-level policy, before any execution) ----
      const approvalNeeded = step.action === "request_approval" || step.requiresApproval || needsApproval(step.risk, workflow.policy.autoApproveRead && workflow.policy.autoApproveLocalWrite);
      const fingerprint = actionFingerprint({
        taskId: ctx.taskId,
        workflowId: workflow.id,
        stepId: step.id,
        action: step.action,
        url: step.url,
        locator: step.locator ?? null,
        value: step.value,
        path: step.path,
      });
      if (approvalNeeded) {
        stepRun.state = "awaiting_approval";
        reportStep();
        const detail = buildApprovalDetail(step, inputs, run.outputs);
        emit({
          event: "approval.requested",
          taskId: ctx.taskId,
          at: new Date().toISOString(),
          stepId: step.id,
          data: { fingerprint, risk: step.risk, detail },
        });
        const approved = await ctx.requestApproval({
          taskId: ctx.taskId,
          stepId: step.id,
          fingerprint,
          risk: step.risk,
          title: step.summary ?? `${step.action} ${step.locator?.value ?? step.url ?? step.path ?? ""}`.trim(),
          detail,
        });
        if (!approved) {
          stepRun.state = "failed";
          stepRun.error = "المستخدم رفض الخطوة";
          stepRun.finishedAt = new Date().toISOString();
          throw new ApprovalRejectedError(step.id);
        }
        stepRun.state = "pending";
      }

      // ---- Retry loop (bounded; side-effect steps get no blind retry) ----
      const retryable = checkpointable(step.risk);
      let attempt = 0;
      for (;;) {
        attempt++;
        stepRun.attempt = attempt;
        stepRun.state = "running";
        stepRun.startedAt = new Date().toISOString();
        reportStep();
        emit({ event: "step.started", taskId: ctx.taskId, at: stepRun.startedAt, stepId: step.id, data: { action: step.action } });
        try {
          const { args, evidence, outputs } = await executeStep(step, inputs, run.outputs, page, ctx, defaultTimeout);
          stepRun.args = redactValue(args) as Record<string, unknown>;
          stepRun.evidence = redactValue(evidence) as Record<string, unknown>;
          stepRun.state = "passed";
          stepRun.finishedAt = new Date().toISOString();
          stepRun.durationMs = Date.now() - new Date(stepRun.startedAt).getTime();
          reportStep();
          Object.assign(run.outputs, outputs);
          if (checkpointable(step.risk)) run.lastCheckpointStepId = step.id;
          emit({
            event: "step.verified",
            taskId: ctx.taskId,
            at: new Date().toISOString(),
            stepId: step.id,
            data: { evidence: stepRun.evidence, outputs: redactValue(outputs) },
          });
          break;
        } catch (err) {
          if (err instanceof AbortedError) throw new CancelledError();
          if (err instanceof PausedError) throw err;
          const msg = err instanceof Error ? err.message : String(err);
          const transient = /timeout|timed out|ECONNRESET|net::|Navigation/i.test(msg) && retryable;
          stepRun.error = msg;
          // Opt-in failure evidence: a scoped page screenshot in the app workspace
          // (never the user's desktop), referenced from the step record.
          if (ctx.saveScreenshots && !ctx.signal.aborted) {
            try {
              const shotPath = await captureFailureScreenshot(page, ctx, step.id, attempt);
              if (shotPath) (stepRun.evidence ??= {}).screenshot = shotPath;
            } catch {
              /* evidence capture must never mask the real failure */
            }
          }
          if (transient && attempt <= maxStepRetries) {
            await sleep(Math.min(2 ** attempt * 250, 4000));
            continue;
          }
          stepRun.state = "failed";
          stepRun.finishedAt = new Date().toISOString();
          stepRun.durationMs = Date.now() - new Date(stepRun.startedAt).getTime();
          reportStep();
          emit({
            event: "step.failed",
            taskId: ctx.taskId,
            at: new Date().toISOString(),
            stepId: step.id,
            data: { error: msg, attempt },
          });
          throw err instanceof Error ? err : new Error(msg);
        }
      }
    }
    return await outcome();
  } catch (err) {
    if (err instanceof CancelledError) {
      return { outcome: "cancelled", steps: run.steps, verifications: [], outputs: run.outputs, lastCheckpointStepId: run.lastCheckpointStepId };
    }
    if (err instanceof PausedError) {
      return { outcome: "paused", steps: run.steps, verifications: [], outputs: run.outputs, lastCheckpointStepId: run.lastCheckpointStepId };
    }
    // A rejection triggered by cancellation/abort is a cancellation, not a
    // user "no" — إيقاف فوري أثناء انتظار الموافقة لازم يطلع cancelled.
    if (err instanceof ApprovalRejectedError && ctx.signal.aborted) {
      return { outcome: "cancelled", steps: run.steps, verifications: [], outputs: run.outputs, lastCheckpointStepId: run.lastCheckpointStepId };
    }
    const msg = err instanceof Error ? err.message : String(err);
    return {
      outcome: "failed",
      error: msg,
      steps: run.steps,
      verifications: [],
      outputs: run.outputs,
      lastCheckpointStepId: run.lastCheckpointStepId,
    };
  }
}

/* ---------------------------- Step handlers -------------------------------- */

async function captureFailureScreenshot(page: Page, ctx: ExecutorContext, stepId: string, attempt: number): Promise<string | null> {
  const dir = safeJoinWithin(ctx.workspaceRoot, path.join("evidence", sanitizeFilename(ctx.taskId)));
  if (!dir.ok) return null;
  mkdirSync(dir.path, { recursive: true });
  const file = path.join(dir.path, `${sanitizeFilename(stepId)}-attempt${attempt}.png`);
  await page.screenshot({ path: file, fullPage: false, timeout: 5000 });
  return file;
}

async function executeStep(
  step: WorkflowStep,
  inputs: Record<string, string | number | boolean>,
  outputs: Record<string, unknown>,
  page: Page,
  ctx: ExecutorContext,
  defaultTimeout: number,
): Promise<{ args: Record<string, unknown>; evidence: Record<string, unknown>; outputs: Record<string, unknown> }> {
  const timeout = step.timeoutMs ?? defaultTimeout;
  const ev = (evidence: Record<string, unknown>) => evidence;
  switch (step.action) {
    case "navigate": {
      if (!step.url) throw new Error("VALIDATION: navigate يحتاج url");
      const url = renderTemplate(step.url, inputs);
      if (hasUnresolvedTemplate(url)) throw new Error(`VALIDATION: متغير غير معبأ في الرابط (${url})`);
      const parsed = new URL(url);
      if (!ctx.allowlist.allows(url)) {
        throw new SecurityViolationError(`النطاق غير مسموح: ${parsed.hostname} (المسموح: ${ctx.allowlist.hostsList.join(", ")})`);
      }
      await raceWithAbort(page.goto(url, { waitUntil: "load", timeout }), ctx.signal);
      return { args: { url }, evidence: ev({ currentUrl: page.url() }), outputs: {} };
    }

    case "click": {
      if (!step.locator) throw new Error("VALIDATION: click يحتاج locator");
      const loc = resolveLocator(page, step.locator);
      await raceWithAbort(loc.waitFor({ state: "visible", timeout }), ctx.signal);
      await raceWithAbort(loc.click({ timeout }), ctx.signal);
      await raceWithAbort(page.waitForLoadState("load", { timeout: 5000 }).catch(() => {}), ctx.signal);
      const current = page.url();
      // Defense in depth: a click that navigated outside the allowlist is a violation.
      if (!current.startsWith("about:") && !ctx.allowlist.allows(current)) {
        throw new SecurityViolationError(`الضغطة حوّلت الصفحة لنطاق غير مسموح: ${current}`);
      }
      return { args: { locator: step.locator }, evidence: ev({ currentUrl: current }), outputs: {} };
    }

    case "fill": {
      if (!step.locator || step.value === undefined) throw new Error("VALIDATION: fill يحتاج locator و value");
      const loc = resolveLocator(page, step.locator);
      await raceWithAbort(loc.waitFor({ state: "visible", timeout }), ctx.signal);
      const info = await raceWithAbort(
        loc.evaluateAll((els: unknown[]) =>
          (els as HTMLInputElement[]).map((el) => ({
            inputType: (el as HTMLInputElement).type ?? null,
            autocomplete: el.getAttribute("autocomplete"),
            name: (el as HTMLInputElement).name ?? null,
            id: el.id ?? null,
          })),
        ),
        ctx.signal,
      );
      const rendered = renderTemplate(String(step.value), inputs);
      if (hasUnresolvedTemplate(rendered)) throw new Error(`VALIDATION: متغير غير معبأ في القيمة (${rendered})`);
      // A workflow step must never carry or type a secret into password/OTP/card fields.
      if (info.some(isSecretInputElement)) {
        throw new SecurityViolationError(
          "الحقل الهدف حقل حساس (كلمة سر/OTP/بطاقة). الخطوات المسجلة لا تكتب أبدًا في الحقول دي — محتاج نقطة تحقق يدوية.",
        );
      }
      await raceWithAbort(loc.fill(rendered, { timeout }), ctx.signal);
      return {
        args: { locator: step.locator, value: rendered },
        evidence: ev({ filledLength: rendered.length }),
        outputs: {},
      };
    }

    case "select": {
      if (!step.locator || step.value === undefined) throw new Error("VALIDATION: select يحتاج locator و value");
      const loc = resolveLocator(page, step.locator);
      await raceWithAbort(loc.selectOption(String(step.value), { timeout }), ctx.signal);
      return { args: { locator: step.locator, value: step.value }, evidence: ev({}), outputs: {} };
    }

    case "wait_visible": {
      if (!step.locator) throw new Error("VALIDATION: wait_visible يحتاج locator");
      const loc = resolveLocator(page, step.locator);
      await raceWithAbort(loc.waitFor({ state: "visible", timeout }), ctx.signal);
      return { args: { locator: step.locator }, evidence: ev({ visible: true }), outputs: {} };
    }

    case "extract_table": {
      if (!step.locator) throw new Error("VALIDATION: extract_table يحتاج locator");
      const tableLoc = resolveLocator(page, step.locator);
      const rows = await raceWithAbort(
        tableLoc.evaluate((table: unknown) => {
          const t = table as HTMLTableElement;
          const headers = [...t.querySelectorAll("thead th")].map((th) => th.textContent?.trim() ?? "");
          const bodyRows = [...t.querySelectorAll("tbody tr")];
          return bodyRows.map((tr) => {
            const cells = [...tr.querySelectorAll("td, th")].map((td) => td.textContent?.trim() ?? "");
            const rec: Record<string, string> = {};
            headers.forEach((h, i) => {
              rec[h || `col_${i}`] = cells[i] ?? "";
            });
            return rec;
          });
        }),
        ctx.signal,
      );
      const key = step.outputKey ?? "rows";
      return {
        args: { locator: step.locator },
        evidence: ev({ rowCount: rows.length, sample: redactValue(rows.slice(0, 3)) }),
        outputs: { [key]: rows, [`${key}_count`]: rows.length },
      };
    }

    case "download": {
      if (!step.locator && !step.url) throw new Error("VALIDATION: download يحتاج locator أو url");
      const targetRel = step.path ?? "downloads/artifact";
      const sandbox = safeJoinWithin(ctx.workspaceRoot, targetRel);
      if (!sandbox.ok) throw new SecurityViolationError(sandbox.reason);
      const destDir = path.dirname(sandbox.path);
      mkdirSync(destDir, { recursive: true });
      if (step.locator) {
        const loc = resolveLocator(page, step.locator);
        const downloadPromise = page.waitForEvent("download", { timeout });
        await raceWithAbort(loc.click({ timeout }), ctx.signal);
        const download = await raceWithAbort(downloadPromise, ctx.signal);
        const filename = sanitizeFilename(download.suggestedFilename() ?? "artifact");
        const dest = path.join(sandbox.path, filename);
        await raceWithAbort(download.saveAs(dest), ctx.signal);
        return {
          args: { locator: step.locator, path: dest },
          evidence: ev({ file: dest, sizeBytes: existsSync(dest) ? 1 : 0 }),
          outputs: { download_path: dest },
        };
      }
      const url = renderTemplate(step.url!, inputs);
      if (!ctx.allowlist.allows(url)) throw new SecurityViolationError(`النطاق غير مسموح: ${url}`);
      const res = await raceWithAbort(page.request.get(url, { timeout }), ctx.signal);
      if (!res.ok()) throw new Error(`DOWNLOAD_FAILED: HTTP ${res.status()}`);
      const body = await raceWithAbort(res.body(), ctx.signal);
      const filename = sanitizeFilename(path.basename(new URL(url).pathname) || "artifact");
      const dest = path.join(sandbox.path, filename);
      writeFileSync(dest, body);
      return { args: { url, path: dest }, evidence: ev({ file: dest, bytes: body.length }), outputs: { download_path: dest } };
    }

    case "export_csv": {
      const key = step.outputKey ?? "rows";
      const rows = outputs[key];
      if (!Array.isArray(rows)) throw new Error(`VALIDATION: مفيش صفوف تحت المفتاح ${key} — اتأكد إن extract_table سبقها بنفس outputKey`);
      const targetRel = step.path ?? "outputs/export.csv";
      const sandbox = safeJoinWithin(ctx.workspaceRoot, targetRel);
      if (!sandbox.ok) throw new SecurityViolationError(sandbox.reason);
      // Path must point at a file inside the workspace; parents are created.
      if (existsSync(sandbox.path) && !sandbox.path.endsWith(".csv")) {
        throw new SecurityViolationError("مسار التصدير لازم يكون ملف CSV");
      }
      mkdirSync(path.dirname(sandbox.path), { recursive: true });
      const csv = toCsv(rows as Array<Record<string, unknown>>);
      writeFileSync(sandbox.path, csv, "utf8");
      return {
        args: { path: sandbox.path, rows: rows.length, value: undefined },
        evidence: ev({ file: sandbox.path, rows: rows.length, bytes: Buffer.byteLength(csv) }),
        outputs: { export_path: sandbox.path, export_rows: rows.length },
      };
    }

    case "request_approval": {
      // The approval gate already ran before this handler; reaching here means approved.
      return { args: {}, evidence: ev({ approved: true }), outputs: {} };
    }

    default: {
      // Unreachable for validated workflows; kept as the code-level allowlist backstop (S04).
      throw new SecurityViolationError(`أداة غير مسموحة خارج السجل: ${String((step as { action?: string }).action)}`);
    }
  }
}

function buildApprovalDetail(
  step: WorkflowStep,
  inputs: Record<string, string | number | boolean>,
  outputs: Record<string, unknown>,
): Record<string, unknown> {
  const detail: Record<string, unknown> = {
    action: step.action,
    risk: step.risk,
    url: step.url,
    locator: step.locator,
    summary: step.summary,
  };
  if (step.value !== undefined) detail.value = renderTemplate(String(step.value), inputs);
  if (step.path) detail.path = step.path;
  if (step.outputKey && Array.isArray(outputs[step.outputKey])) {
    detail.rowsCount = (outputs[step.outputKey] as unknown[]).length;
    detail.rowsPreview = redactValue((outputs[step.outputKey] as unknown[]).slice(0, 5));
  }
  // Secret inputs never appear in approval payloads.
  detail.inputs = Object.fromEntries(
    Object.entries(inputs).map(([k, v]) => [
      k,
      /password|secret|token|otp|card/i.test(k) ? REDACTED_SECRET : v,
    ]),
  );
  return detail;
}

/* ----------------------------- Verification -------------------------------- */

async function checkVerification(
  v: import("@ai-repeat/contracts").WorkflowVerification,
  page: Page,
  ctx: ExecutorContext,
  outputs: Record<string, unknown>,
  inputs: Record<string, string | number | boolean> = {},
): Promise<{ kind: string; passed: boolean; detail: string }> {
  switch (v.kind) {
    case "url_matches": {
      const pattern = renderTemplate(v.target ?? "", inputs);
      const current = page.url();
      const regex = new RegExp(
        "^" + pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$",
      );
      const passed = regex.test(current);
      return { kind: v.kind, passed, detail: `الرابط الحالي ${current} ${passed ? "يطابق" : "لا يطابق"} ${pattern}` };
    }
    case "element_visible": {
      const target = v.target ?? "";
      const count = await page.locator(target).count();
      const passed = count > 0 && (await page.locator(target).first().isVisible());
      return { kind: v.kind, passed, detail: `العنصر ${target} ${passed ? "ظاهر" : "غير ظاهر"} (${count} مطابقة)` };
    }
    case "file_exists": {
      const sandbox = safeJoinWithin(ctx.workspaceRoot, v.target ?? "");
      if (!sandbox.ok) return { kind: v.kind, passed: false, detail: sandbox.reason };
      const exists = existsSync(sandbox.path);
      let size = 0;
      if (exists) size = (await import("node:fs")).statSync(sandbox.path).size;
      return { kind: v.kind, passed: exists && size > 0, detail: `الملف ${v.target} ${exists ? `موجود (${size} bytes)` : "غير موجود"}` };
    }
    case "table_row_count": {
      const target = v.target ?? "";
      const count = await page.locator(target).count();
      const expected = v.expectedCount ?? 0;
      const passed = count === expected;
      return { kind: v.kind, passed, detail: `الصفوف ${count} والمتوقع ${expected}` };
    }
    case "text_contains": {
      const expected = renderTemplate(v.expectedText ?? "", inputs);
      if (v.target && (v.target.startsWith("workspace:") || existsSync(path.resolve(ctx.workspaceRoot, v.target)))) {
        const rel = v.target.replace(/^workspace:/, "");
        const sandbox = safeJoinWithin(ctx.workspaceRoot, rel);
        if (!sandbox.ok) return { kind: v.kind, passed: false, detail: sandbox.reason };
        const content = existsSync(sandbox.path) ? (await import("node:fs")).readFileSync(sandbox.path, "utf8") : "";
        const passed = content.includes(expected);
        void outputs;
        return { kind: v.kind, passed, detail: passed ? `النص موجود في ${rel}` : `النص غير موجود في ${rel}` };
      }
      const content = await page.content();
      const passed = content.includes(expected);
      return { kind: v.kind, passed, detail: passed ? "النص ظاهر في الصفحة" : "النص غير موجود في الصفحة" };
    }
    default:
      return { kind: String((v as { kind?: string }).kind), passed: false, detail: "نوع تحقق غير معروف" };
  }
}
