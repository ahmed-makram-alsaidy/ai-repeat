/**
 * Recorder (Teach Mode) E2E — acceptance scenario G3:
 * record on the fixture site, verify schema-valid draft with redacted
 * secrets, then replay twice with different variable values.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { WorkflowSchema, type Workflow } from "@ai-repeat/contracts";
import { DomainAllowlist } from "@ai-repeat/security";
import {
  installDomainGuard,
  launchEphemeralContext,
  resolveChromiumExecutable,
  runWorkflow,
  startRecording,
  toWorkflowDraft,
} from "@ai-repeat/workflows";
import { createFixtureServer } from "../../fixtures/demo-site/server.js";
import { budgetedProvider, TokenBudgetExceededError } from "../../services/agent/src/runner.js";
import { MockProvider } from "@ai-repeat/llm";

const exe = resolveChromiumExecutable();
const hasBrowser = exe !== null;

let server: ReturnType<typeof createFixtureServer>;
let base: string;

beforeAll(async () => {
  server = createFixtureServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  if (typeof addr !== "object" || !addr) throw new Error("fixture failed to bind");
  base = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

describe.skipIf(!hasBrowser)("Teach Mode recorder (G3)", () => {
  it("records fills/click on the draft form, produces an editable draft, replays twice with different values", async () => {
    const context = await launchEphemeralContext({ headless: true, executablePath: exe! });
    try {
      await installDomainGuard(context, new DomainAllowlist(["127.0.0.1", "localhost"]));
      const recorder = await startRecording(context);
      const page = await context.newPage();

      // The "user" performs the task once in the agent-owned browser:
      await page.goto(`${base}/drafts/new`, { waitUntil: "load" });
      await page.getByLabel("اسم العميل").fill("عميل التسجيل أ");
      await page.getByLabel("اسم العميل").press("Tab");
      await page.getByLabel("اسم الصنف").fill("صنف التسجيل");
      await page.getByLabel("اسم الصنف").press("Tab");
      await page.getByLabel("الكمية").fill("2");
      await page.getByLabel("الكمية").press("Tab");
      await page.getByRole("button", { name: "إرسال الطلب" }).click();
      await page.waitForLoadState("load");
      await new Promise((r) => setTimeout(r, 150)); // let debounced fill events flush

      const events = await recorder.stop();
      const { workflow: draft, manualCheckpoints } = toWorkflowDraft(
        { id: "recorded_draft_test", name: "مهمة مسجلة اختبار", allowedDomains: ["127.0.0.1", "localhost"] },
        events,
      );

      // Review/repair step (what the user edits in the UI):
      const candidate = {
        ...(draft as Record<string, unknown>),
        verification: [{ kind: "element_visible", target: "[data-testid='draft-confirmation']" }],
      };
      const parsed = WorkflowSchema.safeParse(candidate);
      expect(parsed.success).toBe(true);
      const workflow = parsed.data as Workflow;

      // Recorded steps: fill steps use {{varN}} variables; submit requires approval.
      const fillSteps = workflow.steps.filter((s) => s.action === "fill");
      expect(fillSteps.length).toBe(3);
      for (const s of fillSteps) expect(String(s.value)).toMatch(/^\{\{var\d\}\}$/);
      const submit = workflow.steps.find((s) => s.action === "click");
      expect(submit?.risk).toBe("external_write");
      expect(submit?.requiresApproval).toBe(true);
      expect(manualCheckpoints).toHaveLength(0);
      // Typed values live only in editable variable suggestions, never as raw step values.
      expect(JSON.stringify(workflow.steps)).not.toContain("عميل التسجيل أ");

      // Replay twice with different variable values (G3 pass criterion).
      for (const customer of ["عميل الإعادة 1", "عميل الإعادة 2"]) {
        const ws = mkdtempSync(path.join(tmpdir(), "ai-repeat-g3-"));
        const runCtx = await launchEphemeralContext({ headless: true, executablePath: exe! });
        try {
          const result = await runWorkflow(
            workflow,
            { var1: customer, var2: "صنف الإعادة", var3: "1" },
            {
              taskId: `g3_${customer}`,
              allowlist: new DomainAllowlist(["127.0.0.1", "localhost"]),
              workspaceRoot: ws,
              signal: new AbortController().signal,
              events: () => {},
              requestApproval: async () => true,
            },
            await runCtx.newPage(),
          );
          expect(result.outcome).toBe("completed");
          expect(result.verifications.every((v) => v.passed)).toBe(true);
        } finally {
          await runCtx.close().catch(() => {});
        }
      }
      const drafts = await (await fetch(`${base}/drafts`)).text();
      expect(drafts).toContain("عميل الإعادة 1");
      expect(drafts).toContain("عميل الإعادة 2");
    } finally {
      await context.close().catch(() => {});
    }
  });

  it("S03: password/OTP values are NEVER captured — they become manual checkpoints", async () => {
    const context = await launchEphemeralContext({ headless: true, executablePath: exe! });
    try {
      const recorder = await startRecording(context);
      const page = await context.newPage();
      await page.goto(`${base}/secure-form`, { waitUntil: "load" });
      await page.locator("#username").fill("مستخدم-تجريبي");
      await page.locator("#username").press("Tab");
      await page.locator("#password").fill("سري-جدا-لا-يسجل-12345");
      await page.locator("#password").press("Tab");
      await page.locator("#otp").fill("000111");
      await page.locator("#otp").press("Tab");
      await new Promise((r) => setTimeout(r, 250));

      const events = await recorder.stop();
      const { workflow: draft, variables, manualCheckpoints } = toWorkflowDraft(
        { id: "recorded_secret_test", name: "تسجيل حقول حساسة", allowedDomains: ["127.0.0.1", "localhost"] },
        events,
      );

      const everything = JSON.stringify(draft) + JSON.stringify(manualCheckpoints) + JSON.stringify(variables);
      // Sensitive values are absent EVERYWHERE — draft, checkpoints, variable suggestions:
      expect(everything).not.toContain("سري-جدا-لا-يسجل-12345");
      expect(everything).not.toContain("000111");
      // The non-sensitive username IS captured as an editable variable suggestion:
      expect(JSON.stringify(variables)).toContain("مستخدم-تجريبي");
      // Each sensitive field became an explicit manual-checkpoint step:
      expect(manualCheckpoints).toHaveLength(2);
      const steps = draft.steps as Array<Record<string, unknown>>;
      expect(steps.some((s) => s.action === "request_approval")).toBe(true);
    } finally {
      await context.close().catch(() => {});
    }
  });
});

describe("Token budget enforcement", () => {
  it("stops model calls once provider-reported usage crosses the cap", async () => {
    const inner = new MockProvider("m", () => ({ text: "ok", usage: { inputTokens: 6, outputTokens: 6 } }));
    const seen: Array<[number, number]> = [];
    const p = budgetedProvider(inner, {
      taskId: "t",
      capTokens: 20,
      onUsage: (i, o) => seen.push([i, o]),
    });
    await p.generate({ messages: [] }); // 12 — under cap
    // The call that crosses the cap still spent provider tokens; it must fail loudly
    // so the caller stops, and every later call is refused at entry.
    await expect(p.generate({ messages: [] })).rejects.toBeInstanceOf(TokenBudgetExceededError); // 24 > 20
    await expect(p.generate({ messages: [] })).rejects.toBeInstanceOf(TokenBudgetExceededError);
    expect(seen).toHaveLength(2); // both completed calls reported usage
  });

  it("a provider that reports no usage never trips the budget", async () => {
    const inner = new MockProvider("m", () => ({ text: "ok" }));
    const p = budgetedProvider(inner, { taskId: "t", capTokens: 1, onUsage: () => {} });
    await expect(p.generate({ messages: [] })).resolves.toMatchObject({ text: "ok" });
  });
});
