import { afterEach, describe, expect, it, vi } from "vitest";
import type { Context } from "@earendil-works/pi-ai";
import { decodeProviderError, OpenAIProvider, ProviderStreamError } from "@/lib/providers/openai";
import type { ProviderAuth } from "@/lib/domain/provider";

const AUTH: ProviderAuth = { providerId: "openai", method: "chatgpt", secret: "test-subscription-token" };
const MODEL = { id: "account-only-model", name: "Account model", reasoningEfforts: ["none"] as const, defaultReasoningEffort: "none" as const };

function sse(events: Record<string, unknown>[]) {
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
    headers: { "Content-Type": "text/event-stream", "x-request-id": "req_test" },
  });
}

afterEach(() => vi.unstubAllGlobals());

describe("ChatGPT requests through the real Pi Responses transport", () => {
  it("streams a tool call, replays its result statelessly, and renews auth for each turn", async () => {
    const bodies: Record<string, unknown>[] = [];
    const headers: Headers[] = [];
    const toolCall = { type: "function_call", id: "fc_test", call_id: "call_test", name: "browser_program", arguments: '{"source":"return 1;"}' };
    const text = { type: "message", role: "assistant", id: "msg_test", content: [{ type: "output_text", text: "Done.", annotations: [] }], status: "completed" };
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (input, init) => {
      const request = new Request(input, init);
      expect(request.url).toBe("https://api.openai.com/v1/responses");
      bodies.push(await request.json() as Record<string, unknown>);
      headers.push(request.headers);
      const item = bodies.length === 1 ? toolCall : text;
      return sse([
        { type: "response.output_item.added", output_index: 0, item },
        { type: "response.output_item.done", output_index: 0, item },
        { type: "response.completed", response: { id: `resp_${bodies.length}`, status: "completed", output: [item], usage: { input_tokens: 20, output_tokens: 5, total_tokens: 25 } } },
      ]);
    }));
    let turn = 0;
    const resolve = vi.fn(async (auth: ProviderAuth) => ({ ...auth, secret: `test-token-${++turn}` }));
    const provider = new OpenAIProvider(resolve, (id) => id === MODEL.id ? MODEL : undefined);
    const model = provider.getModel(MODEL.id)!;
    const context: Context = {
      systemPrompt: "Browser policy.", messages: [{ role: "user", content: "Read the page.", timestamp: 1 }],
      tools: [{ name: "browser_program", description: "A bounded browser program.", parameters: { type: "object", properties: { source: { type: "string" } }, required: ["source"] } }],
    };
    const first = await provider.streamTurn({ model, reasoningEffort: "none", context }, AUTH, new AbortController().signal).result();
    expect(first.stopReason).toBe("toolUse");
    expect(first.content).toContainEqual({ type: "toolCall", id: "call_test|fc_test", name: "browser_program", arguments: { source: "return 1;" } });
    context.messages.push(first, { role: "toolResult", toolCallId: "call_test|fc_test", toolName: "browser_program", content: [{ type: "text", text: "1" }], isError: false, timestamp: 2 });
    const second = await provider.streamTurn({ model, reasoningEffort: "none", context }, AUTH, new AbortController().signal).result();
    expect(second.stopReason).toBe("stop");
    expect(second.content).toMatchObject([{ type: "text", text: "Done." }]);
    expect(second.usage.cost.total).toBe(0);
    expect(resolve).toHaveBeenCalledTimes(2);
    expect(headers.map((value) => value.get("Authorization"))).toEqual(["Bearer test-token-1", "Bearer test-token-2"]);
    for (const body of bodies) {
      expect(body).toMatchObject({ model: MODEL.id, store: false, stream: true, parallel_tool_calls: false });
      for (const field of ["tools", "max_output_tokens", "prompt_cache_options", "prompt_cache_retention", "previous_response_id"])
        expect(body).not.toHaveProperty(field);
      expect(body.input).toContainEqual(expect.objectContaining({ role: "developer", content: "Browser policy." }));
      expect(body.input).toContainEqual(expect.objectContaining({ type: "additional_tools", role: "developer", tools: [expect.objectContaining({ name: "browser_program" })] }));
      expect((body.input as Record<string, unknown>[])[0]?.type).toBe("additional_tools");
    }
    expect(bodies[1]!.input).toContainEqual(expect.objectContaining(toolCall));
    expect(bodies[1]!.input).toContainEqual({ type: "function_call_output", call_id: "call_test", output: "1" });
  });

  it.each(["subscription_sharing_usage_limit_exceeded", "subscription_sharing_usage_unavailable"])("handles %s after HTTP 200 without exposing the response body", async (code) => {
    vi.stubGlobal("fetch", vi.fn(async () => sse([{ type: "response.failed", response: { status: "failed", error: { code, message: "private account detail" } } }])));
    const provider = new OpenAIProvider(undefined, () => MODEL);
    const failed = await provider.streamTurn({ model: provider.getModel(MODEL.id)!, reasoningEffort: "none", context: { messages: [], tools: [] } }, AUTH, new AbortController().signal).result();
    expect(decodeProviderError(failed.errorMessage)).toMatchObject({ code: "RATE_LIMIT", status: 200, requestId: "req_test" });
    expect(failed.errorMessage).not.toContain("private account detail");
  });

  it("fails an interrupted stream without a terminal event", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => sse([{ type: "response.created", response: { id: "resp_test" } }])));
    const provider = new OpenAIProvider(undefined, () => MODEL);
    const failed = await provider.streamTurn({ model: provider.getModel(MODEL.id)!, reasoningEffort: "none", context: { messages: [], tools: [] } }, AUTH, new AbortController().signal).result();
    expect(failed.stopReason).toBe("error");
    expect(decodeProviderError(failed.errorMessage).code).toBe("PROVIDER_RESPONSE_FAILED");
  });

  it("reports a refresh failure without starting inference", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const provider = new OpenAIProvider(async () => { throw new ProviderStreamError("Reconnect ChatGPT in settings.", "AUTHENTICATION"); }, () => MODEL);
    const failed = await provider.streamTurn({ model: provider.getModel(MODEL.id)!, reasoningEffort: "none", context: { messages: [], tools: [] } }, AUTH, new AbortController().signal).result();
    expect(decodeProviderError(failed.errorMessage).code).toBe("AUTHENTICATION");
    expect(fetcher).not.toHaveBeenCalled();
  });
});
