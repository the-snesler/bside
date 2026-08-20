import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Response, ResponseStreamEvent } from "openai/resources/responses/responses";
import type { ProviderAuth, ProviderTurnRequest } from "@/lib/domain/provider";
import { OpenAIProvider, ProviderStreamError } from "@/lib/providers/openai";

/** Single named alias for the `openai` module's exports shape; used by `vi.mock`/`vi.importActual` generics below. */
type OpenAIModule = typeof import("openai");

const { responsesCreateMock, modelsListMock } = vi.hoisted(() => ({
  responsesCreateMock: vi.fn(),
  modelsListMock: vi.fn(),
}));

vi.mock("openai", async (importOriginal) => {
  const actual = await importOriginal<OpenAIModule>();
  class FakeOpenAI {
    responses = { create: responsesCreateMock };
    models = { list: modelsListMock };
    static APIError = actual.default.APIError;
    static APIConnectionError = actual.default.APIConnectionError;
    static APIConnectionTimeoutError = actual.default.APIConnectionTimeoutError;
    static APIUserAbortError = actual.default.APIUserAbortError;
    static AuthenticationError = actual.default.AuthenticationError;
    static RateLimitError = actual.default.RateLimitError;
    static BadRequestError = actual.default.BadRequestError;
    static InternalServerError = actual.default.InternalServerError;
    static UnprocessableEntityError = actual.default.UnprocessableEntityError;
  }
  return { default: FakeOpenAI };
});

beforeEach(() => {
  responsesCreateMock.mockReset();
  modelsListMock.mockReset();
});

const AUTH: ProviderAuth = { providerId: "openai", method: "api-key", secret: "sk-test-key" };

function baseRequest(overrides: Partial<ProviderTurnRequest> = {}): ProviderTurnRequest {
  return {
    modelId: "gpt-5.6-terra",
    reasoningEffort: "medium",
    transcript: [{ id: "u1", kind: "message", role: "user", text: "Summarize this page.", context: null, at: 1 }],
    contextArtifacts: [],
    replayState: null,
    tools: [],
    ...overrides,
  };
}

function fixtureResponse(overrides: Partial<Response> = {}): Response {
  return {
    id: "resp_1",
    created_at: 0,
    output_text: "",
    error: null,
    incomplete_details: null,
    instructions: null,
    metadata: null,
    model: "gpt-5.6-terra",
    object: "response",
    output: [],
    parallel_tool_calls: false,
    temperature: null,
    tool_choice: "auto",
    tools: [],
    top_p: null,
    ...overrides,
  } as Response;
}

function fixtureStream(events: ResponseStreamEvent[]): AsyncIterable<ResponseStreamEvent> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const event of events) yield event;
    },
  };
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iterable) out.push(item);
  return out;
}

describe("OpenAIProvider.streamTurn: normalization", () => {
  it("normalizes text deltas", async () => {
    responsesCreateMock.mockResolvedValue(
      fixtureStream([
        {
          type: "response.output_text.delta",
          delta: "Hello",
          content_index: 0,
          item_id: "item1",
          output_index: 0,
          sequence_number: 1,
          logprobs: [],
        },
        {
          type: "response.output_text.delta",
          delta: " world",
          content_index: 0,
          item_id: "item1",
          output_index: 0,
          sequence_number: 2,
          logprobs: [],
        },
        { type: "response.completed", sequence_number: 3, response: fixtureResponse({ output_text: "Hello world" }) },
      ] as ResponseStreamEvent[]),
    );

    const provider = new OpenAIProvider();
    const events = await collect(provider.streamTurn(baseRequest(), AUTH, new AbortController().signal));

    expect(events[0]).toEqual({ type: "text.delta", delta: "Hello" });
    expect(events[1]).toEqual({ type: "text.delta", delta: " world" });
    expect(events[2]?.type).toBe("turn.completed");
  });

  it("normalizes a completed function call into a tool.call event", async () => {
    responsesCreateMock.mockResolvedValue(
      fixtureStream([
        {
          type: "response.output_item.done",
          output_index: 0,
          sequence_number: 1,
          item: {
            type: "function_call",
            call_id: "call_1",
            name: "page_click",
            arguments: '{"ref":"e1","revision":"rev-1"}',
            status: "completed",
          },
        },
        { type: "response.completed", sequence_number: 2, response: fixtureResponse() },
      ] as ResponseStreamEvent[]),
    );

    const provider = new OpenAIProvider();
    const events = await collect(provider.streamTurn(baseRequest(), AUTH, new AbortController().signal));

    expect(events[0]).toEqual({
      type: "tool.call",
      call: { id: "call_1", name: "page_click", arguments: { ref: "e1", revision: "rev-1" } },
    });
  });

  it("ignores output_item.done events for non-function-call items", async () => {
    responsesCreateMock.mockResolvedValue(
      fixtureStream([
        {
          type: "response.output_item.done",
          output_index: 0,
          sequence_number: 1,
          item: { id: "item1", type: "message", role: "assistant", status: "completed", content: [] },
        },
        { type: "response.completed", sequence_number: 2, response: fixtureResponse() },
      ] as ResponseStreamEvent[]),
    );

    const provider = new OpenAIProvider();
    const events = await collect(provider.streamTurn(baseRequest(), AUTH, new AbortController().signal));

    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("turn.completed");
  });

  it("carries complete output items into replay state on completion", async () => {
    const functionCallItem = {
      type: "function_call" as const,
      call_id: "call_1",
      name: "page_click",
      arguments: '{"ref":"e1","revision":"rev-1"}',
      status: "completed" as const,
    };
    responsesCreateMock.mockResolvedValue(
      fixtureStream([
        {
          type: "response.completed",
          sequence_number: 1,
          response: fixtureResponse({ output: [functionCallItem] }),
        },
      ] as ResponseStreamEvent[]),
    );

    const provider = new OpenAIProvider();
    const events = await collect(provider.streamTurn(baseRequest(), AUTH, new AbortController().signal));

    expect(events).toHaveLength(1);
    const completed = events[0] as { type: "turn.completed"; replayState: unknown };
    expect(completed.type).toBe("turn.completed");
    const replay = completed.replayState as { outputItems: unknown[] };
    expect(replay.outputItems).toEqual([functionCallItem]);
  });
});

describe("OpenAIProvider.streamTurn: request shape", () => {
  it("sets stream/store/parallel_tool_calls/model/reasoning exactly", async () => {
    responsesCreateMock.mockResolvedValue(
      fixtureStream([{ type: "response.completed", sequence_number: 1, response: fixtureResponse() }] as ResponseStreamEvent[]),
    );

    const provider = new OpenAIProvider();
    await collect(
      provider.streamTurn(baseRequest({ modelId: "gpt-5.6-luna", reasoningEffort: "high" }), AUTH, new AbortController().signal),
    );

    expect(responsesCreateMock).toHaveBeenCalledTimes(1);
    const [body] = responsesCreateMock.mock.calls[0] as [Record<string, unknown>];
    expect(body.stream).toBe(true);
    expect(body.store).toBe(false);
    expect(body.parallel_tool_calls).toBe(false);
    expect(body.model).toBe("gpt-5.6-luna");
    expect(body.reasoning).toEqual({ effort: "high" });
    expect(body.max_output_tokens).toBe(8192);
  });

  it("wraps the attached page context between untrusted-artifact markers", async () => {
    responsesCreateMock.mockResolvedValue(
      fixtureStream([{ type: "response.completed", sequence_number: 1, response: fixtureResponse() }] as ResponseStreamEvent[]),
    );

    const provider = new OpenAIProvider();
    await collect(
      provider.streamTurn(
        baseRequest({
          contextArtifacts: [
            {
              artifactId: "a1",
              kind: "page",
              title: "Agent Fixture",
              url: "http://127.0.0.1:4173/agent-page.html",
              capturedAt: 1,
              target: { kind: "tab", tabId: 1 },
              snapshot: {
                version: 1,
                tabId: 1,
                revision: "r1",
                url: "http://127.0.0.1:4173/agent-page.html",
                origin: "http://127.0.0.1:4173",
                title: "Agent Fixture",
                readableText: "Orchid launch moved to Friday.",
                selectionText: "",
                viewport: { width: 0, height: 0, scrollX: 0, scrollY: 0 },
                nodes: [],
                truncated: { readableText: false, nodes: false },
                warnings: [],
              },
            },
          ],
        }),
        AUTH,
        new AbortController().signal,
      ),
    );

    const [body] = responsesCreateMock.mock.calls[0] as [{ input: Array<{ role: string; content: string }> }];
    const developerItem = body.input.find((item) => item.role === "developer");
    expect(developerItem?.content).toContain("BEGIN_UNTRUSTED_PAGE_ARTIFACT");
    expect(developerItem?.content).toContain("Orchid launch moved to Friday.");
    expect(developerItem?.content).toContain("END_UNTRUSTED_PAGE_ARTIFACT");
  });
});

describe("OpenAIProvider: safe error normalization", () => {
  it("normalizes AuthenticationError without leaking raw body/headers", async () => {
    const actual = await vi.importActual<OpenAIModule>("openai");
    const error = new actual.default.AuthenticationError(
      401,
      { error: { message: "Incorrect API key provided", type: "invalid_request_error" } },
      "Incorrect API key provided",
      new Headers({ "x-request-id": "req_123" }),
    );
    responsesCreateMock.mockRejectedValue(error);

    const provider = new OpenAIProvider();
    await expect(collect(provider.streamTurn(baseRequest(), AUTH, new AbortController().signal))).rejects.toMatchObject({
      code: "AUTHENTICATION",
      retryable: false,
    });
  });

  it("marks RATE_LIMIT as retryable", async () => {
    const actual = await vi.importActual<OpenAIModule>("openai");
    const error = new actual.default.RateLimitError(429, { error: { message: "Rate limited" } }, "Rate limited", new Headers());
    responsesCreateMock.mockRejectedValue(error);

    const provider = new OpenAIProvider();
    await expect(collect(provider.streamTurn(baseRequest(), AUTH, new AbortController().signal))).rejects.toMatchObject({
      code: "RATE_LIMIT",
      retryable: true,
    });
  });

  it("normalizes a network failure to NETWORK", async () => {
    const actual = await vi.importActual<OpenAIModule>("openai");
    const error = new actual.default.APIConnectionError({ message: "fetch failed" });
    responsesCreateMock.mockRejectedValue(error);

    const provider = new OpenAIProvider();
    await expect(collect(provider.streamTurn(baseRequest(), AUTH, new AbortController().signal))).rejects.toMatchObject({
      code: "NETWORK",
      retryable: true,
    });
  });

  it("only exposes code/message/retryable/status/requestId on the normalized error", async () => {
    const actual = await vi.importActual<OpenAIModule>("openai");
    const error = new actual.default.AuthenticationError(
      401,
      { error: { message: "nope", type: "invalid_request_error" }, secret_header_value: "leak-me" },
      "nope",
      new Headers({ "x-request-id": "req_456" }),
    );
    responsesCreateMock.mockRejectedValue(error);

    const provider = new OpenAIProvider();
    try {
      await collect(provider.streamTurn(baseRequest(), AUTH, new AbortController().signal));
      throw new Error("expected streamTurn to reject");
    } catch (caught) {
      expect(caught).toBeInstanceOf(ProviderStreamError);
      const normalized = caught as InstanceType<typeof ProviderStreamError>;
      expect(JSON.stringify(normalized)).not.toContain("leak-me");
      expect(normalized.requestId).toBe("req_456");
      expect(normalized.status).toBe(401);
    }
  });
});

describe("OpenAIProvider.validateAuth", () => {
  it("resolves when models.list succeeds", async () => {
    modelsListMock.mockResolvedValue({ data: [] });
    const provider = new OpenAIProvider();
    await expect(provider.validateAuth(AUTH, new AbortController().signal)).resolves.toBeUndefined();
  });

  it("normalizes a failed key validation", async () => {
    const actual = await vi.importActual<OpenAIModule>("openai");
    modelsListMock.mockRejectedValue(new actual.default.AuthenticationError(401, {}, "Invalid API key", new Headers()));
    const provider = new OpenAIProvider();
    await expect(provider.validateAuth(AUTH, new AbortController().signal)).rejects.toMatchObject({ code: "AUTHENTICATION" });
  });
});
