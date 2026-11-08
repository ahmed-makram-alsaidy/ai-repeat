import { afterEach, describe, expect, it, vi } from "vitest";
import { MockProvider, OpenAICompatibleProvider, ProviderError, describeProviderError } from "@ai-repeat/llm";

describe("MockProvider", () => {
  it("returns the scripted result", async () => {
    const p = new MockProvider("mock-test", () => ({ text: "hello", usage: { inputTokens: 5, outputTokens: 2 } }));
    const res = await p.generate({ messages: [{ role: "user", content: "hi" }] });
    expect(res.text).toBe("hello");
    expect(res.usage?.inputTokens).toBe(5);
  });
});

describe("OpenAICompatibleProvider", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("testConnection fails fast with a clear error when no key (S09)", async () => {
    const p = new OpenAICompatibleProvider({ provider: "zai", baseUrl: "https://api.z.ai/api/paas/v4", modelId: "glm-5.3-flash" });
    const r = await p.testConnection();
    expect(r.ok).toBe(false);
    expect(r.error).toContain("MISSING_API_KEY");
  });

  it("generate throws immediately when no key", async () => {
    const p = new OpenAICompatibleProvider({ provider: "zai", baseUrl: "https://x", modelId: "m" });
    await expect(p.generate({ messages: [] })).rejects.toThrow(/MISSING_API_KEY/);
  });

  it("parses a successful completion with tool calls and usage", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            id: "req_1",
            choices: [
              {
                message: { role: "assistant", content: null, tool_calls: [{ id: "c1", function: { name: "navigate", arguments: '{"url":"http://x"}' } }] },
                finish_reason: "tool_calls",
              },
            ],
            usage: { prompt_tokens: 10, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 3 } },
          }),
          { status: 200 },
        ),
      ),
    );
    const usages: unknown[] = [];
    const p = new OpenAICompatibleProvider(
      { provider: "zai", baseUrl: "https://x", modelId: "glm-5.3-flash", apiKey: "k" },
      (u) => usages.push(u),
    );
    const res = await p.generate({ messages: [] });
    expect(res.toolCalls?.[0]?.name).toBe("navigate");
    expect(res.toolCalls?.[0]?.arguments).toEqual({ url: "http://x" });
    expect(res.usage?.inputTokens).toBe(10);
    expect(res.usage?.cachedTokens).toBe(3);
    expect(usages.length).toBe(1);
  });

  it("keeps invalid model JSON as a marked argument, never a silent fallback", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            choices: [{ message: { tool_calls: [{ id: "c1", function: { name: "t", arguments: "not-json" } }] } }],
          }),
          { status: 200 },
        ),
      ),
    );
    const p = new OpenAICompatibleProvider({ provider: "zai", baseUrl: "https://x", modelId: "m", apiKey: "k" });
    const res = await p.generate({ messages: [] });
    expect(res.toolCalls?.[0]?.arguments).toEqual({ __invalid_json: "not-json" });
  });

  it("retries 429 with backoff then succeeds", async () => {
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls++;
        if (calls < 3) return new Response(JSON.stringify({ error: { message: "rate limited" } }), { status: 429 });
        return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }), { status: 200 });
      }),
    );
    const p = new OpenAICompatibleProvider({ provider: "zai", baseUrl: "https://x", modelId: "m", apiKey: "k", maxRetries: 3 });
    const res = await p.generate({ messages: [] });
    expect(res.text).toBe("ok");
    expect(calls).toBe(3);
  });

  it("does NOT retry auth failures (401) — clear diagnostic instead", async () => {
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls++;
        return new Response("unauthorized", { status: 401 });
      }),
    );
    const p = new OpenAICompatibleProvider({ provider: "zai", baseUrl: "https://x", modelId: "m", apiKey: "bad", maxRetries: 3 });
    const err = await p.generate({ messages: [] }).catch((e: ProviderError) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).message).toContain("AUTH_ERROR");
    expect(calls).toBe(1);
  });

  it("describeProviderError maps network failures to Arabic diagnostics", () => {
    const e = new Error("fetch failed: getaddrinfo ENOTFOUND api.z.ai");
    expect(describeProviderError(e)).toContain("NETWORK_ERROR");
  });
});
