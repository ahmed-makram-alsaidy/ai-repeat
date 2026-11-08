/**
 * Offline smoke demo — no HTTP, no LLM, no user data.
 * Boots the fixture site, runs the G1 workflow through the real executor
 * and real Chromium, and prints the verified outcome.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { readFileSync } from "node:fs";
import { DomainAllowlist } from "../packages/security/src/index.js";
import {
  installDomainGuard,
  launchEphemeralContext,
  resolveChromiumExecutable,
  runWorkflow,
} from "../packages/workflows/src/index.js";
import { WorkflowSchema } from "../packages/contracts/src/index.js";
import { createFixtureServer, FIXTURE_PORT } from "../fixtures/demo-site/server.js";

const server = createFixtureServer();
await new Promise<void>((resolve) => {
  server.once("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") console.log("[smoke] fixture already running — reusing it");
    else throw err;
    resolve();
  });
  server.listen(FIXTURE_PORT, "127.0.0.1", () => {
    console.log(`[smoke] fixture on http://127.0.0.1:${FIXTURE_PORT}`);
    resolve();
  });
});

const exe = resolveChromiumExecutable();
if (!exe) {
  console.error("[smoke] Chromium غير متسطب — شغّل: npx playwright install chromium");
  process.exit(1);
}

const workflow = WorkflowSchema.parse(
  JSON.parse(readFileSync(new URL("../fixtures/workflows/demo_missing_images.json", import.meta.url), "utf8")),
);
const workspace = mkdtempSync(path.join(tmpdir(), "ai-repeat-smoke-"));
const context = await launchEphemeralContext({ headless: true, executablePath: exe });
await installDomainGuard(context, new DomainAllowlist(workflow.allowedDomains));
const page = await context.newPage();

const result = await runWorkflow(
  workflow,
  {},
  {
    taskId: "smoke",
    allowlist: new DomainAllowlist(workflow.allowedDomains),
    workspaceRoot: workspace,
    signal: new AbortController().signal,
    events: (ev) => console.log(`  [event] ${ev.event}${ev.stepId ? `:${ev.stepId}` : ""}`),
    requestApproval: async () => true,
  },
  page,
);

await context.close().catch(() => {});
if (server.listening) await new Promise<void>((r) => server.close(() => r()));

console.log(`[smoke] outcome=${result.outcome}`);
for (const v of result.verifications) console.log(`  ${v.passed ? "✓" : "✗"} ${v.kind}: ${v.detail}`);
if (result.error) console.error(`[smoke] error: ${result.error}`);
process.exit(result.outcome === "completed" ? 0 : 1);
