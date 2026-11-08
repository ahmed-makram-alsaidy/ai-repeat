/**
 * AI Repeat — recurring-task scheduler (runs only while the app is running;
 * the app cannot execute anything on a switched-off PC — documented limit).
 *
 * Every 20s it checks due schedules and queues tasks through the normal
 * TaskManager — approvals, allowlists and verification apply exactly the
 * same way as manually started runs.
 */
import { randomUUID } from "node:crypto";
import { nextDue, type ScheduleRecord, type ScheduleSpec, type TaskEvent } from "@ai-repeat/contracts";
import type { Store } from "./store.js";

export interface CreateTaskFn {
  (workflowId: string, inputs: Record<string, string | number | boolean>, scheduleId: string): { id: string } | undefined;
}

export class Scheduler {
  private timer: NodeJS.Timeout | undefined;
  private ticking = false;

  constructor(
    private readonly store: Store,
    private readonly createTask: CreateTaskFn,
    private readonly emit: (ev: TaskEvent) => void,
    private readonly tickIntervalMs = 20_000,
  ) {}

  start(): void {
    this.stop();
    this.timer = setInterval(() => void this.processDue(), this.tickIntervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Creates the schedule with its first due time. */
  create(workflowId: string, spec: ScheduleSpec, inputs: Record<string, string | number | boolean>): ScheduleRecord {
    const now = new Date();
    const rec: ScheduleRecord = {
      id: `sch_${randomUUID().slice(0, 10)}`,
      workflowId,
      spec,
      inputs,
      enabled: true,
      createdAt: now.toISOString(),
      nextRunAt: nextDue(spec, now).toISOString(),
    };
    this.store.upsertSchedule(rec);
    return rec;
  }

  async processDue(now = new Date()): Promise<number> {
    if (this.ticking) return 0;
    this.ticking = true;
    try {
      const due = this.store.dueSchedules(now.toISOString());
      let fired = 0;
      for (const sch of due) {
        const workflow = this.store.getWorkflow(sch.workflowId);
        if (!workflow) {
          // The skill was deleted — disable the schedule honestly instead of failing forever.
          this.store.upsertSchedule({ ...sch, enabled: false });
          this.emit({
            event: "log",
            taskId: `schedule_${sch.id}`,
            at: new Date().toISOString(),
            data: { message: `الجدولة اتوقفت: المهارة ${sch.workflowId} مش موجودة` },
          });
          continue;
        }
        // Avoid pile-up: skip if this workflow already has a queued/running task.
        const busy = this.store.listTasks().some((t) => t.workflowId === sch.workflowId && ["queued", "running", "awaiting_approval"].includes(t.state));
        const nowISO = new Date().toISOString();
        if (busy) {
          this.store.upsertSchedule({ ...sch, lastRunAt: sch.lastRunAt, nextRunAt: new Date(Date.now() + 60_000).toISOString() });
          continue;
        }
        try {
          const task = this.createTask(sch.workflowId, sch.inputs, sch.id);
          fired++;
          this.emit({
            event: "log",
            taskId: task?.id ?? `schedule_${sch.id}`,
            at: nowISO,
            data: { message: `جدولة: تشغيل تلقائي للمهارة ${sch.workflowId}`, scheduleId: sch.id },
          });
        } catch (err) {
          // Missing required inputs etc. — disable with a clear note instead of looping failures.
          this.store.upsertSchedule({ ...sch, enabled: false });
          this.emit({
            event: "log",
            taskId: `schedule_${sch.id}`,
            at: nowISO,
            data: { message: `الجدولة اتوقفت بسبب خطأ: ${err instanceof Error ? err.message : String(err)}` },
          });
          continue;
        }
        this.store.upsertSchedule({
          ...sch,
          lastRunAt: nowISO,
          nextRunAt: nextDue(sch.spec, now).toISOString(),
        });
      }
      return fired;
    } finally {
      this.ticking = false;
    }
  }
}
