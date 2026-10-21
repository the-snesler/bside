/**
 * OpenAI boundary implemented with Pi AI. The adapter preserves the existing
 * privacy/request invariants and replaces Pi's detailed provider failures with
 * a small safe envelope before they can cross the background protocol.
 */

import {
  createAssistantMessageEventStream,
  getSupportedThinkingLevels,
  hasApi,
  normalizeContext,
  type Api,
  type AssistantMessage,
  type Model,
} from "@earendil-works/pi-ai";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import {
  REASONING_EFFORTS,
  type ProviderAdapter,
  type ProviderAuth,
  type ProviderDefinition,
  type ProviderTurnRequest,
  type ModelDefinition,
  type ModelListing,
} from "@/lib/domain/provider";
import { DEFAULT_CONTEXT_WINDOW, DEFAULT_REASONING_EFFORT, OPENAI_MODELS, OPENAI_PROVIDER } from "@/lib/providers/openai-models";

const REQUEST_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_TOKENS = 8192;
const API_BASE_URL = "https://api.openai.com/v1";
const SAFE_ERROR_PREFIX = "bside-provider-error:";

export type ProviderErrorCode =
  | "AUTHENTICATION"
  | "RATE_LIMIT"
  | "INVALID_REQUEST"
  | "TIMEOUT"
  | "NETWORK"
  | "PROVIDER_UNAVAILABLE"
  | "PROVIDER_RESPONSE_FAILED";

interface SafeProviderError {
  code: ProviderErrorCode;
  message: string;
  status?: number;
  requestId?: string;
}

/** Already-normalized provider failure; never contains a raw response body. */
export class ProviderStreamError extends Error {
  readonly code: ProviderErrorCode;
  readonly retryable: boolean;
  readonly status?: number;
  readonly requestId?: string;

  constructor(message: string, code: ProviderErrorCode, status?: number, requestId?: string) {
    super(message);
    this.name = "ProviderStreamError";
    this.code = code;
    this.retryable = code === "RATE_LIMIT" || code === "TIMEOUT" || code === "NETWORK" || code === "PROVIDER_UNAVAILABLE";
    this.status = status;
    this.requestId = requestId;
  }
}

const provider = openaiProvider();

/**
 * Adds each model's reasoning efforts from Pi's model metadata, which tracks
 * what the API accepts (some models reject `none`). A model Pi does not list
 * is sent without reasoning controls, so it offers only `none`.
 */
export function describeModels(listings: readonly ModelListing[]): ModelDefinition[] {
  const known = provider.getModels();
  return listings.map(({ id, name }) => {
    const model = known.find((candidate) => candidate.id === id);
    const levels: readonly string[] = model ? getSupportedThinkingLevels(model) : ["off"];
    const supported = REASONING_EFFORTS.filter((effort) => levels.includes(effort === "none" ? "off" : effort));
    const reasoningEfforts = supported.length ? supported : ["none" as const];
    return { id, name, reasoningEfforts,
      defaultReasoningEffort: reasoningEfforts.includes(DEFAULT_REASONING_EFFORT) ? DEFAULT_REASONING_EFFORT : reasoningEfforts[0]! };
  });
}

/** The API-key provider definition. */
export const OPENAI_API_KEY_PROVIDER: ProviderDefinition = { ...OPENAI_PROVIDER, models: describeModels(OPENAI_MODELS) };

export class OpenAIProvider implements ProviderAdapter {
  readonly definition: ProviderDefinition = OPENAI_API_KEY_PROVIDER;
  #resolveAuth: (auth: ProviderAuth, signal: AbortSignal) => Promise<ProviderAuth>;
  #findModel: (id: string) => ModelListing | undefined;

  constructor(
    resolveAuth = async (auth: ProviderAuth, _signal: AbortSignal) => auth,
    findModel: (id: string) => ModelListing | undefined = () => undefined,
  ) {
    this.#resolveAuth = resolveAuth;
    this.#findModel = findModel;
  }

  getModel(modelId: string): Model<Api> | null {
    const known = provider.getModels().find((candidate) => candidate.id === modelId);
    if (known) return known;
    const accountModel = this.#findModel(modelId);
    // A server-listed model can be newer than Pi's bundled catalog. Omit
    // reasoning controls and pricing assumptions for unknown models; the
    // context window only decides when history is summarized.
    return accountModel ? {
      id: modelId, name: accountModel.name, api: "openai-responses", provider: "openai", baseUrl: API_BASE_URL,
      reasoning: false, input: ["text", "image"], contextWindow: DEFAULT_CONTEXT_WINDOW, maxTokens: MAX_OUTPUT_TOKENS,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, compat: { supportsStrictMode: true },
    } : null;
  }

  async validateAuth(auth: ProviderAuth, signal: AbortSignal): Promise<void> {
    auth = await this.#resolveAuth(auth, signal);
    let response: Response;
    try {
      response = await fetch(`${API_BASE_URL}/models`, {
        headers: { Authorization: `Bearer ${auth.secret}` },
        signal,
      });
    } catch (error) {
      if (signal.aborted) throw new ProviderStreamError("The request was cancelled.", "TIMEOUT");
      throw new ProviderStreamError(error instanceof TypeError ? "Could not reach OpenAI." : "OpenAI authentication failed.", "NETWORK");
    }
    if (!response.ok) throw fromStatus(response.status, response.headers.get("x-request-id") ?? undefined, auth.method);
  }

  streamTurn(request: ProviderTurnRequest, auth: ProviderAuth, signal: AbortSignal) {
    const output = createAssistantMessageEventStream();
    const responseMeta: { status?: number; requestId?: string } = {};
    let networkFailed = false;

    const safeFetch: typeof fetch = async (input, init) => {
      try {
        const response = await fetch(input, init);
        responseMeta.status = response.status;
        responseMeta.requestId = response.headers.get("x-request-id") ?? undefined;
        return response;
      } catch (error) {
        networkFailed = !signal.aborted;
        throw error;
      }
    };

    if (!hasApi(request.model, "openai-responses")) {
      throw new ProviderStreamError("The selected model is not compatible with OpenAI Responses.", "INVALID_REQUEST");
    }
    const model = request.model;
    void (async () => {
      try {
        auth = await this.#resolveAuth(auth, signal);
        const source = provider.streamSimple(auth.method === "chatgpt" ? {
          ...model, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        } : model, normalizeContext(request.context), {
          apiKey: auth.secret, signal, fetch: safeFetch,
          reasoning: request.reasoningEffort === "none" ? undefined : request.reasoningEffort,
          // "short" keeps OpenAI's default in-memory prompt cache (no 24h
          // retention) and routes it by conversation via prompt_cache_key.
          maxTokens: MAX_OUTPUT_TOKENS, timeoutMs: REQUEST_TIMEOUT_MS, maxRetries: 0, cacheRetention: "short", sessionId: request.sessionId, transport: "sse",
          onPayload: (payload) => enforceRequestPolicy(payload, auth.method),
        });
        for await (const event of source) {
          if (event.type !== "error") {
            output.push(event);
            continue;
          }
          const normalized = signal.aborted
            ? new ProviderStreamError("The request was cancelled.", "TIMEOUT")
            : networkFailed
              ? new ProviderStreamError("Could not reach OpenAI.", "NETWORK")
              : auth.method === "chatgpt" && /subscription_sharing_usage_(limit_exceeded|unavailable)/.test(event.error.errorMessage ?? "")
                ? new ProviderStreamError("ChatGPT plan usage is unavailable or its limit has been reached. Review usage in ChatGPT settings.", "RATE_LIMIT", responseMeta.status, responseMeta.requestId)
                : responseMeta.status !== undefined
                  ? fromStatus(responseMeta.status, responseMeta.requestId, auth.method)
                  : new ProviderStreamError("OpenAI did not complete the response.", "PROVIDER_RESPONSE_FAILED");
          output.push({ ...event, error: withSafeError(event.error, normalized) });
        }
      } catch (error) {
        const normalized = signal.aborted ? new ProviderStreamError("The request was cancelled.", "TIMEOUT") :
          error instanceof ProviderStreamError ? error : new ProviderStreamError("OpenAI did not complete the response.", "PROVIDER_RESPONSE_FAILED");
        output.push({ type: "error", reason: "error", error: {
          role: "assistant", content: [], api: request.model.api, provider: request.model.provider, model: request.model.id,
          timestamp: Date.now(), stopReason: "error", errorMessage: encodeProviderErrorMessage(normalized),
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        } });
      }
      output.end();
    })();

    return output;
  }
}

/** Decode only envelopes produced here; arbitrary provider text stays generic. */
export function decodeProviderError(message: string | undefined): ProviderStreamError {
  if (message?.startsWith(SAFE_ERROR_PREFIX)) {
    try {
      const value = JSON.parse(message.slice(SAFE_ERROR_PREFIX.length)) as SafeProviderError;
      if (typeof value.message === "string" && isProviderErrorCode(value.code)) {
        return new ProviderStreamError(value.message, value.code, value.status, value.requestId);
      }
    } catch {
      // Fall through to the generic, non-sensitive message.
    }
  }
  return new ProviderStreamError("The provider did not complete the response.", "PROVIDER_RESPONSE_FAILED");
}

export function encodeProviderErrorMessage(error: ProviderStreamError): string {
  const safe: SafeProviderError = { code: error.code, message: error.message };
  if (error.status !== undefined) safe.status = error.status;
  if (error.requestId !== undefined) safe.requestId = error.requestId;
  return `${SAFE_ERROR_PREFIX}${JSON.stringify(safe)}`;
}

function enforceRequestPolicy(payload: unknown, method: ProviderAuth["method"]): unknown {
  if (!isRecord(payload)) return payload;
  const result = { ...payload, store: false, parallel_tool_calls: false };
  if (method === "api-key") return result;
  const subscription: Record<string, unknown> = result;
  for (const field of ["background", "conversation", "max_output_tokens", "max_tool_calls", "metadata", "moderation", "multi_agent",
    "prompt", "prompt_cache_retention", "prompt_cache_options", "safety_identifier", "temperature", "top_logprobs", "top_p", "truncation", "user", "previous_response_id"])
    delete subscription[field];
  const input = Array.isArray(subscription.input) ? subscription.input.map((item) =>
    isRecord(item) && item.role === "system" ? { ...item, role: "developer" } : item) : [];
  // additional_tools keeps our tool names and Pi's tool-call replay intact.
  if (Array.isArray(subscription.tools) && subscription.tools.length) input.unshift({ type: "additional_tools", role: "developer", tools: subscription.tools });
  delete subscription.tools;
  return { ...subscription, input, stream: true };
}

function withSafeError(message: AssistantMessage, error: ProviderStreamError): AssistantMessage {
  return { ...message, errorMessage: encodeProviderErrorMessage(error) };
}

function fromStatus(status: number, requestId?: string, method: ProviderAuth["method"] = "api-key"): ProviderStreamError {
  if (status === 401 || status === 403) return new ProviderStreamError(method === "chatgpt" ? "The ChatGPT connection was rejected. Reconnect in settings." : "The OpenAI API key was rejected.", "AUTHENTICATION", status, requestId);
  if (status === 429) return new ProviderStreamError("OpenAI is rate limiting requests. Try again shortly.", "RATE_LIMIT", status, requestId);
  if (status === 408) return new ProviderStreamError("The OpenAI request timed out.", "TIMEOUT", status, requestId);
  if (status >= 400 && status < 500) return new ProviderStreamError("OpenAI rejected the request.", "INVALID_REQUEST", status, requestId);
  if (status >= 500) return new ProviderStreamError("OpenAI is temporarily unavailable.", "PROVIDER_UNAVAILABLE", status, requestId);
  return new ProviderStreamError("OpenAI did not complete the response.", "PROVIDER_RESPONSE_FAILED", status, requestId);
}

function isProviderErrorCode(value: unknown): value is ProviderErrorCode {
  return typeof value === "string" && [
    "AUTHENTICATION",
    "RATE_LIMIT",
    "INVALID_REQUEST",
    "TIMEOUT",
    "NETWORK",
    "PROVIDER_UNAVAILABLE",
    "PROVIDER_RESPONSE_FAILED",
  ].includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
