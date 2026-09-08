import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Model,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import type { ProviderAuth, ProviderTurnRequest } from "@/lib/domain/provider";

const { streamSimpleMock } = vi.hoisted(() => ({ streamSimpleMock: vi.fn() }));

vi.mock("@earendil-works/pi-ai/providers/openai", () => ({
  openaiProvider: () => ({ getModels: () => [MODEL], streamSimple: streamSimpleMock }),
}));

const MODEL: Model<"openai-responses"> = {
  id: "gpt-5.6-terra",
  name: "GPT-5.6 Terra",
  api: "openai-responses",
  provider: "openai",
  baseUrl: "https://api.openai.com/v1",
  reasoning: true,
  input: ["text", "image"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 272_000,
  maxTokens: 128_000,
  compat: { supportsStrictMode: true },
};

const AUTH: ProviderAuth = { providerId: "openai", method: "api-key", secret: "sk-test-key" };

function request(): ProviderTurnRequest {
  return {
    model: MODEL,
    reasoningEffort: "high",
    context: { systemPrompt: "policy", messages: [{ role: "user", content: "Hello", timestamp: 1 }], tools: [] },
  };
}

function message(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: "Hello" }],
    api: MODEL.api,
    provider: MODEL.provider,
    model: MODEL.id,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop",
    timestamp: 2,
    ...overrides,
  };
}

function completedStream() {
  const stream = createAssistantMessageEventStream();
  const final = message();
  stream.push({ type: "start", partial: { ...final, stopReason: "pending" } });
  stream.push({ type: "done", reason: "stop", message: final });
  stream.end();
  return stream;
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iterable) out.push(item);
  return out;
}

beforeEach(() => streamSimpleMock.mockReset());
afterEach(() => vi.unstubAllGlobals());

describe("OpenAIProvider Pi adapter", () => {
  it("resolves models from Pi's source-controlled OpenAI catalog", async () => {
    const { OpenAIProvider } = await import("@/lib/providers/openai");
    const provider = new OpenAIProvider();
    expect(provider.getModel("gpt-5.6-terra")).toBe(MODEL);
    expect(provider.getModel("missing")).toBeNull();
  });

  it("preserves request privacy, retry, cache, token, and sequential-call policy", async () => {
    let options: SimpleStreamOptions | undefined;
    streamSimpleMock.mockImplementation((_model, _context, received: SimpleStreamOptions) => {
      options = received;
      return completedStream();
    });
    const { OpenAIProvider } = await import("@/lib/providers/openai");
    await collect(new OpenAIProvider().streamTurn(request(), AUTH, new AbortController().signal));

    expect(options).toMatchObject({ apiKey: "sk-test-key", reasoning: "high", maxTokens: 8192, timeoutMs: 120_000, maxRetries: 0, cacheRetention: "none", transport: "sse" });
    expect(await options?.onPayload?.({ model: "gpt-5.6-terra", store: true }, MODEL)).toEqual({
      model: "gpt-5.6-terra",
      store: false,
      parallel_tool_calls: false,
    });
  });

  it("normalizes an HTTP failure without exposing Pi's raw provider body", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("secret upstream body", { status: 429, headers: { "x-request-id": "req_123" } })));
    streamSimpleMock.mockImplementation((_model: unknown, _context: unknown, options: SimpleStreamOptions) => {
      const stream = createAssistantMessageEventStream();
      void (async () => {
        await options?.fetch?.("https://api.openai.com/v1/responses");
        const failed = message({ stopReason: "error", errorMessage: "secret upstream body" });
        stream.push({ type: "error", reason: "error", error: failed });
        stream.end();
      })();
      return stream;
    });
    const { decodeProviderError, OpenAIProvider } = await import("@/lib/providers/openai");
    const events = await collect(new OpenAIProvider().streamTurn(request(), AUTH, new AbortController().signal));
    const failed = events.find((event) => event.type === "error");
    if (failed?.type !== "error") throw new Error("expected error");
    expect(failed.error.errorMessage).not.toContain("secret upstream body");
    expect(decodeProviderError(failed.error.errorMessage)).toMatchObject({ code: "RATE_LIMIT", retryable: true, status: 429, requestId: "req_123" });
  });

  it("validates a key with a direct bounded OpenAI models request", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const { OpenAIProvider } = await import("@/lib/providers/openai");
    await expect(new OpenAIProvider().validateAuth(AUTH, new AbortController().signal)).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledWith("https://api.openai.com/v1/models", {
      headers: { Authorization: "Bearer sk-test-key" },
      signal: expect.any(AbortSignal),
    });
  });

  it("normalizes rejected credentials without reading the response body", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("do-not-leak", { status: 401 })));
    const { OpenAIProvider } = await import("@/lib/providers/openai");
    await expect(new OpenAIProvider().validateAuth(AUTH, new AbortController().signal)).rejects.toMatchObject({
      code: "AUTHENTICATION",
      message: "The OpenAI API key was rejected.",
      status: 401,
    });
  });
});
