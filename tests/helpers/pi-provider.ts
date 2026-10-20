import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Model,
} from "@earendil-works/pi-ai";
import type { JsonValue, ToolCall } from "@/lib/domain/tools";
import { encodeProviderErrorMessage, ProviderStreamError } from "@/lib/providers/openai";

export const TEST_MODEL: Model<"openai-responses"> = {
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

export type ScriptedProviderEvent =
  | { type: "text.delta"; delta: string }
  | { type: "tool.call"; call: { id: string; name: ToolCall["name"]; arguments: Record<string, JsonValue> } }
  | { type: "turn.completed"; replayState: JsonValue | null; usage?: Partial<Omit<AssistantMessage["usage"], "cost">> };

export function toPiStream(
  events: Iterable<ScriptedProviderEvent> | AsyncIterable<ScriptedProviderEvent>,
  signal: AbortSignal,
) {
  const stream = createAssistantMessageEventStream();
  const message: AssistantMessage = {
    role: "assistant",
    content: [],
    api: TEST_MODEL.api,
    provider: TEST_MODEL.provider,
    model: TEST_MODEL.id,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "pending",
    timestamp: Date.now(),
  };

  void (async () => {
    try {
      stream.push({ type: "start", partial: { ...message } });
      for await (const event of events) {
        if (signal.aborted) throw new DOMException("Aborted", "AbortError");
        if (event.type === "text.delta") {
          const last = message.content.at(-1);
          if (last?.type === "text") last.text += event.delta;
          else message.content.push({ type: "text", text: event.delta });
          stream.push({ type: "text_delta", contentIndex: message.content.length - 1, delta: event.delta, partial: { ...message } });
        } else if (event.type === "tool.call") {
          const toolCall = { type: "toolCall" as const, ...event.call };
          message.content.push(toolCall);
          stream.push({ type: "toolcall_end", contentIndex: message.content.length - 1, toolCall, partial: { ...message } });
        } else {
          message.usage = { ...message.usage, ...event.usage };
          message.stopReason = message.content.some((part) => part.type === "toolCall") ? "toolUse" : "stop";
          stream.push({ type: "done", reason: message.stopReason, message: { ...message } });
          stream.end();
          return;
        }
      }
      message.stopReason = "stop";
      stream.push({ type: "done", reason: "stop", message: { ...message } });
      stream.end();
    } catch (error) {
      message.stopReason = signal.aborted ? "aborted" : "error";
      message.errorMessage = error instanceof ProviderStreamError
        ? encodeProviderErrorMessage(error)
        : signal.aborted ? "Request aborted" : "Provider failed";
      stream.push({ type: "error", reason: message.stopReason, error: { ...message } });
      stream.end();
    }
  })();
  return stream;
}
