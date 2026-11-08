import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { nextDue, type ScheduleRecord, type ScheduleSpec } from "@ai-repeat/contracts";
import { Store } from "../services/agent/src/store.js";
import { Scheduler } from "../services/agent/src/scheduler.js";

describe("nextDue", () => {
  it("interval: adds everyMinutes to the anchor", () => {
    const from = new Date("2026-11-08T10:00:00Z");
    expect(nextDue({ kind: "interval", everyMinutes: 90 }, from).toISOString()).toBe("2026-11-08T11:30:00.000Z");
  });

  it("daily: returns today's slot when still ahead of it", () => {
    const from = new Date("2026-11-08T07:30:00"); // local time
    const next = nextDue({ kind: "daily", atHHMM: "09:00" }, from);
    expect(next.getHours()).toBe(9);
    expect(next.getMinutes()).toBe(0);
    expect(next.getDate()).toBe(from.getDate());
  });

  it("daily: rolls to tomorrow when the slot already passed", () => {
    const from = new Date("2026-11-08T10:30:00");
    const next = nextDue({ kind: "daily", atHHMM: "09:00" }, from);
    expect(next.getDate()).toBe(from.getDate() + 1);
    expect(next.getHours()).toBe(9);
  });
});

describe("Scheduler", () => {
  it("fires due schedules through createTask, advances next_run_at, disables on missing workflow", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "ai-repeat-sched-"));
    const store = new Store(dir);
    store.upsertWorkflow({ id: "sched_wf", json: JSON.stringify({ id: "sched_wf", name: "x" }) });

    const created: Array<{ wf: string; scheduleId?: string }> = [];
    const scheduler = new Scheduler(store, (wfId, _inputs, scheduleId) => {
      created.push({ wf: wfId, scheduleId });
      return { id: "run_x" };
    }, () => {});

    const now = new Date();
    const rec: ScheduleRecord = {
      id: "sch_due",
      workflowId: "sched_wf",
      spec: { kind: "interval", everyMinutes: 60 } as ScheduleSpec,
      inputs: { customer: "عميل مجدول" },
      enabled: true,
      createdAt: now.toISOString(),
      nextRunAt: new Date(now.getTime() - 1000).toISOString(), // already due
    };
    store.upsertSchedule(rec);

    const fired = await scheduler.processDue(now);
    expect(fired).toBe(1);
    expect(created).toEqual([{ wf: "sched_wf", scheduleId: "sch_due" }]);
    const updated = store.getSchedule("sch_due")!;
    expect(updated.lastRunAt).toBeTruthy();
    expect(updated.nextRunAt > now.toISOString()).toBe(true);

    // Not due anymore — second pass fires nothing.
    expect(await scheduler.processDue(now)).toBe(0);

    // Missing workflow → schedule disabled with an honest note.
    store.upsertSchedule({ ...rec, id: "sch_gone", workflowId: "deleted_wf", nextRunAt: new Date(now.getTime() - 1000).toISOString() });
    await scheduler.processDue(now);
    expect(store.getSchedule("sch_gone")?.enabled).toBe(false);
  });

  it("skips firing when the workflow already has an active task (no pile-up)", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "ai-repeat-sched2-"));
    const store = new Store(dir);
    store.upsertWorkflow({ id: "sched_wf", json: JSON.stringify({ id: "sched_wf", name: "x" }) });
    const now = new Date();

    let createCalls = 0;
    const scheduler = new Scheduler(store, () => {
      createCalls++;
      return { id: "run_x" };
    }, () => {});

    // Simulate an active (running) task for the workflow.
    store.upsertTask({
      id: "run_active",
      workflowId: "sched_wf",
      workflowName: "x",
      state: "running",
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      inputs: {},
      outputs: {},
      steps: [],
      verifications: [],
      usage: { inputTokens: 0, outputTokens: 0, requests: 0 },
    });
    store.upsertSchedule({
      id: "sch_busy",
      workflowId: "sched_wf",
      spec: { kind: "interval", everyMinutes: 60 },
      inputs: {},
      enabled: true,
      createdAt: now.toISOString(),
      nextRunAt: new Date(now.getTime() - 1000).toISOString(),
    });

    await scheduler.processDue(now);
    expect(createCalls).toBe(0);
    // Delayed by a minute instead of piling up.
    expect(store.getSchedule("sch_busy")!.nextRunAt > now.toISOString()).toBe(true);
  });
});
