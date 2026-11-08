/**
 * AI Repeat — agent service entrypoint.
 * Starts: local SQLite store, task manager, loopback API, optional fixture site.
 *
 * Runs two ways with identical behavior:
 *  - dev: `npm run agent` from the repo (tsx, ESM)
 *  - packaged: the Node-SEA sidecar binary bundled with the Tauri installer
 *    (CJS esbuild bundle — demo workflows are embedded at build time).
 * The bootstrap lives inside main() because the packaged bundle is CJS
 * (Node SEA) and cannot use top-level await.
 */
import { createServer as createHttpServer } from "node:http";
import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { loadSettings } from "./config.js";
import { Store } from "./store.js";
import { SecretVault } from "./vault.js";
import { cleanupOrphanedBrowsers } from "@ai-repeat/workflows";
import { acquireInstanceLock } from "./instance-lock.js";
import { TaskManager } from "./runner.js";
import { TeachManager } from "./teach.js";
import { cleanupExpiredEvidence } from "./retention.js";
import { ChromiumInstaller } from "./browser-install.js";
import { Scheduler } from "./scheduler.js";
import { createServer } from "./server.js";
import { createProvider } from "@ai-repeat/llm";
import { createFixtureServer, FIXTURE_PORT } from "../../../fixtures/demo-site/server.js";
// Embedded at build time so the packaged sidecar can seed without source files.
import demoMissingImages from "../../../fixtures/workflows/demo_missing_images.json" with { type: "json" };
import demoDraftTransfer from "../../../fixtures/workflows/demo_draft_transfer.json" with { type: "json" };

const AGENT_PORT = Number(process.env.AI_REPEAT_AGENT_PORT ?? 8757);

async function main(): Promise<void> {
  const settings = loadSettings();
  // Single-instance guard: two processes on one dataDir corrupt each other
  // (boot #2's stale-task recovery would fail boot #1's active runs).
  const lock = acquireInstanceLock(settings.dataDir);
  const store = new Store(settings.dataDir);

  // Kill Chromium processes orphaned by a previous crashed session — only PIDs
  // this app recorded itself, double-checked against the playwright cache path.
  const orphans = cleanupOrphanedBrowsers(settings.dataDir);
  if (orphans.killed.length) console.log(`[agent] cleanup: killed ${orphans.killed.length} orphaned browser process(es)`);
  const vault = new SecretVault(settings.dataDir);

// Recover tasks orphaned by a previous session — honest failure, never fake "running".
// Paused tasks are intentionally spared: they stopped at a verified checkpoint
// and the user can resume them (browser state from before is NOT preserved).
const stale = store.failStaleRunningTasks(
  "التطبيق اتقفل والمهمة كانت لسه شغالة. الحالة محفوظة للمراجعة، وشغّل المهمة تاني."
);
if (stale.length) console.log(`[agent] marked ${stale.length} stale task(s) as failed`);
const pausedResumable = store.listResumablePausedTasks();
if (pausedResumable.length) {
  console.log(`[agent] ${pausedResumable.length} paused task(s) resumable from their checkpoint (استكمال من صفحة المهام)`);
}

  /* ---------------------------- seed workflows ---------------------------- */

  const EMBEDDED_WORKFLOWS = [demoMissingImages, demoDraftTransfer] as Array<{ id: string }>;
  for (const wf of EMBEDDED_WORKFLOWS) {
    try {
      if (!store.getWorkflow(wf.id)) {
        store.upsertWorkflow({ id: wf.id, json: JSON.stringify(wf) });
        console.log(`[agent] seeded workflow ${wf.id}`);
      }
    } catch (e) {
      console.warn(`[agent] failed to seed ${wf.id}: ${e instanceof Error ? e.message : e}`);
    }
  }

  /* -------------------------------- fixture ------------------------------- */

  if (settings.autoStartFixture) {
    const fixture = createFixtureServer();
    await new Promise<void>((resolve) => {
      fixture.once("error", (err: NodeJS.ErrnoException) => {
        if (err.code === "EADDRINUSE") {
          console.log("[demo-site] already running on 127.0.0.1:4177");
        } else {
          console.warn("[demo-site] failed to start:", err.message);
        }
        resolve();
      });
      fixture.listen(FIXTURE_PORT, "127.0.0.1", () => {
        console.log(`[demo-site] http://127.0.0.1:${FIXTURE_PORT}`);
        resolve();
      });
    });
  }

  /* --------------------------------- agent -------------------------------- */

  const tasks = new TaskManager(store, settings, () => {
    // Provider built per task; the key is read from the vault only inside this service.
    const key = vault.getSecret(settings.model.apiKeyRef ?? "") ?? process.env.AI_REPEAT_DEV_KEY ?? undefined;
    return createProvider({
      provider: settings.model.provider,
      baseUrl: settings.model.baseUrl,
      modelId: settings.model.modelId,
      apiKey: key,
      timeoutMs: settings.model.timeoutMs,
      maxRetries: settings.model.maxRetries,
    });
  });

  // The repo-local UI dist only exists in dev/repo checkouts; the packaged app
  // serves the UI from Tauri assets instead.
  const repoRoot = process.cwd();
  const inRepoLayout = existsSync(path.join(repoRoot, "package.json")) && existsSync(path.join(repoRoot, "services", "agent"));
  const uiDistDir = path.join(repoRoot, "apps", "desktop", "dist");
  const teach = new TeachManager(settings);
  const installer = new ChromiumInstaller();
  const emitEvent = (ev: import("@ai-repeat/contracts").TaskEvent) => {
    // Route scheduler events through the same bus (persist + SSE broadcast).
    tasks.emitSystem(ev);
  };
  const scheduler = new Scheduler(store, (wfId, inputs, scheduleId) => {
    const wf = store.getWorkflow(wfId);
    if (!wf) throw new Error(`WORKFLOW_MISSING: ${wfId}`);
    return tasks.createTask(wf as never, inputs, scheduleId);
  }, emitEvent);
  scheduler.start();
  const { app, token } = createServer({
    store,
    tasks,
    settings,
    vault,
    teach,
    installer,
    scheduler,
    uiDistDir: inRepoLayout && existsSync(uiDistDir) ? uiDistDir : undefined,
  });

  const httpServer = createHttpServer(app);
  httpServer.listen(AGENT_PORT, "127.0.0.1", () => {
    console.log(`[agent] API  http://127.0.0.1:${AGENT_PORT}/api  (session token in ${path.join(settings.dataDir, "session-token")})`);
    if (inRepoLayout && !existsSync(uiDistDir)) {
      console.log("[agent] UI dist غير موجودة — للتطوير شغّل: npm run ui  (Vite dev server على 5173)");
    }
  });

  // Token file for the dev UI bridge (repo checkouts only).
  if (inRepoLayout) {
    try {
      writeFileSync(path.join(repoRoot, "apps", "desktop", ".session-token"), token, "utf8");
    } catch {
      /* best effort */
    }
  }

  // Retention (S11): physically remove expired evidence at boot and hourly.
  const runRetention = () => {
    const { files } = cleanupExpiredEvidence(settings.workspaceRoot, settings.retentionDays);
    const pruned = store.pruneOldCompletedTasks(settings.retentionDays);
    if (files > 0 || pruned > 0) console.log(`[agent] retention: deleted ${files} evidence file(s), ${pruned} old completed task(s)`);
  };
  runRetention();
  const retentionTimer = setInterval(runRetention, 3600_000);
  retentionTimer.unref?.();

  const shutdown = () => {
    console.log("\n[agent] shutting down…");
    tasks.cancelAll();
    lock.release();
    httpServer.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("[agent] fatal:", err instanceof Error ? err.stack ?? err.message : err);
  process.exit(1);
});
