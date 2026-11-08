import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Store } from "../services/agent/src/store.js";
import { SecretVault } from "../services/agent/src/vault.js";
import type { TaskRun } from "@ai-repeat/contracts";

function makeTask(id: string, state: TaskRun["state"] = "queued"): TaskRun {
  const now = new Date().toISOString();
  return {
    id,
    workflowId: "wf_x",
    workflowName: "مهمة",
    state,
    createdAt: now,
    updatedAt: now,
    inputs: { customer: "شركة النور", password: "REDACTED_SECRET" },
    outputs: {},
    steps: [{ stepId: "s1", action: "navigate", state: "passed", attempt: 1 }],
    verifications: [],
    usage: { inputTokens: 0, outputTokens: 0, requests: 0 },
  };
}

describe("Store (SQLite migrations + task persistence)", () => {
  it("applies migrations idempotently and persists tasks", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "ai-repeat-store-"));
    const store1 = new Store(dir);
    store1.upsertWorkflow({ id: "wf_x", json: JSON.stringify({ id: "wf_x", name: "x" }) });
    const t = makeTask("run_1");
    store1.upsertTask(t);
    t.state = "completed";
    t.finishedAt = new Date().toISOString();
    store1.upsertTask(t);

    // Reopening the same DB reuses the schema (no crash, data intact).
    const store2 = new Store(dir);
    const loaded = store2.getTask("run_1");
    expect(loaded?.state).toBe("completed");
    expect(loaded?.inputs.customer).toBe("شركة النور");
    expect(loaded?.steps[0]?.state).toBe("passed");
    expect(store2.listWorkflows()).toHaveLength(1);
  });

  it("redacts secret-looking input keys before persisting", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "ai-repeat-store-"));
    const store = new Store(dir);
    const t = makeTask("run_2");
    t.inputs = { customer: "x", apiToken: "super-secret-value" };
    store.upsertTask(t);
    const loaded = store.getTask("run_2")!;
    expect(loaded.inputs.apiToken).toBe("REDACTED_SECRET");
    expect(loaded.inputs.customer).toBe("x");
  });

  it("failStaleRunningTasks marks interrupted runs failed; paused tasks survive restarts", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "ai-repeat-store-"));
    const store = new Store(dir);
    store.upsertTask(makeTask("run_a", "running"));
    store.upsertTask(makeTask("run_b", "awaiting_approval"));
    store.upsertTask(makeTask("run_c", "completed"));
    store.upsertTask(makeTask("run_d", "paused"));
    const ids = store.failStaleRunningTasks("reason");
    expect(ids.sort()).toEqual(["run_a", "run_b"]);
    expect(store.getTask("run_a")?.state).toBe("failed");
    expect(store.getTask("run_c")?.state).toBe("completed");
    // Paused = stopped at a verified checkpoint → resumable after restart.
    expect(store.getTask("run_d")?.state).toBe("paused");
    expect(store.listResumablePausedTasks().map((t) => t.id)).toEqual(["run_d"]);
  });

  it("events and usage round-trip", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "ai-repeat-store-"));
    const store = new Store(dir);
    store.appendEvent({ event: "task.started", taskId: "run_1", at: new Date().toISOString() });
    store.appendEvent({ event: "step.started", taskId: "run_1", stepId: "s1", at: new Date().toISOString(), data: { password: "leak" } });
    const events = store.recentEvents(10);
    expect(events).toHaveLength(2);
    expect(JSON.stringify(events[1]?.data)).not.toContain("leak");
    store.appendUsage({ provider: "zai", model: "glm-5.3-flash", inputTokens: 10, outputTokens: 5, at: new Date().toISOString() });
    expect(store.usageSummary().inputTokens).toBe(10);
  });
});

describe("SecretVault", () => {
  it("stores and returns a secret without leaking it into the file", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "ai-repeat-vault-"));
    const vault = new SecretVault(dir);
    vault.setSecret("zai-default", "sk-test-123456789");
    expect(vault.getSecret("zai-default")).toBe("sk-test-123456789");
    const raw = readFileSync(path.join(dir, "secret-zai-default.bin"), "utf8");
    expect(raw).not.toContain("sk-test-123456789");
    expect(vault.deleteSecret("zai-default")).toBe(true);
    expect(vault.getSecret("zai-default")).toBeUndefined();
  });

  it("returns undefined for empty/unknown refs instead of crashing", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "ai-repeat-vault-"));
    const vault = new SecretVault(dir);
    expect(vault.getSecret("")).toBeUndefined();
    expect(vault.getSecret("nope")).toBeUndefined();
    expect(vault.getSecret("../escape")).toBeUndefined();
  });
});
