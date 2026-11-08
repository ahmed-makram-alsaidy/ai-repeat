/**
 * AI Repeat — local SQLite storage (node:sqlite, zero native deps).
 * Holds workflows, task runs, events, approvals and usage rows.
 * No secrets, cookies, or sensitive form values are ever written here.
 */
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";
import type { Approval, ScheduleRecord, StepRun, TaskEvent, TaskRun, TaskState } from "@ai-repeat/contracts";
import { redactValue } from "@ai-repeat/security";

interface Migrator {
  version: number;
  up: (db: DatabaseSync) => void;
}

const MIGRATIONS: Migrator[] = [
  {
    version: 1,
    up: (db) => {
      db.exec(`
        CREATE TABLE workflows (
          id TEXT PRIMARY KEY,
          version INTEGER NOT NULL DEFAULT 1,
          json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE tasks (
          id TEXT PRIMARY KEY,
          workflow_id TEXT NOT NULL,
          workflow_name TEXT NOT NULL,
          state TEXT NOT NULL,
          inputs_json TEXT NOT NULL,
          steps_json TEXT NOT NULL,
          verifications_json TEXT NOT NULL,
          outputs_json TEXT NOT NULL,
          error TEXT,
          usage_json TEXT NOT NULL,
          last_checkpoint_step_id TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          started_at TEXT,
          finished_at TEXT
        );
        CREATE INDEX idx_tasks_state ON tasks(state);
        CREATE TABLE events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          task_id TEXT NOT NULL,
          event TEXT NOT NULL,
          step_id TEXT,
          at TEXT NOT NULL,
          data_json TEXT NOT NULL
        );
        CREATE INDEX idx_events_task ON events(task_id, id);
        CREATE TABLE approvals (
          id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL,
          step_id TEXT NOT NULL,
          fingerprint TEXT NOT NULL,
          risk TEXT NOT NULL,
          title TEXT NOT NULL,
          detail_json TEXT NOT NULL,
          state TEXT NOT NULL,
          requested_at TEXT NOT NULL,
          resolved_at TEXT,
          expires_at TEXT NOT NULL
        );
        CREATE TABLE usage (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          provider TEXT NOT NULL,
          model TEXT NOT NULL,
          task_id TEXT,
          request_id TEXT,
          input_tokens INTEGER,
          output_tokens INTEGER,
          cached_tokens INTEGER,
          latency_ms INTEGER,
          at TEXT NOT NULL
        );
      `);
    },
  },
  {
    version: 2,
    up: (db) => {
      db.exec(`
        CREATE TABLE schedules (
          id TEXT PRIMARY KEY,
          workflow_id TEXT NOT NULL,
          spec_json TEXT NOT NULL,
          inputs_json TEXT NOT NULL,
          enabled INTEGER NOT NULL DEFAULT 1,
          created_at TEXT NOT NULL,
          last_run_at TEXT,
          next_run_at TEXT NOT NULL
        );
        CREATE INDEX idx_schedules_due ON schedules(enabled, next_run_at);
      `);
    },
  },
  {
    version: 3,
    up: (db) => {
      db.exec(`
        CREATE TABLE workflow_versions (
          workflow_id TEXT NOT NULL,
          version INTEGER NOT NULL,
          json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          PRIMARY KEY (workflow_id, version)
        );
      `);
    },
  },
];

export class Store {
  private db: DatabaseSync;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.db = new DatabaseSync(path.join(dataDir, "ai-repeat.sqlite"));
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    this.db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
    const applied = new Set(
      (this.db.prepare("SELECT version FROM schema_migrations").all() as Array<{ version: number }>).map((r) => r.version),
    );
    for (const m of MIGRATIONS) {
      if (applied.has(m.version)) continue;
      m.up(this.db);
      this.db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(m.version, new Date().toISOString());
    }
  }

  /* ------------------------------ workflows ------------------------------ */

  upsertWorkflow(wf: { id: string; json: string }): void {
    const now = new Date().toISOString();
    const existing = this.db.prepare("SELECT id FROM workflows WHERE id = ?").get(wf.id);
    if (existing) {
      this.db.prepare("UPDATE workflows SET json = ?, updated_at = ?, version = version + 1 WHERE id = ?").run(wf.json, now, wf.id);
    } else {
      this.db.prepare("INSERT INTO workflows (id, version, json, created_at, updated_at) VALUES (?, 1, ?, ?, ?)").run(
        wf.id,
        wf.json,
        now,
        now,
      );
    }
    // Keep every saved version for audit + rollback (FR-03 versioned workflows).
    const version = (
      this.db.prepare("SELECT version FROM workflows WHERE id = ?").get(wf.id) as { version: number }
    ).version;
    this.db
      .prepare(
        "INSERT OR REPLACE INTO workflow_versions (workflow_id, version, json, created_at) VALUES (?, ?, ?, ?)",
      )
      .run(wf.id, version, wf.json, now);
  }

  listWorkflowVersions(id: string): Array<{ version: number; json: string; createdAt: string }> {
    const rows = this.db
      .prepare("SELECT version, json, created_at FROM workflow_versions WHERE workflow_id = ? ORDER BY version DESC")
      .all(id) as Array<{ version: number; json: string; created_at: string }>;
    return rows.map((r) => ({ version: r.version, json: r.json, createdAt: r.created_at }));
  }

  getWorkflowVersion(id: string, version: number): string | undefined {
    const row = this.db
      .prepare("SELECT json FROM workflow_versions WHERE workflow_id = ? AND version = ?")
      .get(id, version) as { json: string } | undefined;
    return row?.json;
  }

  listWorkflows(): Array<{ id: string; version: number; workflow: unknown; updatedAt: string }> {
    const rows = this.db.prepare("SELECT id, version, json, updated_at FROM workflows ORDER BY updated_at DESC").all() as Array<{
      id: string;
      version: number;
      json: string;
      updated_at: string;
    }>;
    return rows.map((r) => ({ id: r.id, version: r.version, workflow: JSON.parse(r.json), updatedAt: r.updated_at }));
  }

  getWorkflow(id: string): unknown | undefined {
    const row = this.db.prepare("SELECT json FROM workflows WHERE id = ?").get(id) as { json: string } | undefined;
    return row ? JSON.parse(row.json) : undefined;
  }

  /* -------------------------------- tasks -------------------------------- */

  upsertTask(t: TaskRun): void {
    const row = {
      id: t.id,
      workflow_id: t.workflowId,
      workflow_name: t.workflowName,
      state: t.state,
      inputs_json: JSON.stringify(redactValue(t.inputs)),
      steps_json: JSON.stringify(t.steps),
      verifications_json: JSON.stringify(t.verifications),
      outputs_json: JSON.stringify(redactValue(t.outputs ?? {})),
      error: t.error ?? null,
      usage_json: JSON.stringify(t.usage),
      last_checkpoint_step_id: t.lastCheckpointStepId ?? null,
      created_at: t.createdAt,
      updated_at: t.updatedAt,
      started_at: t.startedAt ?? null,
      finished_at: t.finishedAt ?? null,
    };
    this.db
      .prepare(
        `INSERT INTO tasks (id, workflow_id, workflow_name, state, inputs_json, steps_json, verifications_json, outputs_json, error, usage_json, last_checkpoint_step_id, created_at, updated_at, started_at, finished_at)
         VALUES (@id, @workflow_id, @workflow_name, @state, @inputs_json, @steps_json, @verifications_json, @outputs_json, @error, @usage_json, @last_checkpoint_step_id, @created_at, @updated_at, @started_at, @finished_at)
         ON CONFLICT(id) DO UPDATE SET
           state=@state, steps_json=@steps_json, verifications_json=@verifications_json, outputs_json=@outputs_json,
           error=@error, usage_json=@usage_json, last_checkpoint_step_id=@last_checkpoint_step_id,
           updated_at=@updated_at, started_at=@started_at, finished_at=@finished_at`,
      )
      .run(row);
  }

  getTask(id: string): TaskRun | undefined {
    const row = this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as Record<string, string> | undefined;
    if (!row) return undefined;
    return this.rowToTask(row);
  }

  /** Full export for backups — no limit (listTasks caps the UI at 200). */
  listAllTasks(): TaskRun[] {
    const rows = this.db.prepare("SELECT * FROM tasks ORDER BY created_at DESC").all() as Array<Record<string, string>>;
    return rows.map((r) => this.rowToTask(r));
  }

  listTasks(): TaskRun[] {
    const rows = this.db.prepare("SELECT * FROM tasks ORDER BY created_at DESC LIMIT 200").all() as Array<Record<string, string>>;
    return rows.map((r) => this.rowToTask(r));
  }

  /**
   * Tasks left mid-flight from a previous session can never resume their
   * in-memory browser state; mark them honestly. PAUSED tasks are kept —
   * they stopped at a verified checkpoint and can resume after restart.
   */
  failStaleRunningTasks(reason: string): string[] {
    const rows = this.db
      .prepare("SELECT id FROM tasks WHERE state IN ('running','awaiting_approval','queued','planning','recovering')")
      .all() as Array<{ id: string }>;
    const ids: string[] = [];
    for (const r of rows) {
      const t = this.getTask(r.id);
      if (!t) continue;
      t.state = "failed";
      t.error = reason;
      t.finishedAt = new Date().toISOString();
      t.updatedAt = t.finishedAt;
      this.upsertTask(t);
      ids.push(t.id);
    }
    return ids;
  }

  /** Paused tasks that survived a restart (resumable from their checkpoint). */
  listResumablePausedTasks(): TaskRun[] {
    const rows = this.db.prepare("SELECT id FROM tasks WHERE state = 'paused'").all() as Array<{ id: string }>;
    return rows.map((r) => this.getTask(r.id)!).filter(Boolean);
  }

  private rowToTask(row: Record<string, string>): TaskRun {
    return {
      id: row.id!,
      workflowId: row.workflow_id!,
      workflowName: row.workflow_name!,
      state: row.state as TaskState,
      createdAt: row.created_at!,
      updatedAt: row.updated_at!,
      startedAt: row.started_at ?? undefined,
      finishedAt: row.finished_at ?? undefined,
      inputs: JSON.parse(row.inputs_json ?? "{}") as TaskRun["inputs"],
      steps: JSON.parse(row.steps_json ?? "[]") as StepRun[],
      verifications: JSON.parse(row.verifications_json ?? "[]") as TaskRun["verifications"],
      outputs: JSON.parse(row.outputs_json ?? "{}") as Record<string, unknown>,
      error: row.error ?? undefined,
      usage: JSON.parse(row.usage_json ?? "{}") as TaskRun["usage"],
      lastCheckpointStepId: row.last_checkpoint_step_id ?? undefined,
    };
  }

  /* -------------------------------- events ------------------------------- */

  appendEvent(ev: TaskEvent): void {
    this.db
      .prepare("INSERT INTO events (task_id, event, step_id, at, data_json) VALUES (?, ?, ?, ?, ?)")
      .run(ev.taskId, ev.event, ev.stepId ?? null, ev.at, JSON.stringify(redactValue(ev.data ?? {})));
  }

  recentEvents(limit = 300): TaskEvent[] {
    const rows = this.db.prepare("SELECT * FROM events ORDER BY id DESC LIMIT ?").all(limit) as Array<{
      task_id: string;
      event: string;
      step_id: string | null;
      at: string;
      data_json: string;
    }>;
    return rows
      .reverse()
      .map((r) => ({ event: r.event, taskId: r.task_id, stepId: r.step_id ?? undefined, at: r.at, data: JSON.parse(r.data_json) }) as TaskEvent);
  }

  /* ------------------------------ approvals ------------------------------ */

  upsertApproval(a: Approval): void {
    this.db
      .prepare(
        `INSERT INTO approvals (id, task_id, step_id, fingerprint, risk, title, detail_json, state, requested_at, resolved_at, expires_at)
         VALUES (@id, @task_id, @step_id, @fingerprint, @risk, @title, @detail_json, @state, @requested_at, @resolved_at, @expires_at)
         ON CONFLICT(id) DO UPDATE SET state=@state, resolved_at=@resolved_at`,
      )
      .run({
        id: a.id,
        task_id: a.taskId,
        step_id: a.stepId,
        fingerprint: a.fingerprint,
        risk: a.risk,
        title: a.title,
        detail_json: JSON.stringify(redactValue(a.detail)),
        state: a.state,
        requested_at: a.requestedAt,
        resolved_at: a.resolvedAt ?? null,
        expires_at: a.expiresAt,
      });
  }

  getApproval(id: string): Approval | undefined {
    const row = this.db.prepare("SELECT * FROM approvals WHERE id = ?").get(id) as Record<string, string> | undefined;
    if (!row) return undefined;
    return {
      id: row.id!,
      taskId: row.task_id!,
      stepId: row.step_id!,
      fingerprint: row.fingerprint!,
      risk: row.risk as Approval["risk"],
      title: row.title!,
      detail: JSON.parse(row.detail_json ?? "{}"),
      state: row.state as Approval["state"],
      requestedAt: row.requested_at!,
      resolvedAt: row.resolved_at ?? undefined,
      expiresAt: row.expires_at!,
    };
  }

  listApprovals(taskId?: string): Approval[] {
    const rows = taskId
      ? (this.db.prepare("SELECT id FROM approvals WHERE task_id = ? ORDER BY requested_at").all(taskId) as Array<{ id: string }>)
      : (this.db.prepare("SELECT id FROM approvals ORDER BY requested_at DESC LIMIT 100").all() as Array<{ id: string }>);
    return rows.map((r) => this.getApproval(r.id)!).filter(Boolean);
  }

  /* -------------------------------- usage -------------------------------- */

  appendUsage(u: {
    provider: string;
    model: string;
    taskId?: string;
    requestId?: string;
    inputTokens?: number;
    outputTokens?: number;
    cachedTokens?: number;
    latencyMs?: number;
    at: string;
  }): void {
    this.db
      .prepare(
        "INSERT INTO usage (provider, model, task_id, request_id, input_tokens, output_tokens, cached_tokens, latency_ms, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(u.provider, u.model, u.taskId ?? null, u.requestId ?? null, u.inputTokens ?? null, u.outputTokens ?? null, u.cachedTokens ?? null, u.latencyMs ?? null, u.at);
  }

  usageSummary(): { requests: number; inputTokens: number; outputTokens: number } {
    const row = this.db
      .prepare("SELECT COUNT(*) AS requests, COALESCE(SUM(input_tokens),0) AS inputTokens, COALESCE(SUM(output_tokens),0) AS outputTokens FROM usage")
      .get() as { requests: number; inputTokens: number; outputTokens: number };
    return row;
  }

  /**
   * Retention policy: physically deletes event-log rows older than the window
   * (all event types — the سجل is history, not an audit chain). Task records,
   * workflows and schedules are NOT touched by retention.
   */
  applyRetention(days: number): number {
    const cutoff = new Date(Date.now() - days * 24 * 3600_000).toISOString();
    const res = this.db.prepare("DELETE FROM events WHERE at < ?").run(cutoff);
    return Number(res.changes);
  }

  /** FR-07 delete-history: clears the whole execution log (tasks stay). */
  clearHistory(): number {
    const res = this.db.prepare("DELETE FROM events").run();
    return Number(res.changes);
  }

  /** Auto-delete completed tasks older than retention window (archived/failed stay for debugging). */
  pruneOldCompletedTasks(days: number): number {
    const cutoff = new Date(Date.now() - days * 24 * 3600_000).toISOString();
    const res = this.db
      .prepare("DELETE FROM tasks WHERE state = 'completed' AND finished_at < ?")
      .run(cutoff);
    return Number(res.changes);
  }

  historyCount(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM events").get() as { n: number };
    return row.n;
  }

  /* ------------------------------ schedules ------------------------------- */

  upsertSchedule(s: ScheduleRecord): void {
    this.db
      .prepare(
        `INSERT INTO schedules (id, workflow_id, spec_json, inputs_json, enabled, created_at, last_run_at, next_run_at)
         VALUES (@id, @workflow_id, @spec_json, @inputs_json, @enabled, @created_at, @last_run_at, @next_run_at)
         ON CONFLICT(id) DO UPDATE SET spec_json=@spec_json, inputs_json=@inputs_json, enabled=@enabled, last_run_at=@last_run_at, next_run_at=@next_run_at`,
      )
      .run({
        id: s.id,
        workflow_id: s.workflowId,
        spec_json: JSON.stringify(s.spec),
        inputs_json: JSON.stringify(redactValue(s.inputs)),
        enabled: s.enabled ? 1 : 0,
        created_at: s.createdAt,
        last_run_at: s.lastRunAt ?? null,
        next_run_at: s.nextRunAt,
      });
  }

  listSchedules(): ScheduleRecord[] {
    const rows = this.db.prepare("SELECT * FROM schedules ORDER BY next_run_at").all() as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: String(r.id),
      workflowId: String(r.workflow_id),
      spec: JSON.parse(String(r.spec_json)),
      inputs: JSON.parse(String(r.inputs_json ?? "{}")),
      enabled: Number(r.enabled) === 1,
      createdAt: String(r.created_at),
      lastRunAt: r.last_run_at ? String(r.last_run_at) : undefined,
      nextRunAt: String(r.next_run_at),
    }));
  }

  getSchedule(id: string): ScheduleRecord | undefined {
    return this.listSchedules().find((s) => s.id === id);
  }

  deleteSchedule(id: string): boolean {
    const res = this.db.prepare("DELETE FROM schedules WHERE id = ?").run(id);
    return Number(res.changes) > 0;
  }

  dueSchedules(nowISO: string): ScheduleRecord[] {
    return this.listSchedules().filter((s) => s.enabled && s.nextRunAt <= nowISO);
  }

  /**
   * Pilot KPIs (docs/spec/docs/07) computed from REAL local data only —
   * "—" semantics are handled by the caller when a denominator is zero.
   * verified_success_rate excludes user-cancelled runs per the spec.
   */
  kpis(): {
    completedRuns: number;
    verifiedSuccessRate: number | null;
    avgRunSeconds: number | null;
    approvalsPerRun: number | null;
    tokensPerVerifiedRun: number | null;
    cancelledRuns: number;
  } {
    const tasks = this.listTasks();
    const completed = tasks.filter((t) => t.state === "completed");
    const cancelled = tasks.filter((t) => t.state === "cancelled").length;
    const verified = completed.filter((t) => t.verifications.length > 0 && t.verifications.every((v) => v.passed));
    const durations = completed
      .filter((t) => t.startedAt && t.finishedAt)
      .map((t) => (new Date(t.finishedAt!).getTime() - new Date(t.startedAt!).getTime()) / 1000);
    const approvals = this.listApprovals().filter((a) => a.state !== "pending").length;
    const attempted = completed.length + tasks.filter((t) => t.state === "failed").length;
    const withUsage = tasks.filter((t) => (t.usage?.inputTokens ?? 0) + (t.usage?.outputTokens ?? 0) > 0);
    const tokensWithUsage = withUsage.reduce((sum, t) => sum + (t.usage.inputTokens ?? 0) + (t.usage.outputTokens ?? 0), 0);
    const verifiedWithUsage = verified.filter((t) => (t.usage?.inputTokens ?? 0) + (t.usage?.outputTokens ?? 0) > 0);
    return {
      completedRuns: completed.length,
      verifiedSuccessRate: completed.length > 0 ? verified.length / completed.length : null,
      avgRunSeconds: durations.length > 0 ? durations.reduce((a, b) => a + b, 0) / durations.length : null,
      approvalsPerRun: attempted > 0 ? approvals / attempted : null,
      tokensPerVerifiedRun: verifiedWithUsage.length > 0 ? tokensWithUsage / verifiedWithUsage.length : null,
      cancelledRuns: cancelled,
    };
  }
}
