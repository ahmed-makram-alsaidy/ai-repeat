/**
 * AI Repeat — shared contracts (Zod schemas + TS types).
 * Source of truth: AI_Repeat_Agent_Pack/schemas/workflow.schema.json (v0.1)
 * The executor MUST additionally enforce permissions in code — a valid
 * workflow JSON is not, by itself, permission to run unsafe actions.
 */
import { z } from "zod";

/* ----------------------------- Workflow schema ---------------------------- */

export const RISK_TIERS = ["read", "local_write", "external_write", "high_impact"] as const;
export type RiskTier = (typeof RISK_TIERS)[number];

export const LOCATOR_STRATEGIES = ["role", "label", "testid", "text", "css"] as const;
export type LocatorStrategy = (typeof LOCATOR_STRATEGIES)[number];

export const LocatorSchema = z
  .object({
    strategy: z.enum(LOCATOR_STRATEGIES),
    value: z.string().min(1).max(500),
    name: z.string().max(200).optional(),
  })
  .strict();
export type Locator = z.infer<typeof LocatorSchema>;

export const STEP_ACTIONS = [
  "navigate",
  "click",
  "fill",
  "select",
  "wait_visible",
  "extract_table",
  "download",
  "export_csv",
  "request_approval",
] as const;
export type StepAction = (typeof STEP_ACTIONS)[number];

export const WorkflowInputSchema = z
  .object({
    name: z.string().regex(/^[A-Za-z][A-Za-z0-9_]*$/),
    type: z.enum(["string", "number", "boolean", "date"]),
    required: z.boolean(),
    description: z.string().max(200).optional(),
    secret: z.boolean().default(false),
  })
  .strict();
export type WorkflowInput = z.infer<typeof WorkflowInputSchema>;

export const StepSchema = z
  .object({
    id: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/),
    action: z.enum(STEP_ACTIONS),
    url: z.string().max(2048).optional(),
    locator: LocatorSchema.optional(),
    /** Literal value or {{varName}} template. Never a secret — secrets come interactively. */
    value: z.union([z.string().max(5000), z.number(), z.boolean()]).optional(),
    options: z.array(z.string().max(200)).optional(),
    outputKey: z.string().max(100).optional(),
    /** Destination for export_csv, sandbox-checked at runtime. */
    path: z.string().max(500).optional(),
    risk: z.enum(RISK_TIERS),
    requiresApproval: z.boolean().default(false),
    /** Human-facing summary used in approval dialogs and the timeline. */
    summary: z.string().max(300).optional(),
    timeoutMs: z.number().int().min(100).max(120000).optional(),
  })
  .strict();
export type WorkflowStep = z.infer<typeof StepSchema>;

export const VERIFICATION_KINDS = [
  "url_matches",
  "element_visible",
  "file_exists",
  "table_row_count",
  "text_contains",
] as const;
export type VerificationKind = (typeof VERIFICATION_KINDS)[number];

export const VerificationSchema = z
  .object({
    kind: z.enum(VERIFICATION_KINDS),
    target: z.string().max(2048).optional(),
    expectedText: z.string().max(5000).optional(),
    expectedCount: z.number().int().min(0).optional(),
  })
  .strict();
export type WorkflowVerification = z.infer<typeof VerificationSchema>;

export const WorkflowSchema = z
  .object({
    schemaVersion: z.literal("0.1"),
    id: z.string().regex(/^[a-zA-Z0-9_-]{3,100}$/),
    name: z.string().min(3).max(120),
    description: z.string().max(1000).optional(),
    /** Hostnames the workflow may navigate to. Enforced by the executor, not by the JSON. */
    allowedDomains: z.array(z.string().min(1).max(255)).min(1),
    inputs: z.array(WorkflowInputSchema).default([]),
    steps: z.array(StepSchema).min(1).max(100),
    verification: z.array(VerificationSchema).min(1).max(100),
    // Policy fields (not in the illustrative JSON Schema, but required by the executor):
    /** Highest risk tier allowed without per-run approval when requiresApproval is false. */
    policy: z
      .object({
        autoApproveRead: z.boolean().default(true),
        autoApproveLocalWrite: z.boolean().default(true),
      })
      .strict()
      .default({ autoApproveRead: true, autoApproveLocalWrite: true }),
  })
  .strict();
export type Workflow = z.infer<typeof WorkflowSchema>;

/* ------------------------------ Task run model ---------------------------- */

export const TASK_STATES = [
  "queued",
  "planning",
  "running",
  "awaiting_approval",
  "paused",
  "recovering",
  "verifying",
  "completed",
  "failed",
  "cancelled",
] as const;
export type TaskState = (typeof TASK_STATES)[number];

export const STEP_STATES = ["pending", "running", "awaiting_approval", "passed", "failed", "skipped", "cancelled"] as const;
export type StepState = (typeof STEP_STATES)[number];

export interface StepRun {
  stepId: string;
  action: StepAction;
  summary?: string;
  state: StepState;
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  /** Sanitized arguments — secrets never enter here. */
  args?: Record<string, unknown>;
  error?: string;
  evidence?: Record<string, unknown>;
  attempt: number;
}

export interface TaskRun {
  id: string;
  workflowId: string;
  workflowName: string;
  state: TaskState;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
  /** Set when the run was started automatically by a schedule. */
  scheduleId?: string;
  /** Redacted input values; secret inputs render as REDACTED_SECRET. */
  inputs: Record<string, string | number | boolean>;
  /** Sanitized run outputs (row counts, export paths). */
  outputs: Record<string, unknown>;
  steps: StepRun[];
  verifications: Array<{ kind: VerificationKind; passed: boolean; detail: string; at: string }>;
  error?: string;
  usage: { inputTokens: number; outputTokens: number; requests: number };
  lastCheckpointStepId?: string;
}

/* --------------------------------- Events --------------------------------- */

export interface TaskEvent {
  event:
    | "task.started"
    | "task.completed"
    | "task.failed"
    | "task.cancelled"
    | "task.paused"
    | "task.resumed"
    | "step.started"
    | "step.verified"
    | "step.failed"
    | "approval.requested"
    | "approval.resolved"
    | "verification.passed"
    | "verification.failed"
    | "usage.reported"
    | "browser.install.started"
    | "browser.install.progress"
    | "browser.install.done"
    | "browser.install.failed"
    | "log";
  taskId: string;
  at: string;
  stepId?: string;
  data?: Record<string, unknown>;
}

/* ------------------------------ Approval model ---------------------------- */

export interface Approval {
  id: string;
  taskId: string;
  stepId: string;
  /** Exact action fingerprint the user consented to — mutations invalidate it. */
  fingerprint: string;
  risk: RiskTier;
  title: string;
  detail: Record<string, unknown>;
  state: "pending" | "approved" | "rejected";
  requestedAt: string;
  resolvedAt?: string;
  expiresAt: string;
}

/* ------------------------------- Usage events ----------------------------- */

export interface UsageEvent {
  provider: string;
  model: string;
  taskId?: string;
  requestId?: string;
  inputTokens?: number;
  outputTokens?: number;
  cachedTokens?: number;
  latencyMs?: number;
  at: string;
}

/* -------------------------------- Schedules ------------------------------- */

/** Recurring-task spec (runs only while the app is running — documented limit). */
export const ScheduleSpecSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("interval"), everyMinutes: z.number().int().min(1).max(525_600) }).strict(),
  z.object({ kind: z.literal("daily"), atHHMM: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/) }).strict(),
]);
export type ScheduleSpec = z.infer<typeof ScheduleSpecSchema>;

export interface ScheduleRecord {
  id: string;
  workflowId: string;
  spec: ScheduleSpec;
  inputs: Record<string, string | number | boolean>;
  enabled: boolean;
  createdAt: string;
  lastRunAt?: string;
  nextRunAt: string;
}

/** Computes the next due time strictly after `from` for a schedule spec. */
export function nextDue(spec: ScheduleSpec, from: Date): Date {
  if (spec.kind === "interval") {
    return new Date(from.getTime() + spec.everyMinutes * 60_000);
  }
  const [hh, mm] = spec.atHHMM.split(":").map(Number) as [number, number];
  const next = new Date(from);
  next.setHours(hh, mm, 0, 0);
  if (next.getTime() <= from.getTime()) next.setDate(next.getDate() + 1);
  return next;
}

/* ------------------------------ Tool contracts ---------------------------- */
/**
 * The complete allowlist of browser tools the agent can execute.
 * Anything outside this registry is rejected by code, never attempted.
 */
export const BROWSER_TOOLS = [
  "navigate",
  "get_snapshot",
  "find_element",
  "click",
  "fill",
  "select",
  "wait_for",
  "extract_table",
  "download",
  "capture_screenshot",
  "verify_assertion",
  "export_csv",
] as const;
export type BrowserTool = (typeof BROWSER_TOOLS)[number];

/** Workflow variable template: {{name}} */
export const VAR_PATTERN = /\{\{\s*([A-Za-z][A-Za-z0-9_]*)\s*\}\}/g;
export const REDACTED_SECRET = "REDACTED_SECRET";
