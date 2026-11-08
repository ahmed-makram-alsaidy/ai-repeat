/**
 * AI Repeat — model provider adapters.
 * Provider-agnostic by contract; ships an OpenAI-compatible adapter used for
 * Z.ai GLM (base https://api.z.ai/api/paas/v4, endpoint /chat/completions),
 * a MockProvider for tests, and an OfflineDemoPlanner that never pretends
 * a model call succeeded.
 */
import type { TaskEvent, UsageEvent } from "@ai-repeat/contracts";

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: unknown;
}

export interface GenerateInput {
  messages: ChatMessage[];
  tools?: Array<Record<string, unknown>>;
  maxOutputTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
}

export interface GenerateResult {
  text?: string;
  toolCalls?: ToolCall[];
  usage?: { inputTokens?: number; outputTokens?: number; cachedTokens?: number };
  rawRequestId?: string;
  stopReason?: string;
}

export interface ModelProvider {
  readonly id: string;
  readonly model: string;
  testConnection(): Promise<{ ok: boolean; model: string; error?: string; latencyMs?: number }>;
  generate(input: GenerateInput): Promise<GenerateResult>;
}

export interface ProviderConfig {
  provider: string; // "zai" | "openai-compatible" | "mock" | "offline-demo"
  baseUrl: string; // e.g. https://api.z.ai/api/paas/v4
  modelId: string; // e.g. glm-5.3-flash
  apiKeyRef?: string; // secret handle — never the raw key
  apiKey?: string; // injected at runtime from vault; never persisted
  timeoutMs?: number; // default 60_000
  maxRetries?: number; // default 3
}

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

/* --------------------------- OpenAI-compatible ---------------------------- */

interface ChatCompletionResponse {
  id?: string;
  model?: string;
  choices?: Array<{
    message?: { role?: string; content?: string | null; tool_calls?: Array<{ id?: string; type?: string; function?: { name?: string; arguments?: string } }> };
    finish_reason?: string;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } };
  error?: { message?: string; type?: string };
}

export class OpenAICompatibleProvider implements ModelProvider {
  readonly id: string;
  readonly model: string;
  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;

  constructor(config: ProviderConfig, private readonly onUsage?: (u: UsageEvent) => void) {
    this.id = config.provider;
    this.model = config.modelId;
    this.baseUrl = config.baseUrl.replace(/\/+$/, "");
    this.apiKey = config.apiKey;
    this.timeoutMs = config.timeoutMs ?? 60_000;
    this.maxRetries = config.maxRetries ?? 3;
  }

  async testConnection(): Promise<{ ok: boolean; model: string; error?: string; latencyMs?: number }> {
    if (!this.apiKey) {
      return { ok: false, model: this.model, error: "MISSING_API_KEY: لم يتم ضبط مفتاح الـAPI. افتح الإعدادات وأضف المفتاح." };
    }
    const started = Date.now();
    try {
      // Minimal low-token request: 1 token in / 1 token out.
      const res = await this.request(
        {
          model: this.model,
          messages: [{ role: "user", content: "ping" }],
          max_tokens: 1,
        },
        undefined,
      );
      void res;
      return { ok: true, model: this.model, latencyMs: Date.now() - started };
    } catch (err) {
      return { ok: false, model: this.model, error: describeProviderError(err), latencyMs: Date.now() - started };
    }
  }

  async generate(input: GenerateInput): Promise<GenerateResult> {
    if (!this.apiKey) throw new ProviderError("MISSING_API_KEY: لم يتم ضبط مفتاح الـAPI.", 401, false);
    const body: Record<string, unknown> = {
      model: this.model,
      messages: input.messages,
      max_tokens: input.maxOutputTokens ?? 1024,
    };
    if (input.temperature !== undefined) body.temperature = input.temperature;
    if (input.tools && input.tools.length > 0) {
      body.tools = input.tools;
      body.tool_choice = "auto";
    }
    const res = await this.request(body, input.signal);
    const choice = res.choices?.[0];
    const toolCalls: ToolCall[] = (choice?.message?.tool_calls ?? [])
      .map((tc, i) => {
        let args: unknown = undefined;
        const raw = tc.function?.arguments;
        if (typeof raw === "string") {
          try {
            args = JSON.parse(raw);
          } catch {
            args = { __invalid_json: raw };
          }
        }
        return { id: tc.id ?? `call_${i}`, name: tc.function?.name ?? "", arguments: args };
      })
      .filter((tc) => tc.name !== "");
    if (res.usage && this.onUsage) {
      this.onUsage({
        provider: this.id,
        model: this.model,
        requestId: res.id,
        inputTokens: res.usage.prompt_tokens,
        outputTokens: res.usage.completion_tokens,
        cachedTokens: res.usage.prompt_tokens_details?.cached_tokens,
        latencyMs: undefined,
        at: new Date().toISOString(),
      });
    }
    return {
      text: choice?.message?.content ?? undefined,
      toolCalls: toolCalls.length ? toolCalls : undefined,
      usage: res.usage
        ? {
            inputTokens: res.usage.prompt_tokens,
            outputTokens: res.usage.completion_tokens,
            cachedTokens: res.usage.prompt_tokens_details?.cached_tokens,
          }
        : undefined,
      rawRequestId: res.id,
      stopReason: choice?.finish_reason,
    };
  }

  private async request(body: Record<string, unknown>, signal?: AbortSignal): Promise<ChatCompletionResponse> {
    const url = `${this.baseUrl}/chat/completions`;
    let lastErr: unknown;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      const abort = new AbortController();
      const onOuterAbort = () => abort.abort();
      if (signal) {
        if (signal.aborted) throw new ProviderError("Request aborted", 499, false);
        signal.addEventListener("abort", onOuterAbort, { once: true });
      }
      const timer = setTimeout(() => abort.abort(), this.timeoutMs);
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify(body),
          signal: abort.signal,
        });
        if (res.status === 429 || res.status >= 500) {
          lastErr = new ProviderError(`HTTP ${res.status} ${res.statusText || ""}`.trim(), res.status, true);
        } else if (res.status === 401 || res.status === 403) {
          const text = await res.text().catch(() => "");
          throw new ProviderError(
            `AUTH_ERROR HTTP ${res.status}: ${text.slice(0, 300) || "Unauthorized — تحقق من مفتاح الـAPI"}`,
            res.status,
            false,
          );
        } else if (!res.ok) {
          const text = await res.text().catch(() => "");
          throw new ProviderError(`HTTP ${res.status}: ${text.slice(0, 300)}`, res.status, false);
        } else {
          const json = (await res.json()) as ChatCompletionResponse;
          if (json.error?.message) {
            throw new ProviderError(`PROVIDER_ERROR: ${json.error.message}`, res.status, false);
          }
          return json;
        }
      } catch (err) {
        if (err instanceof ProviderError && !err.retryable) throw err;
        lastErr = err;
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onOuterAbort);
      }
      if (attempt < this.maxRetries) {
        // Exponential backoff with jitter: 500ms, 1s, 2s…
        const backoff = Math.min(2 ** attempt * 500, 8000) + Math.floor(Math.random() * 250);
        await sleep(signal, backoff);
      }
    }
    throw lastErr instanceof Error
      ? lastErr instanceof ProviderError
        ? lastErr
        : new ProviderError(describeProviderError(lastErr), undefined, true)
      : new ProviderError("Unknown provider failure", undefined, true);
  }
}

function sleep(signal: AbortSignal | undefined, ms: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    if (signal) {
      const onAbort = () => {
        clearTimeout(t);
        reject(new ProviderError("Request aborted", 499, false));
      };
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

export function describeProviderError(err: unknown): string {
  if (err instanceof ProviderError) return err.message;
  if (err instanceof Error) {
    if (err.name === "AbortError" || err.name === "TimeoutError") {
      return "TIMEOUT: الطلب استغرق وقتًا أطول من المهلة المحددة.";
    }
    if (err.message.includes("fetch failed") || err.message.includes("ECONNREFUSED") || err.message.includes("ENOTFOUND")) {
      return `NETWORK_ERROR: تعذر الوصول إلى الـendpoint. (${err.message.slice(0, 200)})`;
    }
    return err.message;
  }
  return String(err);
}

/* -------------------------------- Mock provider --------------------------- */

export class MockProvider implements ModelProvider {
  readonly id = "mock";
  readonly model: string;
  constructor(
    model = "mock-glm-5.3-flash",
    private readonly handler: (input: GenerateInput) => GenerateResult | Promise<GenerateResult> = () => ({
      // Test hook: AI_REPEAT_MOCK_TEXT supplies a canned completion when set.
      text: process.env.AI_REPEAT_MOCK_TEXT ?? "ok",
      usage: { inputTokens: 3, outputTokens: 1 },
    }),
  ) {
    this.model = model;
  }
  async testConnection() {
    return { ok: true, model: this.model, latencyMs: 1 };
  }
  async generate(input: GenerateInput): Promise<GenerateResult> {
    await new Promise((r) => setTimeout(r, 5));
    return this.handler(input);
  }
}

/* ------------------------------ Offline demo ------------------------------ */

export class OfflineDemoProvider implements ModelProvider {
  readonly id = "offline-demo";
  readonly model = "deterministic-offline";
  async testConnection() {
    return { ok: true, model: this.model };
  }
  async generate(): Promise<GenerateResult> {
    return {
      text: "OFFLINE_DEMO: الوضع التجريبي المحلي — لا يوجد نداء فعلي لنموذج خارجي في هذا الطلب.",
      usage: undefined,
    };
  }
}

export function createProvider(config: ProviderConfig, onUsage?: (u: UsageEvent) => void): ModelProvider {
  switch (config.provider) {
    case "mock":
      return new MockProvider(config.modelId);
    case "offline-demo":
      return new OfflineDemoProvider();
    case "zai":
    case "openai-compatible":
    default:
      return new OpenAICompatibleProvider(config, onUsage);
  }
}
