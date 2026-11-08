/**
 * AI Repeat — agent configuration & settings persistence.
 * Local-first: everything lives in a dedicated app data directory.
 * Secrets never go here — they live in the OS-backed vault (vault.ts).
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export interface ModelSettings {
  provider: "zai" | "openai-compatible" | "offline-demo" | "mock";
  baseUrl: string;
  modelId: string;
  timeoutMs: number;
  maxRetries: number;
  /** Reference/handle of the stored secret (e.g. "zai-default"). Never the secret itself. */
  apiKeyRef?: string;
}

export interface Budgets {
  maxStepsPerRun: number;
  maxTokensPerRun: number;
  maxWallMs: number;
  maxConcurrentTasks: number;
}

export interface Settings {
  language: "ar" | "en";
  stt: { engine: "web-speech" | "whisper-local" | "none"; binPath?: string; modelPath?: string; language?: string };
  /** Phase-5 step 1: READ-ONLY UIA inspection. Off by default; no input injection exists. */
  uia: { readOnlyInspection: boolean; /** Phase-5 step 2: InvokePattern execution on inspected elements. Off by default. */ patternsEnabled: boolean };
  dataDir: string;
  workspaceRoot: string;
  /** Extra always-approved fixture domains (localhost always included). */
  allowedDomains: string[];
  autoStartFixture: boolean;
  retentionDays: number;
  saveScreenshots: boolean;
  model: ModelSettings;
  budgets: Budgets;
}

export const DEFAULT_ZAI_BASE_URL = "https://api.z.ai/api/paas/v4";

function resolveDataDir(): string {
  if (process.env.AI_REPEAT_DATA_DIR) return path.resolve(process.env.AI_REPEAT_DATA_DIR);
  if (process.env.AI_REPEAT_DEV_MODE === "false") {
    return path.join(process.env.APPDATA ?? process.env.HOME ?? ".", "AIRepeat");
  }
  // Dev default: repo-local .local-dev (kept out of source control).
  return path.resolve(process.cwd(), ".local-dev");
}

export function loadSettings(dataDirOverride?: string): Settings {
  const dataDir = dataDirOverride ?? resolveDataDir();
  mkdirSync(dataDir, { recursive: true });
  const settingsPath = path.join(dataDir, "settings.json");
  const workspaceRoot = path.join(dataDir, "workspace");
  mkdirSync(workspaceRoot, { recursive: true });

  const defaults: Settings = {
    language: "ar",
    stt: { engine: "web-speech", language: "ar" },
    uia: { readOnlyInspection: false, patternsEnabled: false },
    dataDir,
    workspaceRoot,
    allowedDomains: ["localhost", "127.0.0.1"],
    autoStartFixture: true,
    retentionDays: 14,
    saveScreenshots: false,
    model: {
      provider: (process.env.AI_REPEAT_MODEL_PROVIDER as Settings["model"]["provider"]) ?? "zai",
      baseUrl: process.env.AI_REPEAT_ZAI_BASE_URL ?? DEFAULT_ZAI_BASE_URL,
      modelId: process.env.AI_REPEAT_MODEL_ID ?? "glm-5.3-flash",
      timeoutMs: 60_000,
      maxRetries: 3,
    },
    budgets: {
      maxStepsPerRun: Number(process.env.AI_REPEAT_MAX_STEPS_PER_RUN ?? 30),
      maxTokensPerRun: Number(process.env.AI_REPEAT_MAX_TOKENS_PER_RUN ?? 50_000),
      maxWallMs: 15 * 60_000,
      maxConcurrentTasks: 2,
    },
  };

  let persisted: Partial<Settings> = {};
  try {
    persisted = JSON.parse(readFileSync(settingsPath, "utf8")) as Partial<Settings>;
  } catch {
    /* first boot */
  }
  const merged: Settings = {
    ...defaults,
    ...persisted,
    dataDir,
    workspaceRoot,
    model: { ...defaults.model, ...(persisted.model ?? {}) },
    budgets: { ...defaults.budgets, ...(persisted.budgets ?? {}) },
    stt: { ...defaults.stt, ...(persisted.stt ?? {}) },
    uia: { ...defaults.uia, ...(persisted.uia ?? {}) },
  };
  // Extra domains from env are appended, never replacing localhost.
  const extra = (process.env.AI_REPEAT_ALLOWED_DOMAINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  merged.allowedDomains = [...new Set(["localhost", "127.0.0.1", ...merged.allowedDomains, ...extra])];
  mkdirSync(merged.workspaceRoot, { recursive: true });
  return merged;
}

export function saveSettings(settings: Settings): void {
  const { dataDir, ...persistable } = settings;
  void dataDir;
  writeFileSync(path.join(settings.dataDir, "settings.json"), JSON.stringify(persistable, null, 2), "utf8");
}

/** Public (client-safe) view of settings: no secret material, masked values only. */
export function publicSettings(s: Settings) {
  return {
    language: s.language,
    stt: { engine: s.stt.engine, hasBin: Boolean(s.stt.binPath), hasModel: Boolean(s.stt.modelPath), language: s.stt.language ?? "ar" },
    uia: { readOnlyInspection: s.uia.readOnlyInspection, patternsEnabled: s.uia.patternsEnabled },
    workspaceRoot: s.workspaceRoot,
    allowedDomains: s.allowedDomains,
    autoStartFixture: s.autoStartFixture,
    retentionDays: s.retentionDays,
    saveScreenshots: s.saveScreenshots,
    model: {
      provider: s.model.provider,
      baseUrl: s.model.baseUrl,
      modelId: s.model.modelId,
      timeoutMs: s.model.timeoutMs,
      maxRetries: s.model.maxRetries,
      hasApiKey: Boolean(s.model.apiKeyRef),
    },
    budgets: s.budgets,
  };
}
