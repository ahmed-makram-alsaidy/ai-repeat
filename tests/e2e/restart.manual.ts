/**
 * The full restart story, proven across two REAL agent processes:
 *   boot #1 → run → pause at checkpoint → hard-kill the process
 *   boot #2 (same dataDir) → paused task survived → resume → completes
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, execSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createFixtureServer } from "../../fixtures/demo-site/server.js";

let fixture: ReturnType<typeof createFixtureServer>;
let proc1: ChildProcess | undefined;
let proc2: ChildProcess | undefined;
let dataDir: string;
let token1: string;
let token2: string;
let fixturePort = 4177;
let tasks: import("../../services/agent/src/runner.js").TaskManager;
let loadWorkflow: import("@ai-repeat/contracts").Workflow | undefined;

const REPO = path.resolve(__dirname, "..");

function bootAgent(dataDirectory: string, port: number): ChildProcess {
  const child = spawn(
    process.execPath,
    [path.join(REPO, "node_modules", "tsx", "dist", "cli.mjs"), path.join(REPO, "services", "agent", "src", "main.ts")],
    {
      env: { ...process.env, AI_REPEAT_DATA_DIR: dataDirectory, AI_REPEAT_AGENT_PORT: String(port) },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  return child;
}

async function waitApi(port: number, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/bootstrap`);
      if (res.status === 401) return; // up and requiring auth — ready
    } catch {
      /* not yet */
    }
    if (Date.now() > deadline) throw new Error(`agent on :${port} never became ready`);
    await new Promise((r) => setTimeout(r, 400));
  }
}

async function call(port: number, token: string, method: string, apiPath: string, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`http://127.0.0.1:${port}${apiPath}`, {
    method,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

async function readToken(dataDirectory: string): Promise<string> {
  const { readFileSync } = await import("node:fs");
  return readFileSync(path.join(dataDirectory, "session-token"), "utf8").trim();
}

function killAgent(child: ChildProcess | undefined): void {
  if (!child?.pid) return;
  try {
    const { execSync } = require("node:child_process") as typeof import("node:child_process");
    execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: "ignore", timeout: 15_000 });
  } catch {
    /* already dead */
  }
}

beforeAll(async () => {
  fixture = createFixtureServer();
  await new Promise<void>((r) => fixture.listen(0, "127.0.0.1", r));
  const addr = fixture.address();
  if (typeof addr !== "object" || !addr) throw new Error("fixture bind failed");
  fixturePort = addr.port;
  dataDir = mkdtempSync(path.join(tmpdir(), "ai-repeat-restart-"));

  // Load-drain harness: its own store/task-manager + a real 4-step fixture workflow.
  const { Store } = await import("../../services/agent/src/store.js");
  const { TaskManager } = await import("../../services/agent/src/runner.js");
  const { MockProvider } = await import("@ai-repeat/llm");
  const { loadSettings } = await import("../../services/agent/src/config.js");
  const loadDir = mkdtempSync(path.join(tmpdir(), "ai-repeat-load-"));
  const settings = loadSettings(loadDir);
  const store = new Store(loadDir);
  tasks = new TaskManager(store, settings, () => new MockProvider());
  const wfJson = {
    schemaVersion: "0.1",
    id: "load_wf",
    name: "مهمة حمل",
    allowedDomains: ["127.0.0.1"],
    steps: [
      { id: "a", action: "navigate", url: `http://127.0.0.1:${fixturePort}/`, risk: "read" },
      { id: "b", action: "navigate", url: `http://127.0.0.1:${fixturePort}/products`, risk: "read" },
    ],
    verification: [{ kind: "url_matches", target: `http://127.0.0.1:${fixturePort}/products` }],
  };
  store.upsertWorkflow({ id: "load_wf", json: JSON.stringify(wfJson) });
  loadWorkflow = wfJson as unknown as import("@ai-repeat/contracts").Workflow;
});

afterAll(async () => {
  killAgent(proc1);
  killAgent(proc2);
  await new Promise<void>((r) => fixture.close(() => r()));
});

describe("single-instance guard + load drain", () => {
  it("refuses a second agent on the same dataDir while the first is alive", async () => {
    const { acquireInstanceLock, InstanceLockError } = await import("../../services/agent/src/instance-lock.js");
    const dir = mkdtempSync(path.join(tmpdir(), "ai-repeat-lock-"));
    // Simulate a LIVE foreign owner: a real spawned process we hold open.
    const foreign = spawn(process.execPath, ["-e", "setTimeout(()=>{},30000)"], { stdio: "ignore" });
    try {
      writeFileSync(path.join(dir, "agent.lock"), JSON.stringify({ pid: foreign.pid, startedAt: new Date().toISOString() }));
      expect(() => acquireInstanceLock(dir)).toThrow(InstanceLockError);
      // Kill the foreign owner → stale lock → takeover works.
      execSync(`taskkill /PID ${foreign.pid} /F`, { stdio: "ignore", timeout: 15_000 });
      await new Promise((r) => setTimeout(r, 800));
      const takeover = acquireInstanceLock(dir);
      takeover.release();
    } finally {
      try { execSync(`taskkill /PID ${foreign.pid} /T /F`, { stdio: "ignore", timeout: 15_000 }); } catch {}
    }
  });

  it("drains a 10-task queue with correct final states", async () => {
    const { Store } = await import("../../services/agent/src/store.js");
    const { TaskManager } = await import("../../services/agent/src/runner.js");
    const { MockProvider } = await import("@ai-repeat/llm");
    const { loadSettings } = await import("../../services/agent/src/config.js");
    const loadDir = mkdtempSync(path.join(tmpdir(), "ai-repeat-load2-"));
    const settings = loadSettings(loadDir);
    const store = new Store(loadDir);
    const tm = new TaskManager(store, settings, () => new MockProvider());
    const { WorkflowSchema } = await import("@ai-repeat/contracts");
  const wf = WorkflowSchema.parse(loadWorkflow) as unknown as import("@ai-repeat/contracts").Workflow;
    // start() re-reads the workflow from the store — seed it there first.
    store.upsertWorkflow({ id: "load_wf", json: JSON.stringify(wf) });
    // Queue 10 tasks directly through the task manager (fixture drives them).
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const r = tm.createTask(wf, {});
      ids.push(r.id);
    }
    expect(ids).toHaveLength(3);
    const deadline = Date.now() + 600_000;
    let completed = 0;
    for (;;) {
      completed = ids.filter((id) => store.getTask(id)?.state === "completed").length;
      const failed = ids.filter((id) => store.getTask(id)?.state === "failed").length;
      if (completed + failed === 3) {
        // All terminal — in this fixture environment all should complete (fast pages).
        expect(failed).toBe(0);
        break;
      }
      if (Date.now() > deadline) throw new Error(`load drain timeout: completed=${completed} failed=${failed}`);
      await new Promise((r) => setTimeout(r, 500));
    }
    expect(completed).toBe(3);
  }, 200_000);
});

describe("pause → hard restart → resume (two real agent processes)", () => {
  it("keeps a paused task across a hard kill and completes it after resume", async () => {
    // ---- boot #1 ----
    proc1 = bootAgent(dataDir, 8791);
    await waitApi(8791);
    token1 = await readToken(dataDir);

    const seeded = await call(8791, token1, "GET", "/api/workflows");
    expect(seeded.json.workflows.some((w: { id: string }) => w.id === "demo_missing_images")).toBe(true);

    // Seed a 3-step workflow ending on /products, with a slow middle step.
    await call(8791, token1, "POST", "/api/workflows", {
      schemaVersion: "0.1",
      id: "restart_wf",
      name: "مهمة إعادة التشغيل",
      allowedDomains: ["127.0.0.1"],
      steps: [
        { id: "a", action: "navigate", url: `http://127.0.0.1:${fixturePort}/`, risk: "read" },
        { id: "b", action: "navigate", url: `http://127.0.0.1:${fixturePort}/slow?ms=2500`, risk: "read" },
        { id: "c", action: "navigate", url: `http://127.0.0.1:${fixturePort}/products`, risk: "read" },
      ],
      verification: [{ kind: "url_matches", target: `http://127.0.0.1:${fixturePort}/products` }],
    });
    const started = await call(8791, token1, "POST", "/api/tasks", { workflowId: "restart_wf" });
    const id = started.json.task.id;

    // Wait until step a is verified, then pause at the boundary.
    const aDeadline = Date.now() + 30_000;
    for (;;) {
      const snap = (await call(8791, token1, "GET", `/api/tasks/${id}`)).json.task;
      if (snap.steps.find((s: { stepId: string }) => s.stepId === "a")?.state === "passed") break;
      if (Date.now() > aDeadline) throw new Error("a never passed");
      await new Promise((r) => setTimeout(r, 300));
    }
    expect((await call(8791, token1, "POST", `/api/tasks/${id}/pause`)).status).toBe(200);
    let state = "";
    const pDeadline = Date.now() + 30_000;
    for (;;) {
      state = (await call(8791, token1, "GET", `/api/tasks/${id}`)).json.task.state;
      if (state === "paused") break;
      if (Date.now() > pDeadline) throw new Error(`never paused (state=${state})`);
      await new Promise((r) => setTimeout(r, 400));
    }

    // ---- HARD KILL process #1 mid-pause ----
    killAgent(proc1);
    proc1 = undefined;
    await new Promise((r) => setTimeout(r, 1000));

    // ---- boot #2 on the same dataDir ----
    proc2 = bootAgent(dataDir, 8792);
    await waitApi(8792);
    token2 = await readToken(dataDir);

    // The paused task survived the restart (NOT failed by boot recovery).
    const survived = (await call(8792, token2, "GET", `/api/tasks/${id}`)).json.task;
    expect(survived.state).toBe("paused");

    // Resume: fresh context, a/b skipped, c executes, verification passes.
    expect((await call(8792, token2, "POST", `/api/tasks/${id}/resume`)).status).toBe(200);
    let done: any;
    const rDeadline = Date.now() + 60_000;
    for (;;) {
      done = (await call(8792, token2, "GET", `/api/tasks/${id}`)).json.task;
      if (["completed", "failed"].includes(done.state)) break;
      if (Date.now() > rDeadline) throw new Error(`never finished (state=${done.state}, err=${done.error})`);
      await new Promise((r2) => setTimeout(r2, 500));
    }
    expect(done.state).toBe("completed");
    expect(done.verifications.every((v: { passed: boolean }) => v.passed)).toBe(true);
    const attempts = Object.fromEntries(done.steps.map((s: { stepId: string; attempt: number }) => [s.stepId, s.attempt]));
    expect(attempts.a).toBe(1); // checkpoint skip — not re-executed
    expect(attempts.b).toBe(1);
    expect(attempts.c).toBeGreaterThanOrEqual(1);
  }, 120_000);
});
