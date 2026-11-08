/**
 * AI Repeat — task manager: queue, state machine, browser lifecycle,
 * approvals and cancellation. Owns one AbortController per task; a global
 * stop prevents scheduling any new tool calls.
 *
 * State machine (validated centrally):
 *   queued → running → awaiting_approval | paused | verifying → completed | failed | cancelled
 */
import { randomUUID } from "node:crypto";
import {
  REDACTED_SECRET,
  type TaskEvent,
  type TaskRun,
  type Workflow,
} from "@ai-repeat/contracts";
import {
  BrowserUnavailableError,
  installDomainGuard,
  launchEphemeralContext,
  resolveChromiumExecutable,
  runWorkflow,
  trackBrowserPid,
  untrackBrowserPid,
} from "@ai-repeat/workflows";
import { DomainAllowlist } from "@ai-repeat/security";
import type { GenerateInput, GenerateResult, ModelProvider } from "@ai-repeat/llm";
import type { Store } from "./store.js";
import type { Settings } from "./config.js";

export class TokenBudgetExceededError extends Error {
  constructor(readonly used: number, readonly cap: number) {
    super(`TOKEN_BUDGET_EXCEEDED: المهمة استهلكت ${used} توكن والحد ${cap}. وقفنا بدل ما نكمل حرق.`);
    this.name = "TokenBudgetExceededError";
  }
}

/**
 * Wraps a provider with a per-task token budget. Usage is accumulated from
 * provider-reported numbers only; crossing the cap aborts further model calls.
 */
export function budgetedProvider(inner: ModelProvider, opts: { taskId: string; capTokens: number; onUsage: (inputTokens: number, outputTokens: number) => void }): ModelProvider {
  let used = 0;
  return {
    id: inner.id,
    model: inner.model,
    testConnection: () => inner.testConnection(),
    async generate(input: GenerateInput): Promise<GenerateResult> {
      if (used > opts.capTokens) throw new TokenBudgetExceededError(used, opts.capTokens);
      const res = await inner.generate(input);
      const add = (res.usage?.inputTokens ?? 0) + (res.usage?.outputTokens ?? 0);
      used += add;
      opts.onUsage(res.usage?.inputTokens ?? 0, res.usage?.outputTokens ?? 0);
      if (used > opts.capTokens) throw new TokenBudgetExceededError(used, opts.capTokens);
      return res;
    },
  };
}

export class TaskValidationError extends Error {}

interface ActiveTask {
  run: TaskRun;
  workflow: Workflow;
  abort: AbortController;
  pause: { paused: boolean };
  provider: ModelProvider;
}

export class TaskManager {
  private readonly active = new Map<string, ActiveTask>();
  private readonly queue: string[] = [];
  private runningCount = 0;
  private globalStop = false;
  private readonly events = new Set<(ev: TaskEvent) => void>();
  private readonly allowlist: DomainAllowlist;
  private readonly executablePath: string | null;

  constructor(
    private readonly store: Store,
    private readonly settings: Settings,
    private readonly makeProvider: () => ModelProvider,
  ) {
    this.allowlist = new DomainAllowlist(settings.allowedDomains);
    this.executablePath = resolveChromiumExecutable();
  }

  onEvent(fn: (ev: TaskEvent) => void): () => void {
    this.events.add(fn);
    return () => this.events.delete(fn);
  }

  private emit(ev: TaskEvent): void {
    this.store.appendEvent(ev);
    for (const fn of this.events) fn(ev);
  }

  /** Broadcast system events (e.g. browser install progress) through the same channel. */
  emitSystem(ev: TaskEvent): void {
    this.emit(ev);
  }

  get browserAvailable(): boolean {
    // Re-resolved on demand so a first-run browser install is picked up
    // without restarting the service.
    return this.executablePath !== null || resolveChromiumExecutable() !== null;
  }

  private currentExecutablePath(): string | null {
    return this.executablePath ?? resolveChromiumExecutable();
  }

  /* ------------------------------ creation ------------------------------- */

  createTask(workflow: Workflow, inputs: Record<string, string | number | boolean>, scheduleId?: string): TaskRun {
    // Validate user inputs against the workflow contract; secret inputs are redacted in storage.
    const cleaned: Record<string, string | number | boolean> = {};
    for (const def of workflow.inputs) {
      const v = inputs[def.name];
      if (v === undefined || v === "") {
        if (def.required) throw new TaskValidationError(`قيمة مطلوبة ناقصة: ${def.name}`);
        continue;
      }
      if (def.type === "number" && Number.isNaN(Number(v))) throw new TaskValidationError(`قيمة غير رقمية: ${def.name}`);
      cleaned[def.name] = def.type === "number" ? Number(v) : v;
    }
    const now = new Date().toISOString();
    const run: TaskRun = {
      id: `run_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`,
      workflowId: workflow.id,
      workflowName: workflow.name,
      state: "queued",
      createdAt: now,
      updatedAt: now,
      scheduleId,
      inputs: Object.fromEntries(
        Object.entries(cleaned).map(([k, v]) => [k, workflow.inputs.find((i) => i.name === k)?.secret ? REDACTED_SECRET : v]),
      ),
      outputs: {},
      steps: [],
      verifications: [],
      usage: { inputTokens: 0, outputTokens: 0, requests: 0 },
    };
    this.store.upsertTask(run);
    this.emit({ event: "log", taskId: run.id, at: now, data: { message: "المهمة اتضافت في الطابور", state: "queued", scheduleId } });
    this.queue.push(run.id);
    this.pump();
    return run;
  }

  /* -------------------------------- queue -------------------------------- */

  private pump(): void {
    if (this.globalStop) return;
    const max = this.settings.budgets.maxConcurrentTasks;
    while (this.runningCount < max && this.queue.length > 0) {
      const id = this.queue.shift()!;
      const task = this.store.getTask(id);
      if (!task || task.state !== "queued") continue;
      void this.start(task);
    }
  }

  private async start(task: TaskRun): Promise<void> {
    this.runningCount++;
    const workflow = this.store.getWorkflow(task.workflowId) as Workflow | undefined;
    if (!workflow) {
      this.finish(task, "failed", `WORKFLOW_MISSING: الـworkflow ${task.workflowId} مش موجود`);
      this.runningCount--;
      this.pump();
      return;
    }
    if (!this.browserAvailable) {
      this.finish(task, "failed", new BrowserUnavailableError().message);
      this.runningCount--;
      this.pump();
      return;
    }

    const abort = new AbortController();
    const pause = { paused: false };
    const provider = budgetedProvider(this.makeProvider(), {
      taskId: task.id,
      capTokens: this.settings.budgets.maxTokensPerRun,
      onUsage: (inputTokens, outputTokens) => {
        task.usage.inputTokens += inputTokens;
        task.usage.outputTokens += outputTokens;
        task.usage.requests += 1;
        this.store.appendUsage({
          provider: provider.id,
          model: provider.model,
          taskId: task.id,
          inputTokens,
          outputTokens,
          at: new Date().toISOString(),
        });
        this.emit({
          event: "usage.reported",
          taskId: task.id,
          at: new Date().toISOString(),
          data: { inputTokens, outputTokens, total: task.usage.inputTokens + task.usage.outputTokens },
        });
        this.store.upsertTask(task);
      },
    });
    this.active.set(task.id, { run: task, workflow, abort, pause, provider });

    // Visible even if the browser launch itself stalls (e.g. AV scanning a
    // freshly built browser path) — the task must never sit silently "queued".
    this.emit({ event: "log", taskId: task.id, at: new Date().toISOString(), data: { message: "بدء التنفيذ: فتح متصفح المهمة…" } });
    task.state = "running";
    task.startedAt = new Date().toISOString();
    task.updatedAt = task.startedAt;
    this.store.upsertTask(task);
    this.emit({ event: "task.started", taskId: task.id, at: task.startedAt, data: { workflowId: workflow.id } });

    let context: import("playwright-core").BrowserContext | undefined;
    try {
      context = await launchEphemeralContext({ headless: true, executablePath: this.currentExecutablePath()! });
      const browserObj = context.browser();
      if (browserObj) trackBrowserPid(this.settings.dataDir, browserObj);
      await installDomainGuard(context, this.allowlist);
      const page = await context.newPage();

      // Redact secret inputs before they reach the executor; secret values are only
      // ever present in the user's typed session, never in stored/returned data.
      const execInputs: Record<string, string | number | boolean> = {};
      for (const [k, v] of Object.entries(task.inputs)) {
        execInputs[k] = v === REDACTED_SECRET ? REDACTED_SECRET : v;
      }

      const result = await runWorkflow(
        workflow,
        execInputs,
        {
          taskId: task.id,
          allowlist: this.allowlist,
          workspaceRoot: this.settings.workspaceRoot,
          signal: abort.signal,
          pauseController: pause,
          events: (ev) => this.emit(ev),
          requestApproval: (req) => this.requestApproval(req),
          maxWallMs: this.settings.budgets.maxWallMs,
          saveScreenshots: this.settings.saveScreenshots,
          // Persist every step-state change live so the task timeline updates
          // in real time and paused tasks keep their verified checkpoint
          // across restarts.
          onStepUpdate: (step) => {
            const idx = task.steps.findIndex((s) => s.stepId === step.stepId);
            if (idx >= 0) task.steps[idx] = step;
            else task.steps.push(step);
            task.updatedAt = new Date().toISOString();
            this.store.upsertTask(task);
          },
        },
        page,
        // Resume from the last verified checkpoint (paused task): passed steps
        // are skipped and their outputs restored. A fresh browser context is
        // opened — any login state inside it must come from a persistent profile.
        task.steps.some((s) => s.state === "passed") ? { priorSteps: task.steps, priorOutputs: task.outputs } : undefined,
      );

      // Merge executor step states into the task record.
      task.steps = result.steps;
      task.verifications = result.verifications as TaskRun["verifications"];
      task.outputs = result.outputs;
      task.lastCheckpointStepId = result.lastCheckpointStepId;
      if (result.outcome === "completed") {
        task.state = "completed";
        this.emit({ event: "task.completed", taskId: task.id, at: new Date().toISOString(), data: { verificationPassed: true, workflowName: task.workflowName } });
      } else if (result.outcome === "cancelled") {
        task.state = "cancelled";
        this.emit({ event: "task.cancelled", taskId: task.id, at: new Date().toISOString(), data: { workflowName: task.workflowName } });
      } else if (result.outcome === "paused") {
        task.state = "paused";
        this.emit({ event: "task.paused", taskId: task.id, at: new Date().toISOString() });
      } else {
        task.state = "failed";
        task.error = result.error;
        this.emit({ event: "task.failed", taskId: task.id, at: new Date().toISOString(), data: { error: result.error, workflowName: task.workflowName } });
      }
      this.store.upsertTask(task);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Honest failure — never a fake success.
      this.finish(task, "failed", msg);
    } finally {
      this.active.delete(task.id);
      await context?.close().catch(() => {});
      const closedBrowser = context?.browser();
      if (closedBrowser) {
        const pid = (closedBrowser as unknown as { process?: () => { pid?: number } | null }).process?.()?.pid;
        untrackBrowserPid(this.settings.dataDir, pid);
      }
      this.runningCount--;
      this.pump();
    }
  }

  private finish(task: TaskRun, state: TaskRun["state"], error?: string): void {
    task.state = state;
    task.error = error;
    task.finishedAt = task.finishedAt ?? new Date().toISOString();
    task.updatedAt = task.finishedAt;
    this.store.upsertTask(task);
    if (state === "failed") {
      this.emit({ event: "task.failed", taskId: task.id, at: task.updatedAt, data: { error, workflowName: task.workflowName } });
    } else if (state === "cancelled") {
      this.emit({ event: "task.cancelled", taskId: task.id, at: task.updatedAt, data: { workflowName: task.workflowName } });
    }
  }

  /* ------------------------------ approvals ------------------------------ */

  private requestApproval(req: {
    taskId: string;
    stepId: string;
    fingerprint: string;
    risk: Workflow["steps"][number]["risk"];
    title: string;
    detail: Record<string, unknown>;
  }): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const id = `apr_${randomUUID().slice(0, 12)}`;
      const now = new Date().toISOString();
      const approval = {
        id,
        taskId: req.taskId,
        stepId: req.stepId,
        fingerprint: req.fingerprint,
        risk: req.risk,
        title: req.title,
        detail: req.detail,
        state: "pending" as const,
        requestedAt: now,
        expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
      };
      this.store.upsertApproval(approval);
      // The task state honestly shows what it is waiting on.
      const active = this.active.get(req.taskId);
      if (active) {
        active.run.state = "awaiting_approval";
        active.run.updatedAt = now;
        this.store.upsertTask(active.run);
      }
      this.emit({ event: "approval.requested", taskId: req.taskId, at: now, stepId: req.stepId, data: { approvalId: id, ...req.detail } });

      const timer = setTimeout(() => settle(false), 10 * 60_000);
      // Cancel/abort while awaiting approval resolves it immediately (rejected) —
      // a task must never stay "awaiting_approval" after إيقاف فوري.
      const onAbort = () => settle(false);
      active?.abort.signal.addEventListener("abort", onAbort, { once: true });
      const settle = (approved: boolean) => {
        clearTimeout(timer);
        active?.abort.signal.removeEventListener("abort", onAbort);
        this.pendingApprovals.delete(id);
        if (active) {
          active.run.state = "running";
          active.run.updatedAt = new Date().toISOString();
          this.store.upsertTask(active.run);
        }
        const rec = this.store.getApproval(id);
        if (rec) {
          rec.state = approved ? "approved" : "rejected";
          rec.resolvedAt = new Date().toISOString();
          this.store.upsertApproval(rec);
          this.emit({
            event: "approval.resolved",
            taskId: req.taskId,
            at: rec.resolvedAt,
            stepId: req.stepId,
            data: { approvalId: id, approved },
          });
        }
        resolve(approved);
      };
      this.pendingApprovals.set(id, settle);
    });
  }

  private readonly pendingApprovals = new Map<string, (approved: boolean) => void>();

  /** Approves only when the presented fingerprint matches the one the user saw (S05). */
  resolveApproval(approvalId: string, approve: boolean, presentedFingerprint?: string): { ok: boolean; error?: string } {
    const settle = this.pendingApprovals.get(approvalId);
    const rec = this.store.getApproval(approvalId);
    if (!rec || !settle) return { ok: false, error: "APPROVAL_NOT_PENDING: مفيش موافقة معلّقة بالمعرف ده" };
    if (rec.expiresAt < new Date().toISOString()) {
      this.pendingApprovals.delete(approvalId);
      settle(false);
      return { ok: false, error: "APPROVAL_EXPIRED: الموافقة انتهت صلاحيتها" };
    }
    if (presentedFingerprint && presentedFingerprint !== rec.fingerprint) {
      // Arguments changed after consent — refuse and keep pending action unresolved.
      settle(false);
      return { ok: false, error: "FINGERPRINT_MISMATCH: بيانات الخطوة اتغيرت بعد عرضها — محتاج موافقة جديدة" };
    }
    settle(approve);
    return { ok: true };
  }

  /* ---------------------------- control surface --------------------------- */

  pause(taskId: string): boolean {
    const t = this.active.get(taskId);
    if (!t) return false;
    t.pause.paused = true;
    return true;
  }

  /**
   * Resume a paused task. Two cases:
   *  - still actively running (paused mid-flight): clear the flag and continue.
   *  - already stopped at a checkpoint (possibly from a previous app session):
   *    re-queue it — start() detects the passed steps and resumes from the
   *    last verified checkpoint in a fresh browser context.
   */
  resume(taskId: string): boolean {
    const t = this.active.get(taskId);
    if (t) {
      t.pause.paused = false;
      this.emit({ event: "task.resumed", taskId, at: new Date().toISOString() });
      return true;
    }
    const task = this.store.getTask(taskId);
    if (!task || task.state !== "paused") return false;
    task.state = "queued";
    task.updatedAt = new Date().toISOString();
    task.error = undefined;
    this.store.upsertTask(task);
    this.emit({ event: "task.resumed", taskId, at: task.updatedAt, data: { fromCheckpoint: true } });
    this.queue.push(taskId);
    this.pump();
    return true;
  }

  /** Cancel: stops scheduling new actions immediately; in-flight browser ops abort. */
  cancel(taskId: string): boolean {
    const t = this.active.get(taskId);
    if (t) {
      t.abort.abort();
      return true;
    }
    const task = this.store.getTask(taskId);
    if (task && ["queued"].includes(task.state)) {
      const idx = this.queue.indexOf(taskId);
      if (idx >= 0) this.queue.splice(idx, 1);
      this.finish(task, "cancelled");
      return true;
    }
    return false;
  }

  /**
   * FR-05 global stop: cancels ACTIVE tasks AND drains the queue — a queued
   * task starting 100ms later would violate "prevent new tool calls".
   * Tasks created during the stop window stay queued-safe: after the stop
   * releases, the queue is pumped again so nothing is stuck forever.
   */
  cancelAll(): void {
    for (const id of [...this.active.keys()]) this.cancel(id);
    // Drain queued tasks that never started.
    for (const id of this.queue.splice(0)) {
      const task = this.store.getTask(id);
      if (task && task.state === "queued") this.finish(task, "cancelled");
    }
    this.globalStop = true;
    setTimeout(() => {
      this.globalStop = false;
      this.pump(); // re-pump anything legitimately queued during the stop window
    }, 100);
  }

  /**
   * Retry a finished task as a NEW run (never a blind resume that could repeat
   * a side effect). Secret inputs are not persisted, so tasks that used them
   * must be re-entered manually.
   */
  retryTask(taskId: string): TaskRun {
    const old = this.store.getTask(taskId);
    if (!old) throw new TaskValidationError("TASK_NOT_FOUND: المهمة مش موجودة");
    if (!["failed", "cancelled"].includes(old.state)) {
      throw new TaskValidationError("TASK_NOT_RETRYABLE: إعادة المحاولة للمهام الفاشلة أو الملغاة فقط");
    }
    const workflow = this.store.getWorkflow(old.workflowId) as Workflow | undefined;
    if (!workflow) throw new TaskValidationError("WORKFLOW_MISSING: الـworkflow مش موجود");
    const inputs: Record<string, string | number | boolean> = {};
    for (const [k, v] of Object.entries(old.inputs)) {
      if (v === REDACTED_SECRET) {
        throw new TaskValidationError(`SECRET_INPUT_LOST: قيمة "${k}" حساسة ومحفوظة غيرها — أنشئ المهمة من جديد وأدخلها`);
      }
      inputs[k] = v;
    }
    return this.createTask(workflow, inputs);
  }

  get activeCount(): number {
    return this.active.size;
  }
}
