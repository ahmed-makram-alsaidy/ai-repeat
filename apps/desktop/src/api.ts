/** Typed API client for the loopback agent service. */

let token: string | null = null;

interface TauriInternals {
  invoke: (cmd: string) => Promise<unknown>;
}

/**
 * Inside the Tauri shell the page origin is tauri.localhost, and the custom
 * protocol answers every unknown path with index.html — a relative "/api/*"
 * fetch would silently return the SPA shell instead of agent JSON. Call the
 * loopback agent directly. Dev mode keeps relative URLs (Vite proxies /api).
 */
const IS_TAURI = typeof window !== "undefined" && Boolean((window as unknown as { __TAURI_INTERNALS__?: TauriInternals }).__TAURI_INTERNALS__);
const API_BASE = IS_TAURI ? "http://127.0.0.1:8757" : "";

export async function initToken(): Promise<void> {
  if (token) return;
  // Desktop shell (Tauri): the session token arrives via IPC — never the network.
  const tauri = (window as unknown as { __TAURI_INTERNALS__?: TauriInternals }).__TAURI_INTERNALS__;
  if (tauri && typeof tauri.invoke === "function") {
    try {
      const t = await tauri.invoke("get_session_token");
      if (typeof t === "string" && t.length > 0) {
        token = t;
        return;
      }
    } catch {
      /* fall through to dev bridge */
    }
  }
  // Browser dev mode: the Vite dev bridge reads the token from disk server-side.
  try {
    const res = await fetch("/dev-session");
    if (res.ok) {
      const data = (await res.json()) as { token?: string };
      token = data.token ?? null;
    }
  } catch {
    token = null;
  }
}

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

/**
 * Cold-start helper: the sidecar (a ~100 MB Node SEA) takes seconds to boot and
 * rewrites session-token on every start — a token read too early is stale and
 * yields 401s forever. Poll until the agent answers a real bootstrap (clearing
 * a stale cached token on 401 so the next round re-reads the file) or the
 * deadline passes.
 */
export async function waitForAgent(maxMs = 20_000): Promise<boolean> {
  const deadline = Date.now() + maxMs;
  for (;;) {
    await initToken();
    if (token) {
      try {
        await call<Bootstrap>("/api/bootstrap");
        return true;
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) token = null; // stale file — re-read next round
      }
    }
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, 750));
  }
}

async function call<T>(path: string, init?: RequestInit & { raw?: boolean }): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init?.headers ?? {}),
    },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(String((body as { error?: string }).error ?? res.statusText), res.status);
  return body as T;
}

/** Raw-text GET (artifacts like CSV) — no JSON parsing. */
async function callText(path: string): Promise<string> {
  const res = await fetch(`${API_BASE}${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  if (!res.ok) throw new ApiError(res.statusText, res.status);
  return res.text();
}

/** Sandbox-checked artifact URL inside the approved workspace. */
function artifactUrlFor(relPath: string): string {
  return token ? `${API_BASE}/api/artifacts?path=${encodeURIComponent(relPath)}&token=${encodeURIComponent(token)}` : `${API_BASE}/api/artifacts?path=${encodeURIComponent(relPath)}`;
}

/* --------------------------------- types ---------------------------------- */

export interface TaskSummary {
  id: string;
  workflowId: string;
  workflowName: string;
  state: string;
  createdAt: string;
  updatedAt: string;
  error?: string;
  stepsDone: number;
  stepsTotal: number;
  verificationsPassed: boolean | null;
}

export interface Bootstrap {
  version: string;
  settings: {
    language: string;
    workspaceRoot: string;
    allowedDomains: string[];
    autoStartFixture: boolean;
    retentionDays: number;
    saveScreenshots: boolean;
    model: {
      provider: string;
      baseUrl: string;
      modelId: string;
      timeoutMs: number;
      maxRetries: number;
      hasApiKey: boolean;
    };
    budgets: { maxStepsPerRun: number; maxTokensPerRun: number; maxWallMs: number; maxConcurrentTasks: number };
  };
  browserAvailable: boolean;
  usage: { requests: number; inputTokens: number; outputTokens: number };
  kpis: {
    completedRuns: number;
    verifiedSuccessRate: number | null;
    avgRunSeconds: number | null;
    approvalsPerRun: number | null;
    tokensPerVerifiedRun: number | null;
    cancelledRuns: number;
  };
  tasks: TaskSummary[];
  workflows: Array<{ id: string; version: number; name?: string; description?: string; updatedAt: string }>;
}

export interface StepRunView {
  stepId: string;
  action: string;
  summary?: string;
  state: string;
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  error?: string;
  evidence?: Record<string, unknown>;
  attempt: number;
}

export interface TaskDetail extends TaskSummary {
  inputs: Record<string, string | number | boolean>;
  outputs: Record<string, unknown>;
  steps: StepRunView[];
  verifications: Array<{ kind: string; passed: boolean; detail: string; at: string }>;
  usage: { inputTokens: number; outputTokens: number; requests: number };
}

export interface ApprovalView {
  id: string;
  taskId: string;
  stepId: string;
  risk: string;
  title: string;
  detail: Record<string, unknown>;
  state: string;
  requestedAt: string;
  expiresAt: string;
}

export const api = {
  bootstrap: () => call<Bootstrap>("/api/bootstrap"),
  modelStatus: () => call<{ hasKey: boolean; model: string; provider: string; baseUrl: string }>("/api/model/status"),
  setKey: (key: string) => call<{ ok: boolean; masked: string }>("/api/model/key", { method: "POST", body: JSON.stringify({ key }) }),
  testConnection: () =>
    call<{ ok: boolean; model: string; error?: string; latencyMs?: number }>("/api/model/test", { method: "POST" }),
  saveModelConfig: (patch: Record<string, unknown>) => call<{ ok: boolean }>("/api/model/config", { method: "PATCH", body: JSON.stringify(patch) }),
  plan: (text: string) =>
    call<{
      plan: { summary: string; steps: string[]; suggestedWorkflowId: string | null; risk: string } | null;
      offlineFallback?: boolean;
      note?: string;
      error?: string;
      usage?: { inputTokens?: number } | null;
    }>("/api/plan", { method: "POST", body: JSON.stringify({ text }) }),
  draftFromPlan: (text: string) =>
    call<{ draft?: string; error?: string }>("/api/workflows/draft-from-plan", { method: "POST", body: JSON.stringify({ text }) }),
  workflows: () => call<{ workflows: Array<{ id: string; version: number; workflow: unknown; updatedAt: string }> }>("/api/workflows"),
  workflowJson: (id: string) => call<{ workflows: Array<{ id: string; workflow: unknown }> }>("/api/workflows"),
  runWorkflow: (workflowId: string, inputs: Record<string, string>) =>
    call<{ task: TaskSummary }>("/api/tasks", { method: "POST", body: JSON.stringify({ workflowId, inputs }) }),
  tasks: () => call<{ tasks: TaskSummary[] }>("/api/tasks"),
  task: (id: string) => call<{ task: TaskDetail; approvals: ApprovalView[] }>(`/api/tasks/${id}`),
  taskAction: (id: string, action: "pause" | "resume" | "cancel") => call<{ ok: boolean }>(`/api/tasks/${id}/${action}`, { method: "POST" }),
  retryTask: (id: string) => call<{ task: TaskSummary }>(`/api/tasks/${id}/retry`, { method: "POST" }),
  stopAllTasks: () => call<{ ok: boolean; cancelledActive: number }>("/api/tasks/stop-all", { method: "POST" }),
  clearHistory: () => call<{ ok: boolean; cleared: number }>("/api/history", { method: "DELETE" }),
  getSttConfig: () =>
    call<{ engine: string; binPath?: string; modelPath?: string; language: string }>("/api/stt/config"),
  saveAppSettings: (patch: Record<string, unknown>) => call<{ ok: boolean }>("/api/settings", { method: "PATCH", body: JSON.stringify(patch) }),
  saveSttConfig: (cfg: { engine: string; binPath?: string; modelPath?: string; language?: string }) =>
    call<{ ok: boolean; stt: { engine: string; hasBin: boolean; hasModel: boolean; language: string } }>("/api/stt/config", {
      method: "PATCH",
      body: JSON.stringify(cfg),
    }),
  backupUrl: () => (token ? `${API_BASE}/api/backup?token=${encodeURIComponent(token)}` : `${API_BASE}/api/backup`),
  restoreBackup: (bundle: unknown) =>
    call<{ ok: boolean; workflows: number; tasks: number; schedules: number; renamed: string[] }>("/api/backup/restore", {
      method: "POST",
      body: JSON.stringify(bundle),
    }),
  saveSettings: (patch: Record<string, unknown>) => call<{ ok: boolean }>("/api/settings", { method: "PATCH", body: JSON.stringify(patch) }),
  browserStatus: () =>
    call<{ available: boolean; installing: boolean; alreadyInstalled: boolean; revision: string; browserVersion: string; sizeHintMb: number }>(
      "/api/browser/status",
    ),
  installBrowser: () => call<{ ok: boolean; started?: boolean; alreadyInstalled?: boolean }>("/api/browser/install", { method: "POST" }),
  /** Sandbox-checked artifact download (CSV/JSON/PNG) inside the approved workspace. */
  artifactUrl: (relPath: string) => artifactUrlFor(relPath),
  fetchArtifactText: (relPath: string) => callText(artifactUrlFor(relPath)),
  pendingApprovals: () => call<{ approvals: ApprovalView[] }>("/api/approvals/pending"),
  resolveApproval: (id: string, action: "approve" | "reject", fingerprint?: string) =>
    call<{ ok: boolean }>(`/api/approvals/${id}/${action}`, { method: "POST", body: JSON.stringify({ fingerprint }) }),
  logsExportUrl: () => (token ? `${API_BASE}/api/logs/export?token=${encodeURIComponent(token)}` : `${API_BASE}/api/logs/export`),
  teachStart: (startUrl: string) =>
    call<{ status: { active: boolean; url?: string; message: string } }>("/api/teach/start", {
      method: "POST",
      body: JSON.stringify({ startUrl }),
    }),
  teachStop: () => call<{ draft: string }>("/api/teach/stop", { method: "POST" }),
  saveWorkflow: (workflow: unknown) => call<{ ok: boolean; id: string }>("/api/workflows", { method: "POST", body: JSON.stringify(workflow) }),
  importWorkflow: (workflow: unknown) =>
    call<{ ok: boolean; id: string; renamed: boolean }>("/api/workflows/import", { method: "POST", body: JSON.stringify(workflow) }),
  duplicateSkill: async (id: string) => {
    const all = await call<{ workflows: Array<{ id: string; workflow: unknown }> }>("/api/workflows");
    const wf = all.workflows.find((w) => w.id === id);
    if (!wf) throw new Error("NOT_FOUND");
    const copy = { ...(wf.workflow as Record<string, unknown>), id: `${id}_copy_${Date.now().toString(36)}` };
    return call<{ ok: boolean; id: string }>("/api/workflows", { method: "POST", body: JSON.stringify(copy) });
  },
  exportWorkflowUrl: (id: string) => (token ? `${API_BASE}/api/workflows/${id}/export?token=${encodeURIComponent(token)}` : `${API_BASE}/api/workflows/${id}/export`),
  workflowVersions: (id: string) => call<{ versions: Array<{ version: number; createdAt: string }> }>(`/api/workflows/${id}/versions`),
  restoreWorkflowVersion: (id: string, version: number) =>
    call<{ ok: boolean; restoredFrom: number }>(`/api/workflows/${id}/restore`, { method: "POST", body: JSON.stringify({ version }) }),
  schedules: () =>
    call<{
      schedules: Array<{
        id: string;
        workflowId: string;
        spec: { kind: string; everyMinutes?: number; atHHMM?: string };
        inputs: Record<string, string | number | boolean>;
        enabled: boolean;
        nextRunAt: string;
        lastRunAt?: string;
      }>;
    }>("/api/schedules"),
  createSchedule: (workflowId: string, spec: unknown, inputs: Record<string, string>) =>
    call<{ ok: boolean; schedule: { id: string; nextRunAt: string } }>("/api/schedules", {
      method: "POST",
      body: JSON.stringify({ workflowId, spec, inputs }),
    }),
  setScheduleEnabled: (id: string, enabled: boolean) => call<{ ok: boolean }>(`/api/schedules/${id}`, { method: "PATCH", body: JSON.stringify({ enabled }) }),
  deleteSchedule: (id: string) => call<{ ok: boolean }>(`/api/schedules/${id}`, { method: "DELETE" }),
  uiaStatus: () => call<{ settings: { uia: { readOnlyInspection: boolean } } }>("/api/bootstrap").then((b) => b.settings.uia),
  uiaFlag: (readOnlyInspection: boolean, patternsEnabled?: boolean) =>
    call<{ ok: boolean }>("/api/uia/flag", { method: "PATCH", body: JSON.stringify(patternsEnabled === undefined ? { readOnlyInspection } : { readOnlyInspection, patternsEnabled }) }),
  uiaInvoke: (hwnd: number, index: number) =>
    call<{ ok: boolean; invoked: string; note: string }>("/api/uia/invoke", { method: "POST", body: JSON.stringify({ hwnd, index }) }),
  uiaWindows: () => call<{ windows: Array<{ pid: number; processName: string; title: string; hwnd: number }> }>("/api/uia/windows"),
  uiaInspect: (hwnd: number) =>
    call<{ ok: boolean; readOnly: boolean; controls: Array<{ name: string; controlType: string; enabled: boolean; offscreen: boolean }> }>(
      "/api/uia/inspect",
      { method: "POST", body: JSON.stringify({ hwnd }) },
    ),
};

/** SSE events with token in the query string (EventSource cannot set headers). */
export function eventStreamUrl(): string {
  return token ? `${API_BASE}/api/events?token=${encodeURIComponent(token)}` : `${API_BASE}/api/events`;
}
