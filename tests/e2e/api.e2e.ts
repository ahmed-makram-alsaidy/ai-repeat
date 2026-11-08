/**
 * API integration tests: auth, validation, task lifecycle over HTTP,
 * approval fingerprint binding (S05), missing-key diagnostics (S09).
 * Uses the real fixture site + real Chromium for the full loop.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import http from "node:http";
import type { Server } from "node:http";
import { createServer, type ServerDeps } from "../../services/agent/src/server.js";
import { TaskManager } from "../../services/agent/src/runner.js";
import { TeachManager } from "../../services/agent/src/teach.js";
import { Store } from "../../services/agent/src/store.js";
import { SecretVault } from "../../services/agent/src/vault.js";
import { loadSettings } from "../../services/agent/src/config.js";
import { ChromiumInstaller } from "../../services/agent/src/browser-install.js";
import { Scheduler } from "../../services/agent/src/scheduler.js";
import { MockProvider } from "@ai-repeat/llm";
import { resolveChromiumExecutable } from "@ai-repeat/workflows";
import { createFixtureServer } from "../../fixtures/demo-site/server.js";

const exe = resolveChromiumExecutable();
const hasBrowser = exe !== null;

let httpServer: Server;
let baseUrl: string;
let token: string;
let fixture: ReturnType<typeof createFixtureServer>;
let fixturePort = 0;
let deps: ServerDeps;

beforeAll(async () => {
  fixture = createFixtureServer();
  await new Promise<void>((r) => fixture.listen(0, "127.0.0.1", r));
  const faddr = fixture.address();
  if (typeof faddr !== "object" || !faddr) throw new Error("fixture failed to bind");
  fixturePort = faddr.port;

  const dataDir = mkdtempSync(path.join(tmpdir(), "ai-repeat-api-"));
  const settings = loadSettings(dataDir);
  const store = new Store(dataDir);
  const vault = new SecretVault(dataDir);
  const tasks = new TaskManager(store, settings, () => new MockProvider());
  const teach = new TeachManager(settings);
  const installer = new ChromiumInstaller();
  const scheduler = new Scheduler(store, (wfId, inputs, scheduleId) => {
    const wf = store.getWorkflow(wfId) as never;
    return tasks.createTask(wf, inputs, scheduleId);
  }, () => {});
  deps = { store, tasks, settings, vault, teach, installer, scheduler };
  const { app, token: t } = createServer(deps);
  token = t;
  httpServer = http.createServer(app);
  await new Promise<void>((r) => httpServer.listen(0, "127.0.0.1", r));
  const addr = httpServer.address();
  if (typeof addr === "object" && addr) baseUrl = `http://127.0.0.1:${addr.port}`;

  // Seed the demo workflows, retargeting their fixture URLs to this test's random port.
  for (const id of ["demo_missing_images", "demo_draft_transfer"]) {
    const wfJson = JSON.parse(readFileSync(new URL(`../fixtures/workflows/${id}.json`, import.meta.url), "utf8")) as {
      steps: Array<{ action: string; url?: string }>;
    };
    for (const step of wfJson.steps) {
      if (step.action === "navigate" && step.url) {
        step.url = step.url.replace("http://127.0.0.1:4177", `http://127.0.0.1:${fixturePort}`);
      }
    }
    store.upsertWorkflow({ id, json: JSON.stringify(wfJson) });
  }
});

afterAll(async () => {
  await new Promise<void>((r) => httpServer.close(() => r()));
  await new Promise<void>((r) => fixture.close(() => r()));
});

function call(method: string, path: string, body?: unknown, useToken = true): Promise<{ status: number; json: any }> {
  return fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(useToken ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).then(async (res) => ({ status: res.status, json: await res.json().catch(() => ({})) }));
}

async function waitForTask(id: string, states: string[], timeoutMs = 60_000): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { json } = await call("GET", `/api/tasks/${id}`);
    if (states.includes(json.task?.state)) return json.task;
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${states.join("|")}: ${json.task?.state}`);
    await new Promise((r) => setTimeout(r, 700));
  }
}

describe("API security", () => {
  it("rejects requests without a session token", async () => {
    const r = await call("GET", "/api/bootstrap", undefined, false);
    expect(r.status).toBe(401);
  });

  it("rejects foreign origins", async () => {
    const res = await fetch(`${baseUrl}/api/bootstrap`, {
      headers: { Authorization: `Bearer ${token}`, Origin: "http://evil.example" },
    });
    expect(res.status).toBe(403);
  });

  it("serves bootstrap with token", async () => {
    const r = await call("GET", "/api/bootstrap");
    expect(r.status).toBe(200);
    expect(r.json.settings.model.modelId).toBe("glm-5.3-flash");
    expect(r.json.browserAvailable).toBe(hasBrowser);
  });
});

describe("API model connection (S09)", () => {
  it("reports a clear diagnostic when no key is configured", async () => {
    const r = await call("POST", "/api/model/test");
    expect(r.status).toBe(200);
    expect(r.json.ok).toBe(false);
    expect(String(r.json.error)).toContain("MISSING_API_KEY");
  });

  it("stores a key in the vault and masks it in responses", async () => {
    const set = await call("POST", "/api/model/key", { key: "sk-demo-key-123456" });
    expect(set.json.ok).toBe(true);
    expect(set.json.masked).toBe("sk-…456");
    const status = await call("GET", "/api/model/status");
    expect(status.json.hasKey).toBe(true);
    // Cleanup so other tests see no key.
    await call("DELETE", "/api/model/key");
  });
});

describe("API workflow validation (S04/S12)", () => {
  it("rejects a workflow with a non-allowlisted tool", async () => {
    const r = await call("POST", "/api/workflows", {
      schemaVersion: "0.1",
      id: "bad_wf",
      name: "أداة خطرة",
      allowedDomains: ["127.0.0.1"],
      steps: [{ id: "s", action: "run_shell", risk: "high_impact" }],
      verification: [{ kind: "url_matches", target: "*" }],
    });
    expect(r.status).toBe(400);
    expect(r.json.error).toContain("WORKFLOW_INVALID");
  });

  it("rejects invalid task inputs before queueing", async () => {
    const r = await call("POST", "/api/tasks", { workflowId: "nonexistent_wf" });
    expect(r.status).toBe(404);
  });
});

describe("Workflow export/import roundtrip", () => {
  const wf = {
    schemaVersion: "0.1",
    id: "shareable_wf",
    name: "مهارة قابلة للمشاركة",
    allowedDomains: ["127.0.0.1"],
    steps: [{ id: "a", action: "navigate", url: "http://127.0.0.1/", risk: "read" }],
    verification: [{ kind: "url_matches", target: "http://127.0.0.1/*" }],
  };

  it("exports a saved workflow as attachment JSON", async () => {
    await call("POST", "/api/workflows", wf);
    const res = await fetch(`${baseUrl}/api/workflows/shareable_wf/export`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toContain("shareable_wf.json");
    const body = (await res.json()) as { id: string; steps: unknown[] };
    expect(body.id).toBe("shareable_wf");
    expect(body.steps).toHaveLength(1);
  });

  it("404s on unknown export", async () => {
    const r = await call("GET", "/api/workflows/no_such_wf/export");
    expect(r.status).toBe(404);
  });

  it("import keeps the id when free, renames on collision (never overwrites local)", async () => {
    const fresh = await call("POST", "/api/workflows/import", { ...wf, id: "imported_free" });
    expect(fresh.status).toBe(200);
    expect(fresh.json.id).toBe("imported_free");
    expect(fresh.json.renamed).toBe(false);

    // shareable_wf already exists locally — importing must NOT overwrite it.
    const collided = await call("POST", "/api/workflows/import", { ...wf, id: "shareable_wf", name: "نسخة مستوردة" });
    expect(collided.status).toBe(200);
    expect(collided.json.renamed).toBe(true);
    expect(collided.json.id).toBe("shareable_wf-i1");
    const local = await call("GET", "/api/workflows");
    const stillMine = (local.json.workflows as Array<{ id: string; workflow: { name: string } }>).find(
      (w) => w.id === "shareable_wf",
    );
    expect(stillMine?.workflow.name).toBe("مهارة قابلة للمشاركة");
  });
});

describe.skipIf(!hasBrowser)("API task lifecycle (real Chromium)", () => {
  it("runs G1 over HTTP end-to-end with verifications", async () => {
    const started = await call("POST", "/api/tasks", { workflowId: "demo_missing_images" });
    expect(started.status).toBe(200);
    const id = started.json.task.id;
    const task = await waitForTask(id, ["completed", "failed"]);
    expect(task.state).toBe("completed");
    expect(task.verifications.every((v: { passed: boolean }) => v.passed)).toBe(true);
  });

  it("binds approvals to the exact fingerprint (S05) and completes after consent", async () => {
    const started = await call("POST", "/api/tasks", {
      workflowId: "demo_draft_transfer",
      inputs: { customer: "عميل S05", item: "صنف S05", quantity: "1" },
    });
    const id = started.json.task.id;
    // Wait for the pending approval.
    let approval: any;
    const deadline = Date.now() + 30_000;
    for (;;) {
      const { json } = await call("GET", "/api/approvals/pending");
      approval = json.approvals.find((a: any) => a.taskId === id);
      if (approval || Date.now() > deadline) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    expect(approval).toBeTruthy();
    expect(approval.risk).toBe("external_write");

    // A mutated fingerprint must be rejected.
    const bad = await call("POST", `/api/approvals/${approval.id}/approve`, { fingerprint: "0".repeat(64) });
    expect(bad.status).toBe(409);
    expect(bad.json.error).toContain("FINGERPRINT_MISMATCH");

    // The rejected approval cannot be reused; the task ends failed (no silent submit).
    const task = await waitForTask(id, ["failed"], 20_000);
    expect(task.state).toBe("failed");

    // New run: correct fingerprint passes and completes.
    const started2 = await call("POST", "/api/tasks", {
      workflowId: "demo_draft_transfer",
      inputs: { customer: "عميل S05b", item: "صنف S05b", quantity: "1" },
    });
    const id2 = started2.json.task.id;
    for (;;) {
      const { json } = await call("GET", "/api/approvals/pending");
      const a = json.approvals.find((x: any) => x.taskId === id2);
      if (a) {
        const ok = await call("POST", `/api/approvals/${a.id}/approve`, { fingerprint: a.fingerprint });
        expect(ok.status).toBe(200);
        break;
      }
      if (Date.now() > deadline) throw new Error("no approval appeared");
      await new Promise((r) => setTimeout(r, 500));
    }
    const task2 = await waitForTask(id2, ["completed", "failed"]);
    expect(task2.state).toBe("completed");
  });

  it("cancels a running task over HTTP (D)", async () => {
    // Seed a slow workflow.
    await call("POST", "/api/workflows", {
      schemaVersion: "0.1",
      id: "slow_wf",
      name: "مهمة بطيئة للاختبار",
      allowedDomains: ["127.0.0.1"],
      steps: [
        { id: "a", action: "navigate", url: `http://127.0.0.1:${fixturePort}/`, risk: "read" },
        { id: "b", action: "navigate", url: `http://127.0.0.1:${fixturePort}/slow?ms=15000`, risk: "read" },
      ],
      verification: [{ kind: "url_matches", target: "*" }],
    });
    const started = await call("POST", "/api/tasks", { workflowId: "slow_wf" });
    const id = started.json.task.id;
    await new Promise((r) => setTimeout(r, 2500)); // let it enter the slow navigation
    const cancel = await call("POST", `/api/tasks/${id}/cancel`);
    expect(cancel.status).toBe(200);
    const task = await waitForTask(id, ["cancelled"], 20_000);
    expect(task.state).toBe("cancelled");
  });

  it("retries a failed task as a NEW run with the same inputs", async () => {
    // A workflow that fails deterministically (unapproved domain).
    await call("POST", "/api/workflows", {
      schemaVersion: "0.1",
      id: "failing_wf",
      name: "مهمة تفشل للاختبار",
      allowedDomains: ["127.0.0.1"],
      steps: [{ id: "a", action: "navigate", url: "http://blocked.example/", risk: "read" }],
      verification: [{ kind: "url_matches", target: "*" }],
    });
    const started = await call("POST", "/api/tasks", { workflowId: "failing_wf" });
    const id = started.json.task.id;
    const failed = await waitForTask(id, ["failed"], 20_000);
    expect(failed.state).toBe("failed");

    const retry = await call("POST", `/api/tasks/${id}/retry`);
    expect(retry.status).toBe(200);
    expect(retry.json.task.id).not.toBe(id);
    expect(retry.json.task.workflowId).toBe("failing_wf");

    // Retry of a running/completed task is refused.
    const completed = await call("POST", "/api/tasks", { workflowId: "demo_missing_images" });
    const completedId = completed.json.task.id;
    await waitForTask(completedId, ["completed"], 60_000);
    const badRetry = await call("POST", `/api/tasks/${completedId}/retry`);
    expect(badRetry.status).toBe(409);
    expect(badRetry.json.error).toContain("TASK_NOT_RETRYABLE");
  });

  it("runs two independent tasks concurrently (FR-05, concurrency=2)", async () => {
    const a = await call("POST", "/api/tasks", { workflowId: "demo_missing_images" });
    const b = await call("POST", "/api/tasks", { workflowId: "demo_missing_images" });
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const [ta, tb] = await Promise.all([
      waitForTask(a.json.task.id, ["completed", "failed"], 90_000),
      waitForTask(b.json.task.id, ["completed", "failed"], 90_000),
    ]);
    expect(ta.state).toBe("completed");
    expect(tb.state).toBe("completed");
  });

  it("pauses at a checkpoint, resumes (fresh context), and skips verified steps", async () => {
    await call("POST", "/api/workflows", {
      schemaVersion: "0.1",
      id: "pause_resume_wf",
      name: "مهمة إيقاف واستكمال",
      allowedDomains: ["127.0.0.1"],
      steps: [
        { id: "a", action: "navigate", url: `http://127.0.0.1:${fixturePort}/`, risk: "read" },
        { id: "b", action: "navigate", url: `http://127.0.0.1:${fixturePort}/slow?ms=2500`, risk: "read" },
        { id: "c", action: "navigate", url: `http://127.0.0.1:${fixturePort}/products`, risk: "read" },
      ],
      verification: [{ kind: "url_matches", target: `http://127.0.0.1:${fixturePort}/products` }],
    });
    const started = await call("POST", "/api/tasks", { workflowId: "pause_resume_wf" });
    const id = started.json.task.id;

    // Wait until step a is verified, then pause — the executor stops at the
    // next boundary (during/after the slow navigation), never before a ran.
    const stepADeadline = Date.now() + 30_000;
    for (;;) {
      const { json } = await call("GET", `/api/tasks/${id}`);
      const sa = json.task.steps.find((s: { stepId: string }) => s.stepId === "a");
      if (sa?.state === "passed") break;
      if (Date.now() > stepADeadline) throw new Error(`step a never passed (state=${json.task.state})`);
      await new Promise((r) => setTimeout(r, 300));
    }
    const paused = await call("POST", `/api/tasks/${id}/pause`);
    expect(paused.status).toBe(200);

    let state = "";
    const deadline = Date.now() + 30_000;
    for (;;) {
      const { json } = await call("GET", `/api/tasks/${id}`);
      state = json.task.state;
      if (state === "paused") break;
      if (Date.now() > deadline) throw new Error(`never paused (state=${state})`);
      await new Promise((r) => setTimeout(r, 500));
    }
    // Steps a and b are verified; c never ran (it may not even be registered —
    // the pause boundary fires before the step record is created).
    const pausedTask = (await call("GET", `/api/tasks/${id}`)).json.task;
    expect(pausedTask.steps.find((s: { stepId: string }) => s.stepId === "a")?.state).toBe("passed");
    expect(pausedTask.steps.find((s: { stepId: string }) => s.stepId === "b")?.state).toBe("passed");
    const cState = pausedTask.steps.find((s: { stepId: string }) => s.stepId === "c")?.state;
    expect(cState === undefined || cState === "pending").toBe(true);

    // Resume → queued → fresh context → a/b skipped (checkpoint), c executes.
    const resumed = await call("POST", `/api/tasks/${id}/resume`);
    expect(resumed.status).toBe(200);
    const done = await waitForTask(id, ["completed", "failed"], 45_000);
    expect(done.state).toBe("completed");
    expect(done.verifications.every((v: { passed: boolean }) => v.passed)).toBe(true);
    const attempts = Object.fromEntries(done.steps.map((s: { stepId: string; attempt: number }) => [s.stepId, s.attempt]));
    expect(attempts.a).toBe(1); // not re-executed
    expect(attempts.b).toBe(1); // not re-executed
    expect(attempts.c).toBeGreaterThanOrEqual(1);
  });

  it("global stop-all cancels active AND queued tasks (FR-05)", async () => {
    // Two running (concurrency cap) + one queued behind them.
    const a = await call("POST", "/api/tasks", { workflowId: "slow_wf" });
    const b = await call("POST", "/api/tasks", { workflowId: "slow_wf" });
    const c = await call("POST", "/api/tasks", { workflowId: "slow_wf" });
    await new Promise((r) => setTimeout(r, 1500));
    const stop = await call("POST", "/api/tasks/stop-all");
    expect(stop.status).toBe(200);
    expect(stop.json.cancelledActive).toBeGreaterThanOrEqual(2);
    const ta = await waitForTask(a.json.task.id, ["cancelled"], 25_000);
    const tb = await waitForTask(b.json.task.id, ["cancelled"], 25_000);
    // The queued task must ALSO end cancelled — not start after the stop window.
    const tc = await waitForTask(c.json.task.id, ["cancelled"], 25_000);
    expect(ta.state).toBe("cancelled");
    expect(tb.state).toBe("cancelled");
    expect(tc.state).toBe("cancelled");
  });

  it("cancel while awaiting approval ends the task INSTANTLY (no 10-min wait)", async () => {
    const started = await call("POST", "/api/tasks", {
      workflowId: "demo_draft_transfer",
      inputs: { customer: "عميل إلغاء", item: "صنف إلغاء", quantity: "1" },
    });
    const id = started.json.task.id;
    // Wait for the approval gate.
    const deadline = Date.now() + 30_000;
    for (;;) {
      const { json } = await call("GET", `/api/tasks/${id}`);
      if (json.task.state === "awaiting_approval") break;
      if (Date.now() > deadline) throw new Error("never reached awaiting_approval");
      await new Promise((r) => setTimeout(r, 400));
    }
    const t0 = Date.now();
    const cancel = await call("POST", `/api/tasks/${id}/cancel`);
    expect(cancel.status).toBe(200);
    const task = await waitForTask(id, ["cancelled"], 10_000);
    expect(task.state).toBe("cancelled");
    expect(Date.now() - t0).toBeLessThan(9000); // instant — not the 10-min expiry
    // No approval left pending.
    const pending = await call("GET", "/api/approvals/pending");
    expect((pending.json.approvals as unknown[]).some((a: any) => a.taskId === id)).toBe(false);
  });

  it("history: clear deletes events, tasks stay (FR-07)", async () => {
    const cleared = await call("DELETE", "/api/history");
    expect(cleared.status).toBe(200);
    expect(cleared.json.cleared).toBeGreaterThan(0);
    // Tasks are NOT deleted by clearing the log.
    const tasks = await call("GET", "/api/tasks");
    expect(tasks.json.tasks.length).toBeGreaterThan(0);
    // Clearing again clears nothing.
    const again = await call("DELETE", "/api/history");
    expect(again.json.cleared).toBe(0);
  });

  it("AI-drafted workflow: schema-validated, never auto-saved (mock provider)", async () => {
    deps.settings.model.provider = "mock"; // route the draft endpoint to the mock
    process.env.AI_REPEAT_MOCK_TEXT = JSON.stringify({
      schemaVersion: "0.1",
      id: "drafted_wf",
      name: "مسودة من النموذج",
      allowedDomains: ["127.0.0.1", "localhost"],
      steps: [
        { id: "a", action: "navigate", url: `http://127.0.0.1:${fixturePort}/products`, risk: "read" },
        { id: "b", action: "extract_table", locator: { strategy: "testid", value: "missing-images-table" }, outputKey: "rows", risk: "read" },
        { id: "c", action: "export_csv", outputKey: "rows", path: "drafts/drafted.csv", risk: "local_write" },
      ],
      verification: [{ kind: "table_row_count", target: "[data-testid='missing-images-table'] tbody tr", expectedCount: 4 }],
    });
    try {
      const r = await call("POST", "/api/workflows/draft-from-plan", { text: "طلّعلي الناقص صور وصدرهم CSV" });
      expect(r.status).toBe(200);
      const wf = JSON.parse(r.json.draft) as { id: string; steps: unknown[] };
      expect(wf.id).toBe("drafted_wf");
      expect(wf.steps).toHaveLength(3);
      // The draft was NOT saved — it only exists in the response for review.
      const all = await call("GET", "/api/workflows");
      expect((all.json.workflows as Array<{ id: string }>).some((w) => w.id === "drafted_wf")).toBe(false);
    } finally {
      delete process.env.AI_REPEAT_MOCK_TEXT;
      deps.settings.model.provider = "zai";
    }
  });

  it("AI-drafted workflow: invalid model output is rejected, never stored (S12)", async () => {
    deps.settings.model.provider = "mock";
    process.env.AI_REPEAT_MOCK_TEXT = "أنا مش هرد بـ JSON خالص!";
    try {
      const r = await call("POST", "/api/workflows/draft-from-plan", { text: "مهمة أي حاجة" });
      expect(r.status).toBe(422);
      expect(r.json.error).toContain("DRAFT_INVALID");
      const all = await call("GET", "/api/workflows");
      expect((all.json.workflows as Array<{ id: string }>).length).toBeGreaterThan(0); // state intact
    } finally {
      delete process.env.AI_REPEAT_MOCK_TEXT;
      deps.settings.model.provider = "zai";
    }
  });

  it("backup → restore roundtrip: portability with safety rules (FR-07)", async () => {
    const backup = await call("GET", "/api/backup");
    expect(backup.status).toBe(200);
    const bundle = backup.json;
    expect(bundle.kind).toBe("ai-repeat-backup");
    expect(Array.isArray(bundle.workflows)).toBe(true);
    expect(Array.isArray(bundle.tasks)).toBe(true);

    // Restore into the SAME store: ids collide → renamed, nothing overwritten.
    const restored = await call("POST", "/api/backup/restore", bundle);
    expect(restored.status).toBe(200);
    expect(restored.json.workflows).toBeGreaterThan(0);
    expect(restored.json.renamed.length).toBeGreaterThan(0);
    // Schedules arrive disabled for safety.
    for (const s of bundle.schedules ?? []) {
      expect(s.enabled).toBe(false);
    }
    // The local skills were NOT overwritten: original names intact.
    const after = await call("GET", "/api/workflows");
    const mine = (after.json.workflows as Array<{ id: string; workflow: { name: string } }>).find(
      (w) => w.id === "shareable_wf",
    );
    expect(mine?.workflow.name).toBe("مهارة قابلة للمشاركة");
  });

  it("rejects non-backup files on restore (S12)", async () => {
    const r = await call("POST", "/api/backup/restore", { kind: "something-else" });
    expect(r.status).toBe(400);
    expect(r.json.error).toContain("BACKUP_INVALID");
  });

  it("PATCH /api/settings updates privacy toggles; rejects invalid values", async () => {
    const ok = await call("PATCH", "/api/settings", { saveScreenshots: true, retentionDays: 7 });
    expect(ok.status).toBe(200);
    expect(ok.json.settings.saveScreenshots).toBe(true);
    expect(ok.json.settings.retentionDays).toBe(7);
    const boot = await call("GET", "/api/bootstrap");
    expect(boot.json.settings.saveScreenshots).toBe(true);
    const bad = await call("PATCH", "/api/settings", { retentionDays: 0 });
    expect(bad.status).toBe(400);
    await call("PATCH", "/api/settings", { saveScreenshots: false });
  });
});


